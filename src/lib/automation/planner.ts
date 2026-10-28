import "server-only";
import { autofillDomain } from "@/lib/domain-autofill";
import { detectDomainColumns } from "@/lib/domain-columns";
import { dsaGatesActive } from "@/lib/dsa-scoring";
import { env } from "@/lib/env";
import { checkGithubAccess } from "@/lib/github-analysis";
import { extractSpreadsheetId, getSheets } from "@/lib/sheets";
import { withSheetsRetry } from "@/lib/automation/control-sheet";
import { parseInstructions, profilesRequiredOf, resolveTabs } from "@/lib/automation/instructions";
import { JobError } from "@/lib/automation/errors";
import type { AutomationPlan, PlanTab } from "@/lib/automation/types";

/**
 * Planner agent — turns the instructions cell into a checked plan:
 *  1. read the cell (deterministic: tabs, focus, GitHub scope, DSA, top N);
 *  2. open the candidates' spreadsheet (the row's "Internal Sheets" link, or a link in the cell)
 *     and match the tab names; find each tab's header row and its name / resume / phone / user-id
 *     columns;
 *  3. draft the scoring brief and the mandatory skills from the focus text with the same JD
 *     autofill Domain shortlisting uses (grounded: a must-have the text doesn't state is dropped);
 *  4. settle the defaults (GitHub domain-fit, DSA off, top N from "No. of Profiles Required").
 * Anything the user must fix ends the job as FAILED with a sentence saying what to change.
 */

const q = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

/** Within the first 6 rows: the first row whose headers include a resume column. */
function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const cols = detectDomainColumns(rows[i].map((c) => String(c ?? "")));
    if (cols.resumeColumn) return i;
  }
  return -1;
}

export async function planJob(input: { instructions: string; internalSheetUrl: string; profilesRequired: string }): Promise<AutomationPlan> {
  const parsed = parseInstructions(input.instructions);
  const notes: string[] = [];

  // 2. The candidates' spreadsheet.
  const sourceUrl = parsed.sheetUrl ?? input.internalSheetUrl;
  const sourceId = extractSpreadsheetId(sourceUrl.match(/https?:\/\/\S+/)?.[0] ?? sourceUrl);
  if (!sourceId) {
    throw new JobError("No candidates' sheet: put its link in the row's Internal Sheets column, or add a line \"Sheet: <link>\".", false);
  }
  const sheets = getSheets();
  let title = "";
  let available: string[] = [];
  try {
    const meta = await withSheetsRetry(() => sheets.spreadsheets.get({ spreadsheetId: sourceId, fields: "properties.title,sheets.properties.title" }));
    title = meta.data.properties?.title ?? "";
    available = (meta.data.sheets ?? []).map((s) => s.properties?.title ?? "").filter(Boolean);
  } catch (err) {
    const status = Number((err as { code?: number }).code ?? (err as { response?: { status?: number } }).response?.status);
    if (status === 403 || status === 404) {
      throw new JobError(`The candidates' sheet can't be opened — share it with ${env.gcp.clientEmail} as Editor, then type start again.`, false);
    }
    throw new JobError(`Couldn't open the candidates' sheet (${err instanceof Error ? err.message : "error"}).`, true);
  }

  const { tabs: tabNames, unknown, focus } = resolveTabs(parsed, available);
  if (unknown.length) {
    const list = unknown.map((u) => `"${u.name}"${u.suggestions.length ? ` (did you mean ${u.suggestions.map((s) => `"${s}"`).join(" or ")}?)` : ""}`).join(", ");
    throw new JobError(`Tab ${list} not found in "${title}".`, false);
  }
  if (!tabNames.length) {
    throw new JobError(`Name the tabs to screen, e.g. "Subsheets: ${available.slice(0, 2).join(", ")}".`, false);
  }
  if (!focus.trim()) throw new JobError('Say what to screen for, e.g. "Focus: Flutter developers who shipped apps".', false);

  const tabs: PlanTab[] = [];
  for (const name of tabNames) {
    const res = await withSheetsRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: sourceId, range: `${q(name)}!1:6` }));
    const rows = ((res.data.values ?? []) as unknown[][]).map((r) => r.map((c) => String(c ?? "")));
    const h = findHeaderRow(rows);
    if (h < 0) throw new JobError(`Tab "${name}" has no resume column in its first rows (a header with "resume" or "CV").`, false);
    const columns = detectDomainColumns(rows[h]);
    if (!columns.phoneColumn && !columns.idColumn) notes.push(`"${name}" has no phone or user-id column, so its internal assessments can't be matched`);
    tabs.push({ name, headerRow: h + 1, columns, rows: 0 });
  }

  // 3. The criteria, drafted from the focus text and checked (the model may be rate-limited: retried, then the text as is).
  let domainName = "";
  let brief = "";
  let mandatory = "";
  let briefSource: AutomationPlan["briefSource"] = "focus";
  const text = focus.length >= 60 ? focus : `Shortlisting request — the candidates to find: ${focus}`;
  for (let attempt = 1; attempt <= 3 && briefSource === "focus"; attempt++) {
    const draft = await autofillDomain({ text, file: null, domainName: "" }).catch((err) => ({ ok: false as const, error: String(err), status: 500 }));
    if (draft.ok) {
      domainName = draft.data.domainName.trim();
      brief = draft.data.definesIt.trim() ? `${domainName} — ${draft.data.definesIt.trim()}` : domainName;
      mandatory = draft.data.mandatory.trim();
      briefSource = "llm";
      if (draft.data.dropped.length) notes.push(`must-haves not stated in the focus text were left out: ${draft.data.dropped.slice(0, 3).join("; ")}`);
    } else if (draft.status < 500 && draft.status !== 429) {
      break;
    } else if (attempt < 3) {
      await new Promise((r) => setTimeout(r, attempt * 20_000));
    }
  }
  if (briefSource === "focus") {
    domainName = focus.split(/\n|[.;]/)[0].trim().slice(0, 60);
    brief = focus.slice(0, 1_500);
    notes.push("the model couldn't draft the criteria, so the focus text is used as is (no mandatory skills)");
  }

  // 4. Defaults.
  const github = parsed.github;
  if (!parsed.githubExplicit) notes.push("GitHub: domain-fit candidates (default)");
  if (github !== "off") {
    const access = await checkGithubAccess();
    if (!access.ok) throw new JobError(`GitHub inspection can't run: ${access.message} Or write "GitHub: no".`, false);
  }
  const dsaUse = parsed.dsa.use || dsaGatesActive(parsed.dsa.gates);
  const fromRow = profilesRequiredOf(input.profilesRequired);
  const topN = parsed.topN ?? fromRow;
  const topNSource: AutomationPlan["topNSource"] = parsed.topN ? "instructions" : fromRow ? "profiles-required" : "none";
  if (topNSource === "profiles-required") notes.push(`top ${topN} from No. of Profiles Required`);
  if (topNSource === "none") notes.push("no count given: everyone who clears every requirement is shortlisted");

  return {
    version: 1,
    sourceSpreadsheetId: sourceId,
    sourceTitle: title,
    tabs,
    focus,
    domainName: domainName || "Shortlist",
    brief,
    mandatory,
    briefSource,
    github,
    review: parsed.review ?? github !== "off",
    dsa: { use: dsaUse, gates: parsed.dsa.gates },
    topN,
    topNSource,
    notes,
  };
}
