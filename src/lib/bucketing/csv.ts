import { toCsv } from "@/lib/utils";
import { BUCKET_LABEL, BUCKETS, DOMAIN_LABEL, REASON_TEXT, TIER_LABEL, TRACK_LABEL, VERDICT_LABEL, isBucket, type Bucket } from "@/lib/bucketing/config";
import { compareForRanking } from "@/lib/bucketing/scoring";
import { interviewNote, type BucketingCandidateInput, type BucketingResult } from "@/lib/bucketing/types";

/**
 * Candidate Bucketing — ranking and CSV exports. Client-safe.
 * Inside a bucket: TR-2 strong → medium → low hire → TR-1 → Assessment, then
 * overall score, then trust. Not bucketed: the same tier order, so the most
 * valuable rejects get a manual look first.
 */

export interface RankedBuckets {
  buckets: Record<Bucket, BucketingResult[]>;
  notBucketed: BucketingResult[];
  retry: BucketingResult[];
}

export function rankBuckets(results: BucketingResult[]): RankedBuckets {
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, [] as BucketingResult[]])) as Record<Bucket, BucketingResult[]>;
  const notBucketed: BucketingResult[] = [];
  const retry: BucketingResult[] = [];
  for (const r of results) {
    if (r.status === "bucketed" && isBucket(r.bucket)) buckets[r.bucket].push(r);
    // A saved v1 result in a bucket that no longer exists (Frontend) needs a re-run under the new rules.
    else if (r.status === "retry_needed" || r.status === "bucketed") retry.push(r);
    else notBucketed.push(r);
  }
  for (const b of BUCKETS) buckets[b].sort(compareForRanking);
  const byStage = (a: BucketingResult, b: BucketingResult) => a.priorityTier - b.priorityTier || a.mobile.localeCompare(b.mobile);
  notBucketed.sort(byStage);
  retry.sort(byStage);
  return { buckets, notBucketed, retry };
}

/** The export's own identity columns come first, under the export's names, so rows match back to it. */
const HEADERS = [
  "Rank",
  "Bucket",
  "id",
  "name",
  "email",
  "phone",
  "college",
  "Tag",
  "Interview status",
  "Priority",
  "Status",
  "Placed by",
  "Overall score",
  "Internal assessment score",
  "TR-2 verdicts",
  "TR-1 status",
  "TR-1 technical score",
  "DSA interview (DSA /120 · CS /40)",
  "Assessment score (/160)",
  "SQL score (/30)",
  "Projects score",
  "Experience score",
  "Achievements score",
  "Flagship strength",
  "Bucket domain score",
  "DSA score",
  "Trust score",
  "Trust band",
  "Needs review",
  "Primary domain",
  "All domain scores",
  "Flagship project",
  "Flagship GitHub",
  "Flagship demo",
  "Flagship tier",
  "Verified projects",
  "Invalid projects",
  "Experience",
  "Achievements",
  "Codeforces",
  "CodeChef",
  "LeetCode",
  "Reasons (not bucketed)",
  "Flags",
  "Remarks",
  "GitHub account",
  "Resume link",
] as const;

const platform = (p: BucketingResult["dsa"]["platforms"]["codeforces"]) =>
  p.url ? `${p.solved ?? "?"} solved · ${p.contests ?? "?"} contests${p.rating !== null ? ` · rating ${p.rating}` : ""}${p.found === false ? " (profile not found)" : ""}` : "";

const num = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

function verdicts(r: BucketingResult): string {
  const iv = r.interview;
  if (!iv) return r.verdict && r.track ? `${TRACK_LABEL[r.track]}: ${VERDICT_LABEL[r.verdict]}` : "";
  return [
    ...iv.tr2.map((t) => `${TRACK_LABEL[t.track]}: ${VERDICT_LABEL[t.verdict]}`),
    ...(iv.combined ? [`Combined interview: ${VERDICT_LABEL[iv.combined]}`] : []),
    ...iv.tr2Rejected.map((t) => `${TRACK_LABEL[t]}: Rejected`),
  ].join("; ");
}

/**
 * Spreadsheet formula injection: a cell from a resume (a project title, a remark) that
 * starts with = + - @ would run as a formula in Excel / Sheets — prefix it with '.
 */
const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v);

function tr1Status(r: BucketingResult): string {
  const iv = r.interview;
  if (!iv) return "";
  if (iv.tr1.status) return iv.tr1.status;
  const q = iv.dsaInterview?.qualifying;
  return q === "shortlisted" ? "cleared (DSA interview)" : q ? "not cleared (DSA interview)" : "";
}

function row(r: BucketingResult, rank: number | "", c: BucketingCandidateInput | undefined): Record<string, string> {
  const out = rawRow(r, rank, c);
  for (const k of Object.keys(out)) out[k] = safe(out[k]);
  return out;
}

function rawRow(r: BucketingResult, rank: number | "", c: BucketingCandidateInput | undefined): Record<string, string> {
  const resumeUrl = c?.resumeUrl ?? "";
  const d = r.interview?.dsaInterview;
  const verified = r.projects.filter((p) => p.evidence?.valid);
  const invalid = r.projects.filter((p) => p.evidence?.status === "invalid");
  const a = r.interview?.assessment;
  const sql = a && (a.sqlMcq !== null || a.sqlCoding !== null) ? String((a.sqlMcq ?? 0) + (a.sqlCoding ?? 0)) : "";
  return {
    Rank: rank === "" ? "" : String(rank),
    Bucket: isBucket(r.bucket) ? BUCKET_LABEL[r.bucket] : (r.bucket ?? ""),
    id: c?.externalId ?? "",
    name: r.name,
    email: c?.email ?? "",
    phone: r.mobile,
    college: c?.college ?? "",
    Tag: r.stageLabel,
    "Interview status": interviewNote(r.interview),
    Priority: TIER_LABEL[r.priorityTier] ?? String(r.priorityTier),
    Status: r.status === "bucketed" ? "Bucketed" : r.status === "retry_needed" ? "Re-run needed" : "Not bucketed",
    "Placed by": r.placedBy === "tr2-track" ? "TR-2 track" : r.placedBy === "evidence" ? "Verified evidence" : "",
    "Overall score": String(r.scores.overall),
    "Internal assessment score": String(r.scores.internal),
    "TR-2 verdicts": verdicts(r),
    "TR-1 status": tr1Status(r),
    "TR-1 technical score": num(r.interview?.tr1.overallTechnical),
    "DSA interview (DSA /120 · CS /40)": d && (d.dsaScore !== null || d.csScore !== null) ? `${num(d.dsaScore)} · ${num(d.csScore)}` : "",
    "Assessment score (/160)": num(a?.offlineOverall),
    "SQL score (/30)": sql,
    "Projects score": String(r.scores.projects),
    "Experience score": String(r.scores.experience),
    "Achievements score": String(r.scores.achievements),
    "Flagship strength": String(r.scores.flagship),
    "Bucket domain score": String(r.scores.domain),
    "DSA score": String(r.scores.dsa),
    "Trust score": r.trust.trust === null ? "" : String(r.trust.trust),
    "Trust band": r.trust.band ?? "",
    "Needs review": r.trust.needsReview ? "Yes" : "No",
    "Primary domain": r.primaryDomain ? `${DOMAIN_LABEL[r.primaryDomain.domain]} (${r.primaryDomain.score})` : "",
    "All domain scores": r.domains
      .filter((d) => d.score > 0)
      .map((d) => `${DOMAIN_LABEL[d.domain]} ${d.score}`)
      .join("; "),
    "Flagship project": r.flagship?.title ?? "",
    "Flagship GitHub": r.flagship?.github.join(" ") ?? "",
    "Flagship demo": r.flagship?.demo ?? "",
    "Flagship tier": r.flagship?.tier ?? "",
    "Verified projects": verified.map((p) => `${p.title} [tier ${p.evidence!.tier}]`).join("; "),
    "Invalid projects": invalid.map((p) => `${p.title}: ${p.evidence!.invalidReason ? REASON_TEXT[p.evidence!.invalidReason] : "invalid"}`).join("; "),
    Experience: r.experience.map((e) => `${e.role} at ${e.company}${e.months !== null ? ` (${e.months} mo)` : ""}`).join("; "),
    Achievements: (r.achievements ?? []).map((x) => `${x.title} (${x.kind})`).join("; "),
    Codeforces: platform(r.dsa.platforms.codeforces),
    CodeChef: platform(r.dsa.platforms.codechef),
    LeetCode: platform(r.dsa.platforms.leetcode),
    "Reasons (not bucketed)": r.reasonCodes.map((c) => REASON_TEXT[c]).join("; "),
    Flags: r.flags.map((c) => REASON_TEXT[c]).join("; "),
    Remarks: r.remarks.join(" | "),
    "GitHub account": r.githubUser,
    "Resume link": resumeUrl,
  };
}

/** Every candidate: buckets in order (ranked), then not bucketed, then re-run needed. */
export function buildCompleteCsv(results: BucketingResult[], candidates: BucketingCandidateInput[]): string {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const ranked = rankBuckets(results);
  const rows: Record<string, string>[] = [];
  for (const b of BUCKETS) ranked.buckets[b].forEach((r, i) => rows.push(row(r, i + 1, byId.get(r.id))));
  for (const r of ranked.notBucketed) rows.push(row(r, "", byId.get(r.id)));
  for (const r of ranked.retry) rows.push(row(r, "", byId.get(r.id)));
  return `﻿${toCsv([...HEADERS], rows)}`;
}

/** One bucket, ranked. */
export function buildBucketCsv(bucket: Bucket, results: BucketingResult[], candidates: BucketingCandidateInput[]): string {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const rows = rankBuckets(results).buckets[bucket].map((r, i) => row(r, i + 1, byId.get(r.id)));
  return `﻿${toCsv([...HEADERS], rows)}`;
}

/** Candidates with no bucket (and those that need a re-run), TR-2 first, with the reasons. */
export function buildNotBucketedCsv(results: BucketingResult[], candidates: BucketingCandidateInput[]): string {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const ranked = rankBuckets(results);
  const rows = [...ranked.notBucketed, ...ranked.retry].map((r) => row(r, "", byId.get(r.id)));
  return `﻿${toCsv([...HEADERS], rows)}`;
}
