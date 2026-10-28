import { domainCsv } from "@/lib/domain-csv";
import type { AutomationPlan } from "@/lib/automation/types";
import type { DomainReportResult } from "@/lib/types";

/**
 * Delivery — the pure part (tested in scripts/automation-selftest.ts): which columns and rows
 * a job writes to its psm_final_shortlisted_<date> tab, and how they merge with a tab that
 * already holds earlier jobs. Columns are matched by name, so jobs that measured different
 * things (DSA on / off …) share one tab without shifting each other's data; a column a job
 * doesn't fill stays blank. Every row carries its Job ID, which is how a retried delivery
 * knows it already happened.
 */

export const JOB_COLUMNS = ["Job ID", "Delivered At", "Source Tab", "Review Flags"] as const;
/** Google Sheets holds at most 50,000 characters per cell. */
const CELL_MAX = 45_000;

export const cellText = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return s.length > CELL_MAX ? `${s.slice(0, CELL_MAX - 1)}…` : s;
};

/** The shortlist as named cells: the job columns, then Domain shortlisting's shortlist CSV columns. */
export function deliveryTable(
  result: DomainReportResult,
  plan: AutomationPlan,
  ctx: { jobId: string; deliveredAt: string; sourceTabOf: (candidateId: string) => string; flagsOf: (candidateId: string) => string[] },
): { headers: string[]; rows: Record<string, string>[] } {
  const csv = domainCsv({
    kind: "shortlisted",
    result,
    domain: plan.domainName,
    mandatoryActive: plan.mandatory.trim().length > 0,
    dsaOn: plan.dsa.use,
    githubOn: plan.github !== "off",
    trackDomainCommit: false,
    presentation: false,
    poolChecked: true,
    unscored: [],
  });
  const shortlisted = result.candidates.filter((c) => c.shortlisted);
  const rows = csv.rows.map((r, i) => {
    const id = shortlisted[i]?.id ?? "";
    return {
      "Job ID": ctx.jobId,
      "Delivered At": ctx.deliveredAt,
      "Source Tab": ctx.sourceTabOf(id),
      "Review Flags": ctx.flagsOf(id).map((f) => `• ${f}`).join("\n"),
      ...r,
    };
  });
  return { headers: [...JOB_COLUMNS, ...csv.headers], rows };
}

/** The tab's header row after this job: the existing headers in place, new ones added at the end. */
export function mergeHeaders(existing: string[], wanted: string[]): { headers: string[]; added: string[] } {
  const have = existing.map((h) => String(h ?? "").trim());
  const known = new Set(have.filter(Boolean));
  const added = wanted.filter((h) => !known.has(h));
  // Trailing blank header cells are dropped; blanks in between keep their place.
  while (have.length && !have[have.length - 1]) have.pop();
  return { headers: [...have, ...added], added };
}

/** Rows as arrays in the tab's header order. */
export function sheetRows(headers: string[], rows: Record<string, string>[]): string[][] {
  return rows.map((r) => headers.map((h) => cellText(h ? r[h] : "")));
}

/** Has this job already written to the tab? (the "Job ID" column's values) */
export function deliveredBefore(jobIdColumn: string[], jobId: string): number {
  return jobIdColumn.filter((v) => String(v ?? "").trim() === jobId).length;
}

/** "AK" for 37 (1-based). */
export function columnLetter(n: number): string {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}
