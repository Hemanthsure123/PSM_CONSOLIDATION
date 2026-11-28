import type { AssignmentFact, Comparison, ImportedReview, ReviewRead } from "@/lib/feedback-docs/model";

/**
 * Candidate feedback documents (PSM 1.13.0) — turning a reviewed analysis into per-application rows
 * (app.application_reviews) and per-job comparisons (app.job_comparisons). Pure: the files are read
 * and the rows written by scripts/review-import.ts; tested in scripts/feedback-selftest.ts.
 *
 * The November Academy review (its stakeholder sheets: "November Academy review", "Academy Resume
 * Rejection Analysis – Nov 2026", the Track 1 / Track 2 trackers, "November Academy outcomes", the
 * assignment review) was built from:
 *  - reasons.json: one record per application read (resume read by Claude, read twice where it
 *    mattered), with the group (not sent by us / sent by us / rejected by company / passed company
 *    screening), the main reason, all reasons, the read itself and our screening sheet's verdict;
 *  - candidate_counts.json "apps": per job and phone, applied / sent / the company's decision, after
 *    every rule and correction the review agreed with the owner;
 *  - the assignment review's "Nov assignments – Candidates" table.
 */

export interface ReviewReasonRecord {
  job: string;
  phone: string;
  group?: string;
  track?: string;
  pool?: string;
  resume?: string;
  primary?: string;
  reasons?: string[];
  details?: string[];
  rd?: (ReviewRead & { evidence?: string }) | null;
  checked?: string;
  recorded?: { verdict?: string | null } | null;
}

export interface ReviewAppRecord {
  job: string;
  phone: string;
  applied?: boolean;
  status?: string;
  decision?: string;
}

export interface ReviewAssignmentRow {
  phone: string;
  jobId: string;
  fact: AssignmentFact;
}

export type ImportRow = Omit<ImportedReview, "source"> & { phone: string };

/** The phone's last 10 digits; "" when it has fewer (how the review keyed people). */
export const tenDigits = (p: unknown) => {
  const d = String(p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
};
const keyOf = (phone: string, job: string) => `${phone}|${job.trim().toLowerCase()}`;
const COMPANY_GROUP = /rejected by company|passed company screening/i;
const SENT_GROUP = /sent by us|rejected by company|passed company screening/i;

/** The read, with only the fields the documents use (no free text but the evidence line). */
function cleanRead(rd: ReviewReasonRecord["rd"]): ReviewRead {
  if (!rd) return { readable: false };
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 80)).slice(0, 12) : []);
  return {
    readable: rd.readable !== false,
    must_have_met: list(rd.must_have_met),
    must_have_missing: list(rd.must_have_missing),
    relevant_project: typeof rd.relevant_project === "boolean" ? rd.relevant_project : undefined,
    course_projects_only: typeof rd.course_projects_only === "boolean" ? rd.course_projects_only : undefined,
    relevant_internship: typeof rd.relevant_internship === "boolean" ? rd.relevant_internship : undefined,
    coding_profile_or_github: typeof rd.coding_profile_or_github === "boolean" ? rd.coding_profile_or_github : undefined,
    resume_quality_issues: list(rd.resume_quality_issues),
    fit_1to5: typeof rd.fit_1to5 === "number" ? rd.fit_1to5 : undefined,
  };
}

/**
 * One row per (phone, job): applied / sent / decision from the review's counted applications, the
 * main reason and read from its records (the company-screening record when there is one, as that is
 * the step the profile stopped at), the assignment result when the job had one.
 */
export function importRows(reasons: ReviewReasonRecord[], apps: ReviewAppRecord[], assignments: ReviewAssignmentRow[] = []): ImportRow[] {
  const recs = new Map<string, ReviewReasonRecord[]>();
  for (const r of reasons) {
    const phone = tenDigits(r.phone);
    if (!phone || !r.job) continue;
    const k = keyOf(phone, r.job);
    recs.set(k, [...(recs.get(k) ?? []), r]);
  }
  const appOf = new Map<string, ReviewAppRecord>();
  for (const a of apps) {
    const phone = tenDigits(a.phone);
    if (phone && a.job) appOf.set(keyOf(phone, a.job), a);
  }
  const asgOf = new Map(assignments.map((a) => [keyOf(a.phone, a.jobId), a.fact]));
  const out: ImportRow[] = [];
  for (const k of new Set([...recs.keys(), ...appOf.keys()])) {
    const [phone, job] = k.split("|");
    const rs = recs.get(k) ?? [];
    const app = appOf.get(k);
    const main = rs.find((r) => COMPANY_GROUP.test(r.group ?? "")) ?? rs[0];
    const groups = rs.map((r) => r.group ?? "");
    const decision: ImportRow["decision"] =
      app?.decision === "selected" || app?.decision === "rejected"
        ? app.decision
        : groups.some((g) => /passed company screening/i.test(g))
          ? "selected"
          : groups.some((g) => /rejected by company/i.test(g))
            ? "rejected"
            : null;
    out.push({
      phone,
      jobId: job,
      applied: app ? app.applied !== false : rs.length > 0,
      sent: app ? app.status === "sent" : groups.some((g) => SENT_GROUP.test(g)),
      decision,
      primaryReason: String(main?.primary ?? "").slice(0, 200),
      reasons: (main?.reasons ?? []).map((x) => String(x).slice(0, 200)).slice(0, 20),
      details: (main?.details ?? []).map((x) => String(x).slice(0, 200)).slice(0, 20),
      read: cleanRead(main?.rd ?? null),
      screening: String(main?.recorded?.verdict ?? "").slice(0, 80),
      resumeUrl: main?.resume && /^https?:\/\//i.test(main.resume) && main.resume.length <= 1000 ? main.resume : null,
      checked: String(main?.checked ?? "").slice(0, 160),
      assignment: asgOf.get(k) ?? null,
    });
  }
  return out;
}

/**
 * Per job: how the candidates the company took forward compared (every pool, counted once per
 * person). Counts only — nobody's name or phone leaves this function.
 */
export function comparisonsOf(reasons: ReviewReasonRecord[]): Map<string, Comparison> {
  const seen = new Map<string, Map<string, ReviewReasonRecord>>();
  for (const r of reasons) {
    if (!/passed company screening/i.test(r.group ?? "") || !r.rd || r.rd.readable === false) continue;
    const job = r.job.trim().toLowerCase();
    const phone = tenDigits(r.phone);
    if (!job || !phone) continue;
    const m = seen.get(job) ?? new Map();
    m.set(phone, r);
    seen.set(job, m);
  }
  const out = new Map<string, Comparison>();
  for (const [job, people] of seen) {
    const rs = [...people.values()].map((r) => r.rd!);
    const fits = rs.map((r) => r.fit_1to5).filter((x): x is number => typeof x === "number");
    out.set(job, {
      selected: rs.length,
      withInternship: rs.filter((r) => r.relevant_internship === true).length,
      withLinks: rs.filter((r) => r.coding_profile_or_github === true && !(r.resume_quality_issues ?? []).some((q) => /no links/i.test(q))).length,
      withProject: rs.filter((r) => r.relevant_project === true).length,
      allMustHaves: rs.filter((r) => Array.isArray(r.must_have_missing) && r.must_have_missing.length === 0).length,
      fitAvg: fits.length ? Math.round((fits.reduce((a, b) => a + b, 0) / fits.length) * 100) / 100 : null,
    });
  }
  return out;
}

const cell = (v: unknown) => (v && typeof v === "object" ? String((v as { x?: unknown }).x ?? "") : String(v ?? "")).trim();

/** The assignment review's candidate table (header row with "Phone", "Result (bucket)", "Main gap", "Job ID"). */
export function assignmentRows(rows: unknown[][]): ReviewAssignmentRow[] {
  const h = rows.findIndex((r) => r.map(cell).includes("Phone") && r.map(cell).includes("Job ID"));
  if (h < 0) return [];
  const head = rows[h].map(cell);
  const at = (name: string) => head.indexOf(name);
  const [pi, ri, gi, ji] = [at("Phone"), at("Result (bucket)"), at("Main gap"), at("Job ID")];
  if (pi < 0 || ri < 0 || ji < 0) return [];
  const out: ReviewAssignmentRow[] = [];
  for (const r of rows.slice(h + 1)) {
    const phone = tenDigits(cell(r[pi]));
    const jobId = cell(r[ji]).toLowerCase();
    const result = cell(r[ri]);
    if (!phone || !jobId || !result) continue;
    out.push({ phone, jobId, fact: { result: result.slice(0, 60), gap: gi >= 0 ? cell(r[gi]).slice(0, 160) : "" } });
  }
  return out;
}
