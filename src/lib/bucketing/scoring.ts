import {
  DSA,
  OVERALL_WEIGHTS,
  TRUST,
  VALIDATION,
  type Bucket,
} from "@/lib/bucketing/config";
import type {
  DsaPlatform,
  DsaPlatformKey,
  ExtractedExperience,
  OssEvidence,
  ProjectEvidence,
  Scores,
  TrustBand,
} from "@/lib/bucketing/types";

/**
 * Candidate Bucketing — every number, computed deterministically from verified
 * evidence. Constants live in config.ts. Pure: safe on client and server.
 */

const clip01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
export const clamp100 = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const ratio = (v: number | null, cap: number) => (v === null || v <= 0 ? 0 : clip01(v / cap));

// ── DSA ──────────────────────────────────────────────────────────────────────

/** 0-1 score for one platform. A rating only counts with at least one rated contest. */
export function platformScore(key: DsaPlatformKey, p: Pick<DsaPlatform, "solved" | "contests" | "rating">): number {
  const contests = p.contests ?? 0;
  if (key === "codeforces") {
    const c = DSA.codeforces;
    const rating = contests > 0 && p.rating !== null ? clip01((p.rating - c.ratingFloor) / c.ratingSpan) : 0;
    return c.w.rating * rating + c.w.solved * ratio(p.solved, c.solvedCap) + c.w.contests * ratio(p.contests, c.contestsCap);
  }
  if (key === "codechef") {
    const c = DSA.codechef;
    return c.w.solved * ratio(p.solved, c.solvedCap) + c.w.contests * ratio(p.contests, c.contestsCap);
  }
  const c = DSA.leetcode;
  const rating = contests > 0 && p.rating !== null ? clip01((p.rating - c.ratingFloor) / c.ratingSpan) : 0;
  return c.w.rating * rating + c.w.solved * ratio(p.solved, c.solvedCap) + c.w.contests * ratio(p.contests, c.contestsCap);
}

/**
 * 0-100. Codeforces > CodeChef > LeetCode: the best platform counts after its
 * weight, plus a small bonus for each other platform with real activity.
 */
export function dsaScore(platforms: Record<DsaPlatformKey, Pick<DsaPlatform, "score" | "solved">>): number {
  const weighted = (Object.keys(DSA.platformWeight) as DsaPlatformKey[]).map((k) => ({
    k,
    v: DSA.platformWeight[k] * (platforms[k]?.score ?? 0),
    active: (platforms[k]?.solved ?? 0) > 0,
  }));
  const best = weighted.reduce((m, w) => (w.v > m.v ? w : m), weighted[0]);
  const others = weighted.filter((w) => w.k !== best.k && w.active).length;
  if (best.v <= 0) return 0;
  return clamp100(100 * Math.min(1, best.v + DSA.breadthBonus * others));
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * How well verifiable evidence backs the resume (0-100). 0 unless the resume is
 * validated (≥ 1 Tier A/B project). `domainItems` = experience ids that count
 * as in-domain for the final bucket.
 */
export function validationScore(
  projects: ProjectEvidence[],
  experience: ExtractedExperience[],
  oss: OssEvidence[],
  domainItems: Set<string>,
): number {
  const ab = projects.filter((p) => p.valid && (p.tier === "A" || p.tier === "B"));
  if (ab.length === 0) return 0;
  const demos = projects.filter((p) => p.valid && p.demo?.status === "reachable").length;
  let score = VALIDATION.firstProject;
  score += Math.min(VALIDATION.extraProjectMax, (ab.length - 1) * VALIDATION.extraProject);
  score += Math.min(VALIDATION.demoMax, demos * VALIDATION.demo);

  const roles = experience.filter((e) => e.kind !== "other");
  if (roles.some((e) => domainItems.has(e.id))) score += VALIDATION.internship;
  const months = roles.reduce((s, e) => s + (e.months ?? 0), 0);
  if (roles.length >= 2 || months >= VALIDATION.internshipBonusMonths) score += VALIDATION.internshipBonus;
  if (oss.some((o) => o.status === "verified")) score += VALIDATION.oss;
  return clamp100(score);
}

// ── Overall ──────────────────────────────────────────────────────────────────

export function overallScore(s: Omit<Scores, "overall">): number {
  const w = OVERALL_WEIGHTS;
  return clamp100(w.domain * s.domain + w.validation * s.validation + w.flagship * s.flagship + w.dsa * s.dsa);
}

// ── Trust ────────────────────────────────────────────────────────────────────

/** A verifier's trust in the stage it checked: coverage of deterministic checks + judge agreement. */
export function verifierTrust(coverage: number, agreement: number | null): number {
  if (agreement === null) return clamp100(100 * clip01(coverage));
  return clamp100(100 * (TRUST.verifier.coverage * clip01(coverage) + TRUST.verifier.judge * clip01(agreement)));
}

export function trustBand(trust: number): TrustBand {
  return trust >= TRUST.bands.high ? "High" : trust >= TRUST.bands.medium ? "Medium" : "Low";
}

/**
 * Overall trust from the stage trusts (stages that did not run are left out and
 * the weights renormalised), then hard caps.
 */
export function overallTrust(
  components: { domain: number | null; bucket: number | null; dsa: number | null; final: number },
  caps: { value: number; why: string }[],
): { trust: number; applied: string[] } {
  const w = TRUST.overall;
  const parts: [number | null, number][] = [
    [components.domain, w.domain],
    [components.bucket, w.bucket],
    [components.dsa, w.dsa],
    [components.final, w.final],
  ];
  const live = parts.filter((p): p is [number, number] => p[0] !== null);
  const totalW = live.reduce((s, [, wt]) => s + wt, 0);
  let trust = totalW > 0 ? live.reduce((s, [v, wt]) => s + v * wt, 0) / totalW : 0;
  const applied: string[] = [];
  for (const cap of caps) {
    if (trust > cap.value) {
      trust = cap.value;
      applied.push(`${cap.why} (capped at ${cap.value})`);
    }
  }
  return { trust: clamp100(trust), applied };
}

/** Rank inside a bucket: stage tier first (TR-2 → TR-1 → Assessment), then overall score, then trust. */
export function compareForRanking(
  a: { priorityTier: number; scores: { overall: number }; trust: { trust: number | null } },
  b: { priorityTier: number; scores: { overall: number }; trust: { trust: number | null } },
): number {
  return a.priorityTier - b.priorityTier || b.scores.overall - a.scores.overall || (b.trust.trust ?? -1) - (a.trust.trust ?? -1);
}

/** The bucket's domain score, or 0. */
export function domainScoreFor(bucket: Bucket | null, domains: { domain: string; score: number }[]): number {
  if (!bucket) return 0;
  return domains.find((d) => d.domain === bucket)?.score ?? 0;
}
