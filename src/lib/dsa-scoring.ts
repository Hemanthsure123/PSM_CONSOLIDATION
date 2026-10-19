import type { DsaPlatform, DsaPlatformResult, DsaSnapshot } from "@/lib/dsa-types";

/**
 * DSA screening — the shortlisting logic on top of the DSA consolidation's numbers
 * (LeetCode, Codeforces, CodeChef: problems solved, rated contests, rating). Pure:
 * the browser and the server use the same formulas.
 *
 * DSA score (0-100). Each platform scores 0-1 from its rating (only with a rated
 * contest), problems solved and contests, each against a cap; platforms are then
 * weighted Codeforces 1 > CodeChef 0.85 > LeetCode 0.7 (the same order the
 * bucketing rules use — Codeforces / CodeChef ratings are harder to earn). The
 * best weighted platform counts, plus 5 points for each other active platform.
 */

export const DSA_SCORING = {
  codeforces: { ratingFloor: 800, ratingSpan: 1200, solvedCap: 400, contestsCap: 30, w: { rating: 0.5, solved: 0.3, contests: 0.2 } },
  codechef: { ratingFloor: 1400, ratingSpan: 1000, solvedCap: 400, contestsCap: 30, w: { rating: 0.5, solved: 0.3, contests: 0.2 } },
  leetcode: { ratingFloor: 1400, ratingSpan: 1000, solvedCap: 600, contestsCap: 30, w: { rating: 0.4, solved: 0.4, contests: 0.2 } },
  platformWeight: { codeforces: 1, codechef: 0.85, leetcode: 0.7 } as Record<DsaPlatform, number>,
  breadthBonus: 0.05,
} as const;

/** The DSA score is worth at most this many points on the shortlist's 0-100 merit score. */
const DSA_MAX_BONUS = 15;

export const DSA_LABEL: Record<DsaPlatform, string> = { leetcode: "LeetCode", codeforces: "Codeforces", codechef: "CodeChef" };
const SHORT: Record<DsaPlatform, string> = { leetcode: "LC", codeforces: "CF", codechef: "CC" };
const ORDER: DsaPlatform[] = ["codeforces", "codechef", "leetcode"];

const clip01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const ratio = (v: number | null | undefined, cap: number) => (typeof v === "number" && v > 0 ? clip01(v / cap) : 0);

/** Highest rating known on a platform (highest ever, else current); null when unrated / unknown. */
export function bestRating(p: DsaPlatformResult | undefined): number | null {
  if (!p) return null;
  const known = [p.rating, p.maxRating].filter((n): n is number => typeof n === "number" && n > 0);
  return known.length ? Math.max(...known) : null;
}

/** 0-1 for one platform. A rating only counts with at least one rated contest. */
export function platformDsaScore(key: DsaPlatform, p: DsaPlatformResult | undefined): number {
  if (!p) return 0;
  const c = DSA_SCORING[key];
  const r = bestRating(p);
  const rated = (p.contests ?? 0) > 0 || (r !== null && key !== "leetcode");
  const rating = rated && r !== null ? clip01((r - c.ratingFloor) / c.ratingSpan) : 0;
  return c.w.rating * rating + c.w.solved * ratio(p.solved, c.solvedCap) + c.w.contests * ratio(p.contests, c.contestsCap);
}

/** 0-100 DSA strength from all three platforms. */
export function dsaScore(platforms: Record<DsaPlatform, DsaPlatformResult | undefined>): number {
  const weighted = ORDER.map((k) => ({ k, v: DSA_SCORING.platformWeight[k] * platformDsaScore(k, platforms[k]), active: (platforms[k]?.solved ?? 0) > 0 }));
  const best = weighted.reduce((m, w) => (w.v > m.v ? w : m), weighted[0]);
  if (best.v <= 0) return 0;
  const others = weighted.filter((w) => w.k !== best.k && w.active).length;
  return Math.round(100 * Math.min(1, best.v + DSA_SCORING.breadthBonus * others));
}

/** Rank points for the DSA score (only when the DSA toggle is on). */
export function dsaBonus(score: number | undefined, useDsa: boolean): number {
  if (!useDsa || !score || score <= 0) return 0;
  return Math.round((Math.min(score, 100) / 100) * DSA_MAX_BONUS);
}

// ── Gates ────────────────────────────────────────────────────────────────────

/** DSA shortlisting gates. 0 turns a gate (or a platform's rating bar) off. */
export interface DsaGates {
  /** Total problems solved across LeetCode + Codeforces + CodeChef. */
  minSolved: number;
  /** Total rated contests across the three. */
  minContests: number;
  /** Highest rating per platform — the candidate passes if ANY platform with a bar reaches it. */
  minRating: Record<DsaPlatform, number>;
  /** DSA score (0-100). */
  minScore: number;
}

export const NO_DSA_GATES: DsaGates = { minSolved: 0, minContests: 0, minRating: { leetcode: 0, codeforces: 0, codechef: 0 }, minScore: 0 };

export function dsaGatesActive(g: DsaGates | undefined): boolean {
  if (!g) return false;
  return g.minSolved > 0 || g.minContests > 0 || g.minScore > 0 || ORDER.some((k) => (g.minRating?.[k] ?? 0) > 0);
}

/** "CF 1584 · CC 1666 · LC —" style summary of the best ratings. */
export function ratingsLine(d: Pick<DsaSnapshot, DsaPlatform> | undefined): string {
  if (!d) return "";
  return ORDER.map((k) => {
    const r = bestRating(d[k]);
    return r !== null ? `${SHORT[k]} ${r}` : "";
  })
    .filter(Boolean)
    .join(" · ");
}

/** Why the candidate fails the DSA gates ("" = passes, or no gate is on). */
export function dsaGateFailure(d: DsaSnapshot | undefined, g: DsaGates | undefined): string {
  if (!dsaGatesActive(g) || !g) return "";
  if (!d) return "DSA profiles were not read — re-run with “Also weigh DSA” on";
  const partial = d.partial ? " (a linked profile couldn't be read in full — re-run to be sure)" : "";
  const solved = d.totalSolved ?? 0;
  if (g.minSolved > 0 && solved < g.minSolved) return `${solved} problems solved (LeetCode + Codeforces + CodeChef), below the ${g.minSolved} minimum${partial}`;
  const contests = d.totalContests ?? 0;
  if (g.minContests > 0 && contests < g.minContests) return `${contests} rated contests, below the ${g.minContests} minimum${partial}`;
  const bars = ORDER.filter((k) => (g.minRating?.[k] ?? 0) > 0);
  if (bars.length && !bars.some((k) => (bestRating(d[k]) ?? 0) >= g.minRating[k])) {
    const have = bars.map((k) => `${SHORT[k]} ${bestRating(d[k]) ?? "—"}`).join(" / ");
    const need = bars.map((k) => `${SHORT[k]} ${g.minRating[k]}`).join(" or ");
    return `Rating ${have} — needs ${need}${partial}`;
  }
  if (g.minScore > 0 && d.score < g.minScore) return `DSA score ${d.score}, below the ${g.minScore} minimum${partial}`;
  return "";
}
