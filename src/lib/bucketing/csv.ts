import { toCsv } from "@/lib/utils";
import { BUCKET_LABEL, BUCKETS, DOMAIN_LABEL, REASON_TEXT, type Bucket } from "@/lib/bucketing/config";
import { compareForRanking } from "@/lib/bucketing/scoring";
import type { BucketingCandidateInput, BucketingResult } from "@/lib/bucketing/types";

/**
 * Candidate Bucketing — ranking and CSV exports. Client-safe.
 * Inside a bucket: TR-2 → TR-1 → Assessment, then overall score, then trust.
 * Not bucketed: TR-2 first too, so the most valuable rejects get a manual look.
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
    if (r.status === "bucketed" && r.bucket) buckets[r.bucket].push(r);
    else if (r.status === "retry_needed") retry.push(r);
    else notBucketed.push(r);
  }
  for (const b of BUCKETS) buckets[b].sort(compareForRanking);
  const byStage = (a: BucketingResult, b: BucketingResult) => a.priorityTier - b.priorityTier || a.mobile.localeCompare(b.mobile);
  notBucketed.sort(byStage);
  retry.sort(byStage);
  return { buckets, notBucketed, retry };
}

const HEADERS = [
  "Rank",
  "Bucket",
  "Stage",
  "Name",
  "Mobile",
  "Status",
  "Overall score",
  "Validation score",
  "Bucket domain score",
  "Flagship strength",
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

function row(r: BucketingResult, rank: number | "", resumeUrl: string): Record<string, string> {
  const verified = r.projects.filter((p) => p.evidence?.valid);
  const invalid = r.projects.filter((p) => p.evidence?.status === "invalid");
  return {
    Rank: rank === "" ? "" : String(rank),
    Bucket: r.bucket ? BUCKET_LABEL[r.bucket] : "",
    Stage: r.stageLabel,
    Name: r.name,
    Mobile: r.mobile,
    Status: r.status === "bucketed" ? "Bucketed" : r.status === "retry_needed" ? "Re-run needed" : "Not bucketed",
    "Overall score": String(r.scores.overall),
    "Validation score": String(r.scores.validation),
    "Bucket domain score": String(r.scores.domain),
    "Flagship strength": String(r.scores.flagship),
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
  const link = new Map(candidates.map((c) => [c.id, c.resumeUrl]));
  const ranked = rankBuckets(results);
  const rows: Record<string, string>[] = [];
  for (const b of BUCKETS) ranked.buckets[b].forEach((r, i) => rows.push(row(r, i + 1, link.get(r.id) ?? "")));
  for (const r of ranked.notBucketed) rows.push(row(r, "", link.get(r.id) ?? ""));
  for (const r of ranked.retry) rows.push(row(r, "", link.get(r.id) ?? ""));
  return `﻿${toCsv([...HEADERS], rows)}`;
}

/** One bucket, ranked. */
export function buildBucketCsv(bucket: Bucket, results: BucketingResult[], candidates: BucketingCandidateInput[]): string {
  const link = new Map(candidates.map((c) => [c.id, c.resumeUrl]));
  const rows = rankBuckets(results).buckets[bucket].map((r, i) => row(r, i + 1, link.get(r.id) ?? ""));
  return `﻿${toCsv([...HEADERS], rows)}`;
}

/** Candidates with no bucket (and those that need a re-run), TR-2 first, with the reasons. */
export function buildNotBucketedCsv(results: BucketingResult[], candidates: BucketingCandidateInput[]): string {
  const link = new Map(candidates.map((c) => [c.id, c.resumeUrl]));
  const ranked = rankBuckets(results);
  const rows = [...ranked.notBucketed, ...ranked.retry].map((r) => row(r, "", link.get(r.id) ?? ""));
  return `﻿${toCsv([...HEADERS], rows)}`;
}
