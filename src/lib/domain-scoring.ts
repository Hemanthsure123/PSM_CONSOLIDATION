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

// ── Which candidates' GitHub is deep-inspected ──────────────────────────────

/**
 * "fit": only candidates who clear the domain-fit bar (best first, capped at
 * GITHUB_INSPECT_CAP) — the fast default. "all": every candidate with a GitHub
 * link, domain-fit ones first, no cap — slower, and it finds candidates whose code
 * proves the domain although their resume doesn't show it.
 */
export type GithubScope = "fit" | "all";

/** About how many REST calls one deep inspection costs, and GitHub's hourly allowance per token. */
export const GITHUB_CALLS_PER_CANDIDATE = 20;
export const GITHUB_HOURLY_LIMIT = 5_000;
/** Below this many calls left in the hour, inspection pauses until GitHub's reset instead of failing candidates. */
export const GITHUB_BUDGET_FLOOR = 300;

interface InspectionCandidate {
  githubStatus: string;
  domainScore: number;
  githubProfile: string;
  githubRepos: string[];
}

/**
 * The inspection queue for a run: candidates with a GitHub link that haven't been
 * inspected, domain-fit first (highest fit first), then — only with scope "all" —
 * everyone else, highest fit first. With scope "fit" the queue is capped; the rest
 * come back as `overCap`, and the below-bar candidates as `belowBar` (left out).
 */
export function planGithubInspection<T extends InspectionCandidate>(
  candidates: T[],
  scope: GithubScope,
  alreadyInspected: number,
): { pool: T[]; overCap: T[]; belowBar: T[] } {
  const waiting = candidates.filter((c) => c.githubStatus === "not-inspected" && (c.githubProfile || c.githubRepos.length));
  const byFit = (a: T, b: T) => b.domainScore - a.domainScore;
  const fit = waiting.filter((c) => c.domainScore >= MIN_DOMAIN_SCORE).sort(byFit);
  const below = waiting.filter((c) => c.domainScore < MIN_DOMAIN_SCORE).sort(byFit);
  if (scope === "all") return { pool: [...fit, ...below], overCap: [], belowBar: [] };
  const room = Math.max(0, GITHUB_INSPECT_CAP - alreadyInspected);
  return { pool: fit.slice(0, room), overCap: fit.slice(room), belowBar: below };
}

/** Rough hours of GitHub budget an "all candidates" run needs (cache hits cost nothing). */
export const githubHoursFor = (candidates: number) => (candidates * GITHUB_CALLS_PER_CANDIDATE) / GITHUB_HOURLY_LIMIT;

// ── GitHub strength the resume doesn't show ─────────────────────────────────

/** From this GitHub score a candidate's own code clearly proves the domain. */
export const GITHUB_STRONG_SCORE = 60;

interface GithubSignalCandidate {
  githubStatus: string;
  githubScore: number;
  githubMatches: number;
  githubTechs: string[];
  domainScore: number;
  /** The domain technologies the resume names (set on GitHub runs). */
  resumeTechs?: string[];
}

/** Domain technologies the candidate's code proves but the resume never names. */
export function githubTechsNotOnResume(c: GithubSignalCandidate): string[] {
  if (c.githubStatus !== "checked" || !Array.isArray(c.resumeTechs)) return [];
  const named = new Set(c.resumeTechs.map((t) => t.toLowerCase()));
  return c.githubTechs.filter((t) => !named.has(t.toLowerCase()));
}

/**
 * Strong domain code on GitHub while the resume stays below the domain-fit bar — the
 * candidate did the work but didn't put it on the resume. A signal for a human look;
 * it never changes the shortlist on its own.
 */
export function githubStrengthNotOnResume(c: GithubSignalCandidate): boolean {
  return c.githubStatus === "checked" && c.githubScore >= GITHUB_STRONG_SCORE && c.githubMatches > 0 && c.domainScore < MIN_DOMAIN_SCORE;
}

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
