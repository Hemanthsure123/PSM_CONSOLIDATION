import { QA_SECTIONS, type QaSection, type SectionQuotes } from "@/lib/qa-types";
import { formatMonths, parseYm, unionMonths } from "@/lib/zaggle/dates";
import {
  COMPANY_TYPE_LABEL,
  ZG_GOOD_TO_HAVE,
  ZG_SKILLS,
  type ZgCandidateInput,
  type ZgEvaluation,
  type ZgJob,
  type ZgRules,
} from "@/lib/zaggle/types";

/**
 * Zaggle SDE 1 screening — deterministic scoring, statuses and ranking. The model
 * only reports evidence; every number here is computed, so a rule change re-ranks
 * the whole pool instantly.
 *
 * Mandatory points (100): backend language 15 · DSA 15 · APIs 15 · SQL 15 ·
 * 1 year relevant full-time experience 20 · product company 10 · no IT services /
 * consulting 10.
 * Good-to-have bonus: +2 per item shown in a project or job, +1 if only in the
 * skills list.
 * Final = 100 + bonus when EVERY mandatory requirement is met; otherwise the
 * points met + bonus, capped at 99 — no one with a gap reaches 100%.
 */

export const POINTS = {
  backend_language: 15,
  dsa: 15,
  apis: 15,
  sql: 15,
  experience: 20,
  product: 10,
  noServices: 10,
} as const;

export type MandatoryId = keyof typeof POINTS;

export const MANDATORY_LABEL: Record<MandatoryId, string> = {
  backend_language: "Backend language",
  dsa: "DSA",
  apis: "APIs",
  sql: "SQL",
  experience: "1 year experience",
  product: "Product company",
  noServices: "No IT services / consulting",
};

/** How a job counts toward the months. */
export interface JobVerdict {
  job: ZgJob;
  counted: boolean;
  /** Why it doesn't count ("" when it does). */
  why: string;
  months: number;
  /** An employer that rules the candidate out (IT services / consulting / staffing). */
  disqualifies: boolean;
}

export interface ZgScore {
  points: number;
  bonus: number;
  finalScore: number;
  /** Every mandatory requirement met. */
  complete: boolean;
  met: Record<MandatoryId, boolean>;
  missing: string[];
  /** Relevant full-time months, overlaps counted once. */
  months: number;
  jobs: JobVerdict[];
  /** At least one counted job at a product company. */
  productConfirmed: boolean;
  /** Counted jobs exist but none is clearly a product company (all "unclear"). */
  productUnclear: boolean;
  servicesFirms: string[];
  /** The month count rests on approximate dates (a year only, or a duration only, or the model's reading). */
  monthsApproximate: boolean;
  goodToHave: string[];
}

const RELEVANT_FOCUS = new Set(["backend", "fullstack", "software"]);
const SERVICES = new Set(["it-services", "consulting", "staffing"]);

export function sectionsOf(q: SectionQuotes | undefined): QaSection[] {
  return q ? QA_SECTIONS.filter((s) => Boolean(q[s])) : [];
}

/** Which jobs count toward the 12 months, and why the others don't. */
export function judgeJobs(jobs: ZgJob[], rules: ZgRules): JobVerdict[] {
  return jobs.map((job) => {
    const isJob = job.employmentType === "full-time" || job.employmentType === "contract";
    const isIntern = job.employmentType === "internship" || job.employmentType === "apprenticeship";
    const services = SERVICES.has(job.companyType);
    // Any job at an IT services / consulting / staffing firm is that background (the JD rules it out);
    // an internship there only when the rule says so.
    const disqualifies = services && (!isIntern || rules.servicesInternshipDisqualifies);
    const start = parseYm(job.start);
    const end = parseYm(job.end);
    const months = start !== null && end !== null && end >= start ? end - start + 1 : (job.durationOnlyMonths ?? 0);
    const focusOk = RELEVANT_FOCUS.has(job.roleFocus) || (rules.countFrontendMobile && (job.roleFocus === "frontend" || job.roleFocus === "mobile"));
    let why = "";
    if (isIntern && !rules.countInternships) why = "internship — only full-time jobs count";
    else if (job.employmentType === "part-time" || job.employmentType === "freelance") why = `${job.employmentType} — only full-time jobs count`;
    else if (!focusOk) why = `${job.roleFocus === "non-software" ? "not a software role" : `${job.roleFocus} role`} — not backend / software engineering`;
    else if (!months) why = "no dates on the resume";
    return { job, counted: !why && (isJob || (isIntern && rules.countInternships)), why, months, disqualifies };
  });
}

export function scoreZg(r: ZgEvaluation, rules: ZgRules): ZgScore {
  const jobs = judgeJobs(r.jobs ?? [], rules);
  const counted = jobs.filter((j) => j.counted);
  // Calendar months (overlaps once) + jobs written only as a duration (can't be placed, added as is).
  const ranges = counted
    .map((j) => ({ start: parseYm(j.job.start), end: parseYm(j.job.end) }))
    .filter((x): x is { start: number; end: number } => x.start !== null && x.end !== null);
  const months = unionMonths(ranges) + counted.filter((j) => parseYm(j.job.start) === null).reduce((s, j) => s + (j.job.durationOnlyMonths ?? 0), 0);
  const monthsApproximate = counted.some((j) => j.job.datesApproximate || !j.job.datesVerified || j.job.durationOnlyMonths !== null);

  const productConfirmed = counted.some((j) => j.job.companyType === "product");
  const productUnclear = !productConfirmed && counted.some((j) => j.job.companyType === "unknown");
  const servicesFirms = Array.from(new Set(jobs.filter((j) => j.disqualifies).map((j) => j.job.company)));

  const has = (k: (typeof ZG_SKILLS)[number]["key"]) => sectionsOf(r.skills?.[k]).length > 0;
  const met: Record<MandatoryId, boolean> = {
    backend_language: has("backend_language"),
    dsa: has("dsa"),
    apis: has("apis"),
    sql: has("sql"),
    experience: months >= rules.minMonths && months <= rules.maxMonths,
    product: productConfirmed,
    noServices: servicesFirms.length === 0,
  };

  const missing: string[] = [];
  for (const d of ZG_SKILLS) if (!met[d.key]) missing.push(`No ${MANDATORY_LABEL[d.key]} in Skills / Projects / Experience`);
  if (!met.experience) {
    missing.push(
      months === 0
        ? "No relevant full-time experience"
        : months < rules.minMonths
          ? `${formatMonths(months)} relevant full-time experience — below ${rules.minMonths} months`
          : `${formatMonths(months)} relevant full-time experience — above ${rules.maxMonths} months`,
    );
  }
  if (!met.product) missing.push(productUnclear ? "Product-company background not clear from the resume" : "No experience at a software product company");
  if (!met.noServices) missing.push(`IT services / consulting background: ${servicesFirms.join(", ")}`);

  let bonus = 0;
  const found: string[] = [];
  for (const d of ZG_GOOD_TO_HAVE) {
    const secs = sectionsOf(r.goodToHave?.[d.key]);
    if (!secs.length) continue;
    found.push(d.label);
    bonus += secs.some((s) => s !== "skills") ? 2 : 1;
  }

  const points = (Object.keys(POINTS) as MandatoryId[]).reduce((s, k) => s + (met[k] ? POINTS[k] : 0), 0);
  const complete = (Object.keys(met) as MandatoryId[]).every((k) => met[k]);
  return {
    points,
    bonus,
    finalScore: complete ? 100 + bonus : Math.min(points + bonus, 99),
    complete,
    met,
    missing,
    months,
    jobs,
    productConfirmed,
    productUnclear,
    servicesFirms,
    monthsApproximate,
    goodToHave: found,
  };
}

// ── Statuses and ranking ─────────────────────────────────────────────────────

export type ZgStatus =
  | "Shortlisted"
  | "Qualified – Outside Top N"
  | "Review – Check Manually"
  | "Not Shortlisted"
  | "No Relevant Full-time Experience"
  | "Invalid – Not a Resume"
  | "Error"
  | "Pending";

export const ZG_STATUS_ORDER: ZgStatus[] = [
  "Shortlisted",
  "Qualified – Outside Top N",
  "Review – Check Manually",
  "Not Shortlisted",
  "No Relevant Full-time Experience",
  "Invalid – Not a Resume",
  "Error",
  "Pending",
];

export interface ZgRanked {
  id: string;
  candidate: ZgCandidateInput;
  result: ZgEvaluation | undefined;
  score: ZgScore | null;
  status: ZgStatus;
  reasons: string[];
  rank: number;
  shortlistRank: number;
}

/**
 * Would clear every rule if one uncertain reading went their way — a recruiter
 * should look: the product company is unclear (not ruled out), or the months
 * rest on approximate dates and the gap is the experience rule alone.
 */
function needsReview(s: ZgScore, rules: ZgRules): string[] {
  const out: string[] = [];
  const others = (except: (keyof ZgScore["met"])[]) =>
    (Object.keys(s.met) as (keyof ZgScore["met"])[]).filter((k) => !except.includes(k)).every((k) => s.met[k]);
  if (s.complete && s.monthsApproximate) out.push("Months rest on approximate dates (a year only, a duration only, or dates the program couldn't read) — check the dates");
  if (!s.met.product && s.productUnclear && others(["product"])) out.push("Every other requirement is met — check whether the employer is a product company");
  if (!s.met.experience && s.monthsApproximate && others(["experience"]) && Math.abs(s.months - (s.months < rules.minMonths ? rules.minMonths : rules.maxMonths)) <= 2) {
    out.push(`${formatMonths(s.months)} from approximate dates — within 2 months of the ${rules.minMonths}–${rules.maxMonths} month window`);
  }
  return out;
}

export function rankZg(candidates: ZgCandidateInput[], results: Record<string, ZgEvaluation>, rules: ZgRules): ZgRanked[] {
  const rows: ZgRanked[] = candidates.map((c) => {
    const result = results[c.id];
    const row = (status: ZgStatus, reasons: string[], score: ZgScore | null = null): ZgRanked => ({
      id: c.id,
      candidate: c,
      result,
      score,
      status,
      reasons,
      rank: 0,
      shortlistRank: 0,
    });
    if (!result) return row("Pending", []);
    if (result.status === "error") return row("Error", [result.error]);
    if (result.status === "invalid") return row("Invalid – Not a Resume", [result.error]);
    const s = scoreZg(result, rules);
    if (!result.evidenceVerified) return row("Review – Check Manually", ["Evidence could not be checked against the resume text — re-screen"], s);
    const review = needsReview(s, rules);
    if (s.complete) return row(review.length ? "Review – Check Manually" : "Shortlisted", review, s);
    if (review.length) return row("Review – Check Manually", [...review, ...s.missing], s);
    if (s.months === 0 && !s.jobs.some((j) => j.counted)) return row("No Relevant Full-time Experience", s.missing, s);
    return row("Not Shortlisted", s.missing, s);
  });

  const target = (rules.minMonths + rules.maxMonths) / 2;
  const byScore = (a: ZgRanked, b: ZgRanked) => {
    const sa = a.score;
    const sb = b.score;
    if (sa && sb) {
      if (sb.finalScore !== sa.finalScore) return sb.finalScore - sa.finalScore;
      if (sb.points !== sa.points) return sb.points - sa.points;
      // Closer to the middle of the experience window first ("exactly 1 year" is the ask).
      const da = Math.abs(sa.months - target);
      const db = Math.abs(sb.months - target);
      if (da !== db) return da - db;
    } else if (sa || sb) return sa ? -1 : 1;
    return a.id.localeCompare(b.id);
  };

  if (rules.topN > 0) {
    const passed = rows.filter((r) => r.status === "Shortlisted").sort(byScore);
    passed.slice(rules.topN).forEach((r, i) => {
      r.status = "Qualified – Outside Top N";
      r.reasons = [`Meets every requirement — ranked #${rules.topN + i + 1}, outside the top ${rules.topN}`];
    });
  }
  rows.sort((a, b) => {
    const ta = ZG_STATUS_ORDER.indexOf(a.status);
    const tb = ZG_STATUS_ORDER.indexOf(b.status);
    return ta !== tb ? ta - tb : byScore(a, b);
  });
  let rank = 0;
  let shortlistRank = 0;
  for (const r of rows) {
    if (r.status === "Error" || r.status === "Pending" || r.status === "Invalid – Not a Resume") continue;
    r.rank = ++rank;
    if (r.status === "Shortlisted") r.shortlistRank = ++shortlistRank;
  }
  return rows;
}

export function summarizeZg(rows: ZgRanked[]) {
  const count = (s: ZgStatus) => rows.filter((r) => r.status === s).length;
  return {
    evaluated: rows.filter((r) => r.status !== "Pending").length,
    shortlisted: count("Shortlisted"),
    outsideTopN: count("Qualified – Outside Top N"),
    review: count("Review – Check Manually"),
    notShortlisted: count("Not Shortlisted"),
    noExperience: count("No Relevant Full-time Experience"),
    invalid: count("Invalid – Not a Resume"),
    errors: count("Error"),
    pending: count("Pending"),
  };
}

/** "TCS (IT services)" etc. for display. */
export const companyTag = (j: ZgJob) => `${j.company} (${COMPANY_TYPE_LABEL[j.companyType]})`;
