import "server-only";
import { buildDomainReport } from "@/actions/domain";
import { getSheetsWriter } from "@/lib/sheets";
import { env } from "@/lib/env";
import { withSheetsRetry } from "@/lib/automation/control-sheet";
import { columnLetter, deliveredBefore, deliveryTable, mergeHeaders, sheetRows } from "@/lib/automation/delivery-rules";
import { JobError } from "@/lib/automation/errors";
import { destinationTabName } from "@/lib/automation/instructions";
import { loadCandidates, logEvent } from "@/lib/automation/store";
import { jobVerdict, reviewFlags } from "@/lib/automation/validation";
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
 * Delivery appends the shortlist to psm_final_shortlisted_<date> in the candidates'
 * spreadsheet: the tab is created if missing, existing rows are never touched, columns are
 * matched by name, and the Job ID column makes a retried delivery a no-op instead of a duplicate.
 */

const q = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

/** One delivery at a time per destination tab (header merge + append must not interleave). */
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
  status: "completed" | "awaiting_review";
  reasons: string[];
  stats: { read: number; scored: number; notResumes: number; unscored: number; duplicates: number };
}

export async function validate(ctx: RunContext): Promise<Validated> {
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
    unscored: stats.unscored,
    flaggedShortlisted: [...flags.values()].filter((f) => f.length).length,
    briefSource: ctx.plan.briefSource,
  });
  await logEvent(ctx.job.id, "validating", "info", `${shortlisted} shortlisted of ${stats.scored} scored; ${verdict.status}${verdict.reasons.length ? `: ${verdict.reasons.join("; ")}` : ""}.`);
  return { report, flags, sourceTabOf, status: verdict.status, reasons: verdict.reasons, stats };
}

export async function deliver(ctx: RunContext, v: Validated): Promise<JobResult> {
  const runDate = ctx.job.runDate ?? new Date().toISOString().slice(0, 10);
  const tab = destinationTabName(runDate);
  const spreadsheetId = ctx.plan.sourceSpreadsheetId;
  const { headers: wanted, rows } = deliveryTable(v.report, ctx.plan, {
    jobId: ctx.job.id,
    deliveredAt: deliveredAtText(),
    sourceTabOf: (id) => v.sourceTabOf.get(id) ?? "",
    flagsOf: (id) => v.flags.get(id) ?? [],
  });
  const sheets = getSheetsWriter();

  const written = await withTabLock(`${spreadsheetId}|${tab}`, async () => {
    try {
      // 1. The tab (created if missing; another job creating it at the same moment is fine).
      const meta = await withSheetsRetry(() => sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title,gridProperties(columnCount))" }));
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
          const again = await withSheetsRetry(() => sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title,gridProperties(columnCount))" }));
          sheet = (again.data.sheets ?? []).find((s) => s.properties?.title === tab)?.properties;
        }
      }
      if (!sheet || sheet.sheetId === undefined || sheet.sheetId === null) throw new JobError(`Couldn't create the tab "${tab}".`, true);

      // 2. Already delivered by an earlier attempt of this job? (the response can be lost after a write)
      const head = await withSheetsRetry(() => sheets.spreadsheets.values.get({ spreadsheetId, range: `${q(tab)}!1:1` }));
      const existing = ((head.data.values ?? [])[0] ?? []).map((c) => String(c ?? ""));
      const jobCol = existing.findIndex((h) => h.trim() === "Job ID");
      if (jobCol >= 0) {
        const col = await withSheetsRetry(() =>
          sheets.spreadsheets.values.get({ spreadsheetId, range: `${q(tab)}!${columnLetter(jobCol + 1)}2:${columnLetter(jobCol + 1)}` }),
        );
        const n = deliveredBefore(((col.data.values ?? []) as unknown[][]).map((r) => String(r[0] ?? "")), ctx.job.id);
        if (n > 0) {
          await logEvent(ctx.job.id, "delivering", "info", `Already delivered (${n} rows in "${tab}") — not written again.`);
          return { rowsWritten: n, gid: sheet.sheetId, already: true };
        }
      }

      // 3. Headers: existing ones stay in place, missing ones are added at the end.
      const { headers, added } = mergeHeaders(existing, wanted);
      const needCols = headers.length;
      if ((sheet.gridProperties?.columnCount ?? 0) < needCols) {
        await withSheetsRetry(() =>
          sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: [{ appendDimension: { sheetId: sheet!.sheetId!, dimension: "COLUMNS", length: needCols - (sheet!.gridProperties?.columnCount ?? 0) } }] },
          }),
        );
      }
      if (added.length || !existing.length) {
        await withSheetsRetry(() =>
          sheets.spreadsheets.values.update({ spreadsheetId, range: `${q(tab)}!A1`, valueInputOption: "RAW", requestBody: { values: [headers] } }),
        );
      }

      // 4. The rows, appended below whatever is there (RAW: nothing in a cell is run as a formula).
      if (rows.length) {
        await withSheetsRetry(() =>
          sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${q(tab)}!A1`,
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: sheetRows(headers, rows) },
          }),
        );
      }
      return { rowsWritten: rows.length, gid: sheet.sheetId, already: false };
    } catch (err) {
      if (err instanceof JobError) throw err;
      const status = Number((err as { code?: number }).code ?? (err as { response?: { status?: number } }).response?.status);
      if (status === 403) {
        throw new JobError(`Can't write to "${ctx.plan.sourceTitle}" — give ${env.gcp.clientEmail} edit access, then type start again (screening is kept).`, false);
      }
      throw new JobError(`Writing the shortlist failed: ${err instanceof Error ? err.message : "error"}`, true);
    }
  });

  if (!written.already) await logEvent(ctx.job.id, "delivering", "info", `Wrote ${written.rowsWritten} rows to "${tab}" in "${ctx.plan.sourceTitle}".`);
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
    rowsWritten: written.rowsWritten,
  };
}
