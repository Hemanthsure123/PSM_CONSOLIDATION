import { dsaBonus, type DsaGates } from "@/lib/dsa-scoring";
import { gateFailure, githubBonus, priorityGroup } from "@/lib/domain-scoring";
import { isAssessed } from "@/lib/pool/match";
import type { InternalStanding } from "@/lib/pool/types";
import type { DomainCandidate } from "@/lib/types";

/**
 * Who can still reach the top N — exact bounds, so skipping the others never changes the
 * shortlist (tested in scripts/automation-selftest.ts).
 *
 * The shortlist order is: priority group, then internal stage (TR-2 → TR-1 → assessment), then
 * the rank score = domain fit + GitHub bonus (0–20) + DSA bonus. Before GitHub is read, a
 * candidate's score lies between fit + DSA and fit + DSA + 20; after it, the code review can only
 * move the GitHub part between 40% of the inspection score and that plus 60 points. Let K be the
 * N-th candidate when everyone is at their LOWEST: whoever ranks behind K even at their HIGHEST
 * can never reach the top N — K and the N−1 ahead of K always beat them. So GitHub and the code
 * review are only spent on the rest (the contenders).
 *
 * The same reasoning decides when the shortlist is final although lower tiers are still being
 * screened: a candidate not yet screened can at best reach their own stage's place (an external
 * one: the external group), so once K's place is strictly ahead of every unscreened candidate's
 * best place, nobody left can enter the top N.
 */

export interface BoundsConfig {
  topN: number;
  useGithub: boolean;
  useDsa: boolean;
  mandatoryActive: boolean;
  dsaGates: DsaGates;
}

type Cand = DomainCandidate & { internal?: InternalStanding | null };
/** Lexicographic place: [priority group, internal stage] — lower is better. */
type Place = [number, number];

const placeOf = (c: Cand): Place | null => {
  const g = priorityGroup(c);
  return g === null ? null : [g, isAssessed(c.internal) ? c.internal.tier : 9];
};
const before = (a: Place, b: Place) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
const samePlace = (a: Place, b: Place) => a[0] === b[0] && a[1] === b[1];

/** Can this candidate be shortlisted at all (domain-fit bar and every strict gate)? */
export function clearsGates(c: Cand, cfg: BoundsConfig): boolean {
  if (placeOf(c) === null) return false;
  return !gateFailure(c, {
    mandatoryActive: cfg.mandatoryActive,
    requireExperience: false,
    minLeetcode: 0,
    dsaGates: cfg.dsaGates,
    minCommits: 0,
    checkPresentation: false,
    minPresentation: 0,
  });
}

/** Lowest and highest rank score still possible. `phase` = what is still unknown. */
export function scoreBounds(c: Cand, cfg: BoundsConfig, phase: "github" | "review" | "final"): { min: number; max: number } {
  const base = c.domainScore + dsaBonus(c.dsa?.score, cfg.useDsa);
  if (!cfg.useGithub) return { min: base, max: base };
  if (phase === "github") return { min: base, max: base + githubBonus(100, true) };
  const s = c.githubStatus === "checked" && c.githubIdentity !== "mismatch" ? c.githubScore : 0;
  const reviewable = c.githubStatus === "checked" && c.githubTopRepos.length > 0 && c.githubIdentity !== "mismatch";
  if (phase === "final" || !reviewable || c.projectReview?.status === "reviewed") {
    const ev = c.projectReview?.status === "reviewed" && c.githubIdentity !== "mismatch" ? Math.round(0.4 * s + 0.6 * c.projectReview.score) : s;
    return { min: base + githubBonus(ev, true), max: base + githubBonus(ev, true) };
  }
  return { min: base + githubBonus(Math.round(0.4 * s), true), max: base + githubBonus(Math.max(s, Math.min(100, Math.round(0.4 * s) + 60)), true) };
}

/** The N-th candidate at everyone's lowest score: its place and score (null = fewer than N clear the gates). */
function cutoff(pool: Cand[], cfg: BoundsConfig, phase: "github" | "review"): { place: Place; min: number } | null {
  const ranked = pool
    .map((c) => ({ place: placeOf(c)!, min: scoreBounds(c, cfg, phase).min }))
    .sort((a, b) => a.place[0] - b.place[0] || a.place[1] - b.place[1] || b.min - a.min);
  return ranked.length >= cfg.topN ? ranked[cfg.topN - 1] : null;
}

/** The candidates still able to reach the top N (ids), given what is unknown in `phase`. */
export function contenders(candidates: Cand[], cfg: BoundsConfig, phase: "github" | "review"): Set<string> {
  const pool = candidates.filter((c) => clearsGates(c, cfg));
  const k = cutoff(pool, cfg, phase);
  if (!k) return new Set(pool.map((c) => c.id));
  return new Set(
    pool
      .filter((c) => {
        const p = placeOf(c)!;
        return before(p, k.place) || (samePlace(p, k.place) && scoreBounds(c, cfg, phase).max >= k.min);
      })
      .map((c) => c.id),
  );
}

/** The best place a candidate not yet screened could reach (by their internal stage alone). */
export function bestPlaceUnscreened(internal: InternalStanding | null | undefined): Place {
  return isAssessed(internal) ? [1, internal.tier] : [3, 9];
}

/** True once no unscreened candidate can enter the top N. */
export function shortlistFinal(screened: Cand[], unscreened: (InternalStanding | null | undefined)[], cfg: BoundsConfig): boolean {
  if (!unscreened.length) return true;
  const pool = screened.filter((c) => clearsGates(c, cfg));
  const k = cutoff(pool, cfg, "github");
  if (!k) return false;
  return unscreened.every((u) => before(k.place, bestPlaceUnscreened(u)));
}

/** Screening waves, best stage first: TR-2, TR-1, assessment, then everyone else. */
export const waveOf = (internal: InternalStanding | null | undefined): number => (isAssessed(internal) ? internal.tier - 1 : 3);
