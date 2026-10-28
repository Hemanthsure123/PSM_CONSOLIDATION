import "server-only";
import { buildDomainReport } from "@/actions/domain";
import { getSheetsWriter } from "@/lib/sheets";
import { env } from "@/lib/env";
import { withSheetsRetry } from "@/lib/automation/control-sheet";
import { deliveredKeys, deliveryTable, planHeaders, rowKey, sheetRows, unscoredRow } from "@/lib/automation/delivery-rules";
import { JobError } from "@/lib/automation/errors";
import { destinationTabName } from "@/lib/automation/instructions";
import { loadCandidates, logEvent } from "@/lib/automation/store";
import { jobVerdict, reviewFlags } from "@/lib/automation/validation";
import type { UnscoredRow } from "@/lib/domain-csv";
import type { RunContext } from "@/lib/automation/context";
import type { JobResult } from "@/lib/automation/types";
import type { DomainCandidate, DomainReportResult } from "@/lib/types";

/**
 * Validation + Delivery agents.
 *
 * Validation ranks every screened candidate with Domain shortlisting's own report builder
 * (internal assessments first, then the evidence-grounded rank score; the strict gates), then
 * runs deterministic checks on the shortlist (validation.ts) and decides COMPLETED or
 * AWAITING_REVIEW. Missing assessments never count as passed: a person not in the eligible
 * pool is external, an unread DSA profile scores nothing.
 *
 * Delivery writes to psm_final_shortlisted_<date> in the candidates' spreadsheet: first the
 * shortlist (as soon as it is final), then every other candidate below it (the complete
 * screening). The tab is created if missing, existing rows are never touched, columns are
 * matched by name, and a candidate already written for this job (by mobile number) is never
 * written again — so a retried or repeated delivery is a no-op, not a duplicate.
 */

const q = (tab: string) => `'${tab.replace(/'/g, "''")}'`;
const APPEND_CHUNK = 250;

/** One delivery at a time per destination tab (header changes + appends must not interleave). */
const tabLocks = new Map<string, Promise<unknown>>();
async function withTabLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prev = tabLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(work);
  tabLocks.set(key, next);
  try {
    return await next;
  } finally {
    if (tabLocks.get(key) === next) tabLocks.delete(key);
  }
}

const deliveredAtText = (at = new Date()) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(at) + " IST";

export interface Validated {
  report: DomainReportResult;
  flags: Map<string, string[]>;
  sourceTabOf: Map<string, string>;
  unscored: (UnscoredRow & { sourceTab: string })[];
  status: "completed" | "awaiting_review";
  reasons: string[];
  stats: { read: number; scored: number; notResumes: number; unscored: number; duplicates: number };
}

/** Rank the screened candidates and check the shortlist. `final` = the whole sheet is screened. */
export async function validate(ctx: RunContext, final = true): Promise<Validated> {
  const all = await loadCandidates(ctx.job.id);
  const screened = all.filter((c) => c.state === "screened" && c.candidate);
  const candidates: DomainCandidate[] = screened.map((c) => ({ ...c.candidate!, internal: c.internal }));
  const built = await buildDomainReport(candidates, {
    domain: ctx.plan.domainName,
    topN: ctx.plan.topN ?? 10,
    limitToTopN: ctx.plan.topN !== null,
    runName: `${ctx.job.companyName || ctx.plan.sourceTitle} — automation`,
    resumesScanned: all.filter((c) => c.state !== "duplicate").length,
    useDsa: ctx.plan.dsa.use,
    useGithub: ctx.plan.github !== "off",
    showDomainCommit: false,
    showStats: false,
    generateReport: false,
    dsaGates: ctx.plan.dsa.gates,
    minCommits: 0,
    mandatoryActive: ctx.plan.mandatory.trim().length > 0,
    requireExperience: false,
    checkPresentation: false,
    minPresentation: 0,
    poolChecked: true,
  });
  if (!built.ok) throw new JobError(`Ranking failed: ${built.error}`, true);
  const report = built.data;
  const flags = new Map<string, string[]>();
  for (const c of report.candidates.filter((x) => x.shortlisted)) flags.set(c.id, reviewFlags(c, ctx.plan));
  const sourceTabOf = new Map(screened.map((c) => [c.candidate!.id, c.sourceTab]));
  const live = all.filter((c) => c.state !== "duplicate");
  const unscored = live
    .filter((c) => c.state === "invalid" || c.state === "error" || c.state === "pending")
    .map((c) => unscoredRow(c.row, c.state as "invalid" | "error" | "pending", c.error ?? "", c.internal, c.sourceTab));
  const stats = {
    read: live.length,
    scored: screened.length,
    notResumes: live.filter((c) => c.state === "invalid").length,
    unscored: live.filter((c) => c.state === "error" || c.state === "pending").length,
    duplicates: all.length - live.length,
  };
  const shortlisted = report.candidates.filter((c) => c.shortlisted).length;
  const verdict = jobVerdict({
    shortlisted,
    requested: ctx.plan.topN,
    unscored: final ? stats.unscored : 0,
    flaggedShortlisted: [...flags.values()].filter((f) => f.length).length,
    briefSource: ctx.plan.briefSource,
  });
  await logEvent(
    ctx.job.id,
    "validating",
    "info",
    `${final ? "" : "Shortlist final before the full screening: "}${shortlisted} shortlisted of ${stats.scored} scored; ${verdict.status}${verdict.reasons.length ? `: ${verdict.reasons.join("; ")}` : ""}.`,
  );
  return { report, flags, sourceTabOf, unscored, status: verdict.status, reasons: verdict.reasons, stats };
}

/** Write the shortlist (`only: "shortlist"`) or every candidate (`"all"`) to the job's tab. */
export async function deliver(ctx: RunContext, v: Validated, only: "shortlist" | "all" = "all"): Promise<JobResult> {
  const runDate = ctx.job.runDate ?? new Date().toISOString().slice(0, 10);
  const tab = destinationTabName(runDate);
  const spreadsheetId = ctx.plan.sourceSpreadsheetId;
  const { headers: wanted, rows } = deliveryTable(
    v.report,
    ctx.plan,
    {
      jobId: ctx.job.id,
      deliveredAt: deliveredAtText(),
      sourceTabOf: (id) => v.sourceTabOf.get(id) ?? "",
      flagsOf: (id) => v.flags.get(id) ?? [],
      unscored: v.unscored,
    },
    only,
  );
  const sheets = getSheetsWriter();

  const written = await withTabLock(`${spreadsheetId}|${tab}`, async () => {
    try {
      // 1. The tab (created if missing; another job creating it at the same moment is fine).
      const fields = "sheets.properties(sheetId,title,gridProperties(columnCount))";
      const meta = await withSheetsRetry(() => sheets.spreadsheets.get({ spreadsheetId, fields }));
      let sheet = (meta.data.sheets ?? []).find((s) => s.properties?.title === tab)?.properties;
      if (!sheet) {
        try {
          const added = await withSheetsRetry(() =>
            sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } } }] } }),
          );
          sheet = added.data.replies?.[0]?.addSheet?.properties ?? undefined;
          await logEvent(ctx.job.id, "delivering", "info", `Created the tab "${tab}".`);
        } catch (err) {
          if (!/already exists/i.test(String((err as Error).message))) throw err;
          const again = await withSheetsRetry(() => sheets.spreadsheets.get({ spreadsheetId, fields }));
          sheet = (again.data.sheets ?? []).find((s) => s.properties?.title === tab)?.properties;
        }
      }
      if (!sheet || sheet.sheetId === undefined || sheet.sheetId === null) throw new JobError(`Couldn't create the tab "${tab}".`, true);
      const sheetId = sheet.sheetId;

      // 2. What the tab holds: its header, and the rows this job already wrote (by mobile number).
      const existing = await withSheetsRetry(() => sheets.spreadsheets.values.get({ spreadsheetId, range: q(tab) }));
      const values = ((existing.data.values ?? []) as unknown[][]).map((r) => r.map((c) => String(c ?? "")));
      const plan = planHeaders(values[0] ?? [], wanted);
      const already = deliveredKeys(values[0] ?? [], values.slice(1), ctx.job.id);
      const toWrite = rows.filter((r) => !already.has(rowKey(r)));

      // 3. Header: key columns missing from an older tab are inserted in place, other new ones appended.
      const requests: object[] = plan.inserts.map((index) => ({ insertDimension: { range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 }, inheritFromBefore: false } }));
      const have = (sheet.gridProperties?.columnCount ?? 0) + plan.inserts.length;
      if (have < plan.headers.length) requests.push({ appendDimension: { sheetId, dimension: "COLUMNS", length: plan.headers.length - have } });
      if (requests.length) await withSheetsRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }));
      if (plan.inserts.length || plan.appended.length || !values.length) {
        await withSheetsRetry(() =>
          sheets.spreadsheets.values.update({ spreadsheetId, range: `${q(tab)}!A1`, valueInputOption: "RAW", requestBody: { values: [plan.headers] } }),
        );
      }

      // 4. The new rows, appended below whatever is there, in chunks (RAW: nothing in a cell runs as a formula).
      for (let i = 0; i < toWrite.length; i += APPEND_CHUNK) {
        const chunk = toWrite.slice(i, i + APPEND_CHUNK);
        await withSheetsRetry(() =>
          sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${q(tab)}!A1`,
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: sheetRows(plan.headers, chunk) },
          }),
        );
      }
      return { written: toWrite.length, skipped: rows.length - toWrite.length, gid: sheetId };
    } catch (err) {
      if (err instanceof JobError) throw err;
      const status = Number((err as { code?: number }).code ?? (err as { response?: { status?: number } }).response?.status);
      if (status === 403) {
        throw new JobError(`Can't write to "${ctx.plan.sourceTitle}" — give ${env.gcp.clientEmail} edit access, then type start again (screening is kept).`, false);
      }
      throw new JobError(`Writing the shortlist failed: ${err instanceof Error ? err.message : "error"}`, true);
    }
  });

  await logEvent(
    ctx.job.id,
    "delivering",
    "info",
    `${only === "shortlist" ? "Shortlist" : "Complete screening"}: wrote ${written.written} rows to "${tab}"${written.skipped ? ` (${written.skipped} already there)` : ""}.`,
  );
  return {
    destinationTab: tab,
    destinationUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${written.gid}`,
    sourceTitle: ctx.plan.sourceTitle,
    shortlisted: v.report.candidates.filter((c) => c.shortlisted).length,
    requested: ctx.plan.topN,
    read: v.stats.read,
    scored: v.stats.scored,
    notResumes: v.stats.notResumes,
    unscored: v.stats.unscored,
    duplicates: v.stats.duplicates,
    flagged: [...v.flags.values()].filter((f) => f.length).length,
    reviewReasons: v.reasons,
    rowsWritten: written.written + written.skipped,
    complete: only === "all",
  };
}
