import {
  ACHIEVEMENT_POINTS,
  DSA,
  EXPERIENCE,
  GITHUB_OPTIONAL,
  INTERNAL,
  OVERALL_WEIGHTS,
  PROJECTS,
  TRUST,
  VERDICT_POINTS,
  type Bucket,
  type Tr2Verdict,
} from "@/lib/bucketing/config";
import type {
  DsaPlatform,
  DsaPlatformKey,
  ExtractedAchievement,
  ExtractedExperience,
  InterviewRecord,
  InternalParts,
  OssEvidence,
  ProjectEvidence,
  Scores,
  TrustBand,
} from "@/lib/bucketing/types";

/**
 * Candidate Bucketing — every number, computed deterministically from the
 * internal assessments and verified evidence. Constants live in config.ts.
 * Pure: safe on client and server.
 *
 * Priority (the user's order): internal assessments 40% · projects 30% ·
 * experience 20% · achievements 10%. Ranking puts the TR-2 tier first anyway.
 */

const clip01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
export const clamp100 = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const ratio = (v: number | null, cap: number) => (v === null || v <= 0 ? 0 : clip01(v / cap));

// ── Internal assessments ─────────────────────────────────────────────────────

/**
 * 0-100 from the interview export: the best TR-2 verdict, the TR-1 technical
 * score and the assessment score, weighted 50 / 30 / 20 and renormalised over the
 * parts the candidate has. For the Data Analytics bucket, SQL scores join the
 * assessment part.
 */
export function internalScore(
  iv: InterviewRecord | null | undefined,
  verdict: Tr2Verdict | null | undefined,
  bucket: Bucket | null,
): { score: number; parts: InternalParts } {
  const parts: InternalParts = { tr2: null, tr1: null, assessment: null, sql: null };
  if (verdict) parts.tr2 = VERDICT_POINTS[verdict];
  if (iv) {
    const t = iv.tr1;
    if (t.overallTechnical !== null) parts.tr1 = clamp100((100 * t.overallTechnical) / INTERNAL.tr1Max);
    else {
      const ratings = [t.dsaOverall, t.problemSolving, t.coding, t.debugging].filter((v): v is number => v !== null);
      if (ratings.length) parts.tr1 = clamp100((100 * ratings.reduce((a, b) => a + b, 0)) / ratings.length / INTERNAL.tr1RatingMax);
      else if (iv.dsaInterview && (iv.dsaInterview.dsaScore !== null || iv.dsaInterview.csScore !== null)) {
        // No AI-interview scores: the DSA interview's own scores stand for TR-1.
        const d = iv.dsaInterview;
        parts.tr1 = clamp100(100 * (0.75 * ratio(d.dsaScore, INTERNAL.dsaInterviewDsaMax) + 0.25 * ratio(d.csScore, INTERNAL.dsaInterviewCsMax)));
      }
    }
    const a = iv.assessment;
    if (a.offlineOverall !== null) parts.assessment = clamp100((100 * a.offlineOverall) / INTERNAL.assessmentMax);
    else if (a.dsaCoding !== null || a.csFundamentals !== null) {
      parts.assessment = clamp100(100 * (0.75 * ratio(a.dsaCoding, INTERNAL.dsaCodingMax) + 0.25 * ratio(a.csFundamentals, INTERNAL.csMax)));
    }
    if (a.sqlMcq !== null || a.sqlCoding !== null) {
      const got = [a.sqlMcq, a.sqlCoding].filter((v): v is number => v !== null);
      parts.sql = clamp100((100 * got.reduce((x, y) => x + y, 0)) / (got.length * INTERNAL.sqlMax));
    }
  }
  let assessment = parts.assessment;
  if (bucket === "DATA_ANALYTICS" && parts.sql !== null) {
    assessment = assessment === null ? parts.sql : (1 - INTERNAL.sqlShareForAnalytics) * assessment + INTERNAL.sqlShareForAnalytics * parts.sql;
  }
  const w = INTERNAL.weights;
  const live: [number, number][] = (
    [
      [parts.tr2, w.tr2],
      [parts.tr1, w.tr1],
      [assessment, w.assessment],
    ] as [number | null, number][]
  ).filter((x): x is [number, number] => x[0] !== null);
  const total = live.reduce((s, [, wt]) => s + wt, 0);
  return { score: total ? clamp100(live.reduce((s, [v, wt]) => s + v * wt, 0) / total) : 0, parts };
}

// ── Projects ─────────────────────────────────────────────────────────────────

/**
 * 0-100 for the projects behind the bucket: flagship strength 50%, verified
 * evidence 30% (first verified project, further ones, live demos, a notebook on
 * GitHub for ML / AI work), domain fit 20%. 0 when no project backs the bucket.
 */
export function projectsScore(
  bucket: Bucket | null,
  projects: ProjectEvidence[],
  flagshipStrength: number,
  domainScore: number,
): number {
  if (!bucket) return 0;
  const backing = projects.filter((p) => p.valid && p.buckets.includes(bucket));
  if (!backing.length) return 0;
  const verified = backing.some((p) => p.tier === "A" || p.tier === "B");
  let evidence = verified ? PROJECTS.firstVerified : PROJECTS.firstUnverified;
  evidence += Math.min(PROJECTS.extraProjectMax, (backing.length - 1) * PROJECTS.extraProject);
  evidence += Math.min(PROJECTS.demoMax, backing.filter((p) => p.demo?.status === "reachable").length * PROJECTS.demo);
  if (GITHUB_OPTIONAL.has(bucket) && backing.some((p) => p.notebooks && (p.tier === "A" || p.tier === "B"))) evidence += PROJECTS.notebookOnGithub;
  const w = PROJECTS.weights;
  return clamp100(w.flagship * flagshipStrength + w.evidence * Math.min(100, evidence) + w.domain * domainScore);
}

// ── Experience ───────────────────────────────────────────────────────────────

/**
 * 0-100: an in-domain internship / job is worth most (plus its months and a
 * second in-domain role); roles in other domains still show work experience.
 */
export function experienceScore(experience: ExtractedExperience[], inDomain: Set<string>): number {
  const roles = experience.filter((e) => e.kind !== "other");
  const own = roles.filter((e) => inDomain.has(e.id));
  const E = EXPERIENCE;
  if (own.length) {
    const months = own.reduce((s, e) => s + (e.months ?? 0), 0);
    return clamp100(E.inDomainFirst + Math.min(E.monthsMax, months * E.perMonth) + (own.length >= 2 ? E.secondInDomain : 0));
  }
  return clamp100(Math.min(E.otherRoleMax, roles.length * E.otherRole));
}

// ── Achievements ─────────────────────────────────────────────────────────────

/** 0-100: hackathon wins, ranks, publications, awards, merged open-source PRs, and competitive-programming activity. */
export function achievementsScore(achievements: ExtractedAchievement[], oss: OssEvidence[], dsa: number): number {
  const P = ACHIEVEMENT_POINTS;
  let pts = achievements.reduce((s, a) => s + (P[a.kind] ?? P.other), 0);
  if (oss.some((o) => o.status === "verified")) pts += P.ossMerged;
  pts += P.dsaShare * dsa;
  return clamp100(pts);
}

// ── Overall ──────────────────────────────────────────────────────────────────

export function overallScore(s: Pick<Scores, "internal" | "projects" | "experience" | "achievements">): number {
  const w = OVERALL_WEIGHTS;
  return clamp100(w.internal * s.internal + w.projects * s.projects + w.experience * s.experience + w.achievements * s.achievements);
}

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

/**
 * Rank inside a bucket: tier first (TR-2 strong → medium → low hire → TR-1 →
 * Assessment), then overall score, then trust.
 */
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
