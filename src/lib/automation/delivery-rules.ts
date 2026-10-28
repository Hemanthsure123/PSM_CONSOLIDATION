import { domainCsv, type UnscoredRow } from "@/lib/domain-csv";
import { normalisePhone } from "@/lib/pool/parse";
import type { AutomationPlan } from "@/lib/automation/types";
import type { DomainCandidateRow, DomainReportResult } from "@/lib/types";

/**
 * Delivery — the pure part (tested in scripts/automation-selftest.ts): the rows a job writes to
 * its psm_final_shortlisted_<date> tab and how they merge with what the tab already holds.
 *
 *  - Every candidate the job read, best first: the shortlist (top N), then those who cleared every
 *    requirement but ranked lower, then those left out (with the reason), then any that couldn't
 *    be screened. "Status" says which.
 *  - The candidate's mobile number is the key column (user id, then the sheet row, when a row has
 *    none). With the Job ID it identifies a row, which is how a retried or second delivery
 *    (shortlist first, the rest later) never writes a candidate twice.
 *  - Columns are matched by name. The key columns sit at the front; a tab that predates one gets
 *    it inserted in place (old rows simply have it blank); other new columns go at the end.
 */

/** The columns that lead every row, in order. */
export const KEY_COLUMNS = ["Job ID", "Delivered At", "Mobile Number", "Rank", "Name", "Status", "Not Shortlisted Because", "Review Flags", "Source Tab"] as const;
/** Google Sheets holds at most 50,000 characters per cell. */
const CELL_MAX = 45_000;

export const cellText = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return s.length > CELL_MAX ? `${s.slice(0, CELL_MAX - 1)}…` : s;
};

/** A delivered row's identity within its job: the mobile number, else the user id, else tab + name. */
export const rowKey = (r: Record<string, string>): string => {
  const mobile = normalisePhone(r["Mobile Number"] ?? "") ?? String(r["Mobile Number"] ?? "").trim();
  return mobile ? `m:${mobile}` : r["User ID"]?.trim() ? `u:${r["User ID"].trim().toLowerCase()}` : `r:${r["Source Tab"] ?? ""}|${r["Name"] ?? ""}`;
};

export interface DeliveryContext {
  jobId: string;
  deliveredAt: string;
  sourceTabOf: (candidateId: string) => string;
  flagsOf: (candidateId: string) => string[];
  /** Rows that weren't scored: not resumes, couldn't be screened. */
  unscored: (UnscoredRow & { sourceTab: string })[];
}

/** Every candidate as named cells, in rank order. `only: "shortlist"` = the shortlist alone. */
export function deliveryTable(
  result: DomainReportResult,
  plan: AutomationPlan,
  ctx: DeliveryContext,
  only: "shortlist" | "all" = "all",
): { headers: string[]; rows: Record<string, string>[] } {
  const csv = domainCsv({
    kind: "complete",
    result,
    domain: plan.domainName,
    mandatoryActive: plan.mandatory.trim().length > 0,
    dsaOn: plan.dsa.use,
    githubOn: plan.github !== "off",
    trackDomainCommit: false,
    presentation: false,
    poolChecked: true,
    unscored: only === "all" ? ctx.unscored : [],
  });
  const ids: { id: string; tab: string }[] = [
    ...result.candidates.map((c) => ({ id: c.id, tab: ctx.sourceTabOf(c.id) })),
    ...(only === "all" ? ctx.unscored.map((u) => ({ id: u.row.id, tab: u.sourceTab })) : []),
  ];
  let rows = csv.rows.map((r, i): Record<string, string> => {
    const { id, tab } = ids[i] ?? { id: "", tab: "" };
    const phone = r.Phone ?? "";
    return {
      ...r,
      "Job ID": ctx.jobId,
      "Delivered At": ctx.deliveredAt,
      "Mobile Number": normalisePhone(phone) ?? phone,
      "Review Flags": ctx.flagsOf(id).map((f) => `• ${f}`).join("\n"),
      "Source Tab": tab,
    };
  });
  if (only === "shortlist") rows = rows.filter((r) => r.Status === "Shortlisted");
  // Phone is the Mobile Number column now; the rest keep the CSV's order behind the key columns.
  const rest = csv.headers.filter((h) => h !== "Phone" && !(KEY_COLUMNS as readonly string[]).includes(h));
  return { headers: [...KEY_COLUMNS, ...rest], rows };
}

/**
 * How the tab's header changes for this job: key columns missing from an older tab are inserted
 * at their place (`inserts`, 0-based, applied in order), any other new column is appended.
 */
export function planHeaders(existing: string[], wanted: string[]): { headers: string[]; inserts: number[]; appended: string[] } {
  const headers = existing.map((h) => String(h ?? "").trim());
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  const inserts: number[] = [];
  if (headers.length) {
    let at = 0;
    for (const key of KEY_COLUMNS) {
      if (!wanted.includes(key)) continue;
      const i = headers.indexOf(key);
      if (i >= 0) {
        at = i + 1;
        continue;
      }
      headers.splice(at, 0, key);
      inserts.push(at);
      at += 1;
    }
  }
  const known = new Set(headers.filter(Boolean));
  const appended = wanted.filter((h) => !known.has(h));
  return { headers: [...headers, ...appended], inserts, appended };
}

/** Rows as arrays in the tab's header order. */
export function sheetRows(headers: string[], rows: Record<string, string>[]): string[][] {
  return rows.map((r) => headers.map((h) => cellText(h ? r[h] : "")));
}

/** The keys of the rows this job already wrote to the tab (from the tab's rows, read by header). */
export function deliveredKeys(headers: string[], values: string[][], jobId: string): Set<string> {
  const col = (name: string) => headers.indexOf(name);
  const job = col("Job ID");
  const keys = new Set<string>();
  if (job < 0) return keys;
  for (const v of values) {
    if (String(v[job] ?? "").trim() !== jobId) continue;
    const cell = (name: string) => (col(name) >= 0 ? String(v[col(name)] ?? "") : "");
    keys.add(rowKey({ "Mobile Number": cell("Mobile Number"), "User ID": cell("User ID"), "Source Tab": cell("Source Tab"), Name: cell("Name") }));
  }
  return keys;
}

/** "AK" for 37 (1-based). */
export function columnLetter(n: number): string {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** An unscored checkpoint as the CSV's row shape. */
export function unscoredRow(row: DomainCandidateRow, state: "invalid" | "error" | "pending", error: string, internal: UnscoredRow["internal"], sourceTab: string): UnscoredRow & { sourceTab: string } {
  return {
    row,
    status: state === "invalid" ? "Not a resume" : state === "pending" ? "Not evaluated" : "Could not be evaluated",
    reason: error || (state === "pending" ? "The run stopped before this candidate" : "Couldn't be screened"),
    internal,
    sourceTab,
  };
}
