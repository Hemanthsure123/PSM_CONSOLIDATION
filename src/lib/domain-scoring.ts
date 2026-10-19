import { dsaBonus } from "@/lib/dsa-scoring";

/**
 * Shared domain-shortlisting scoring constants + combination formula. Kept in a
 * plain module (not the "use server" action file) so both the client component
 * and the server action agree on the threshold and how the GitHub signal folds
 * into the final rank.
 */

/**
 * A candidate must clear this resume domain-fit score to be shortlistable. The
 * LLM is calibrated so a strong fit is 80+, a clear-but-lighter fit 55-79; below
 * this the evidence is tangential and the candidate is dropped.
 */
export const MIN_DOMAIN_SCORE = 55;

/**
 * Hard cap on how many shortlisted candidates get live GitHub inspection, to
 * protect the API budget. Real domain-match sets are far smaller than this, so
 * in practice every match is inspected; only a pathologically large match set is
 * capped (to the highest-scoring candidates, which more than covers any top-N).
 * Deep inspection costs ~20 REST calls a candidate, so 80 stays well inside the
 * 5,000/hour token budget.
 */
export const GITHUB_INSPECT_CAP = 80;

/** Candidates deep-inspected at once (each already reads 3 repos in parallel). */
export const GITHUB_BATCH_SIZE = 3;

/** The deep GitHub score (0-100) is worth at most this many points on the 0-100 merit score. */
const GH_MAX_BONUS = 20;

/**
 * Points added for the deep GitHub score — how strongly the candidate's public repos
 * prove the domain in their actual code. Linear and capped so that live GitHub proof
 * meaningfully lifts a candidate WITHOUT letting it override the resume's own domain
 * evidence — the two aspects combine.
 */
export function githubBonus(githubScore: number, useGithub: boolean): number {
  if (!useGithub || !(githubScore > 0)) return 0;
  return Math.round((Math.min(githubScore, 100) / 100) * GH_MAX_BONUS);
}

/**
 * Default bar for the resume-presentation gate: structure, alignment and visual
 * polish at or above what a hiring manager expects to see. 70+ is a resume that
 * looks professionally organised; below that it reads as rough or cluttered.
 */
export const DEFAULT_MIN_PRESENTATION = 70;

/** Presentation only starts earning rank points above this score … */
const PRES_FLOOR = 60;
/** … and is worth at most this many points at a perfect 100. */
const PRES_WEIGHT = 10;

/**
 * Points added for a well-structured, visually strong resume. Deliberately the
 * SMALLEST of the signals (half the GitHub maximum) and floored at `PRES_FLOOR`, so
 * presentation surfaces the eye-catching profiles first among comparably skilled
 * candidates: it can only overturn a domain-fit gap of up to `PRES_WEIGHT`
 * points, never a real difference in domain evidence.
 */
export function presentationBonus(presentationScore: number, checkPresentation: boolean): number {
  if (!checkPresentation || !presentationScore || presentationScore <= PRES_FLOOR) return 0;
  const span = 100 - PRES_FLOOR;
  return Math.round((Math.min(presentationScore, 100) - PRES_FLOOR) / span * PRES_WEIGHT);
}

/**
 * Final rank score: resume domain fit + the (optional) GitHub / DSA / presentation
 * bonuses. DSA (up to +15, dsa-scoring.ts) sits between GitHub (+20) and presentation
 * (+10): with the DSA toggle on, a strong Codeforces / CodeChef / LeetCode record lifts
 * a candidate among comparable domain fits.
 */
export function combinedScore(
  c: { domainScore: number; githubScore: number; presentationScore?: number; dsa?: { score: number } },
  useGithub: boolean,
  checkPresentation = false,
  useDsa = false,
): number {
  return (
    c.domainScore +
    githubBonus(c.githubScore, useGithub) +
    dsaBonus(c.dsa?.score, useDsa) +
    presentationBonus(c.presentationScore ?? 0, checkPresentation)
  );
}
