import { dsaBonus, dsaGateFailure, dsaGatesActive, type DsaGates } from "@/lib/dsa-scoring";
import type { DsaSnapshot } from "@/lib/dsa-types";
import { isAssessed } from "@/lib/pool/match";
import type { InternalStanding } from "@/lib/pool/types";

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

// ── Internal assessments first ──────────────────────────────────────────────

/**
 * The bar for someone the eligible pool shows as internally assessed (Edge 2.0, Edge 1.0,
 * Academy — tiers 1-3): an "average" resume of 40-54 is still shortlistable for them,
 * because the assessment already vouches for them. Everyone else needs MIN_DOMAIN_SCORE.
 */
export const ASSESSED_MIN_DOMAIN_SCORE = 40;

interface PriorityCandidate {
  domainScore: number;
  internal?: InternalStanding | null;
}

/** The domain-fit score this candidate must reach: 40 when internally assessed, 55 otherwise. */
export function shortlistBar(c: PriorityCandidate): number {
  return isAssessed(c.internal) ? ASSESSED_MIN_DOMAIN_SCORE : MIN_DOMAIN_SCORE;
}

/**
 * Shortlisting priority of a candidate (before the run's gates):
 *  1 — internally assessed, good resume (domain fit 55+);
 *  2 — internally assessed, average resume (40-54);
 *  3 — external (or assessed but not eligible), good resume (55+);
 *  null — below their bar.
 */
export function priorityGroup(c: PriorityCandidate): 1 | 2 | 3 | null {
  if (isAssessed(c.internal)) {
    if (c.domainScore >= MIN_DOMAIN_SCORE) return 1;
    return c.domainScore >= ASSESSED_MIN_DOMAIN_SCORE ? 2 : null;
  }
  return c.domainScore >= MIN_DOMAIN_SCORE ? 3 : null;
}

/**
 * The shortlist order: priority group; inside groups 1 and 2 the internal stage (TR-2 →
 * TR-1 → assessment); then the run's combined score; then the internal score.
 */
export function comparePriority<T extends PriorityCandidate>(a: T, b: T, score: (c: T) => number): number {
  const group = (c: T) => priorityGroup(c) ?? 4;
  const tier = (c: T) => (isAssessed(c.internal) ? c.internal.tier : 9);
  return (
    group(a) - group(b) ||
    tier(a) - tier(b) ||
    score(b) - score(a) ||
    (isAssessed(b.internal) ? b.internal.score : 0) - (isAssessed(a.internal) ? a.internal.score : 0)
  );
}

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
  internal?: InternalStanding | null;
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
  // Shortlist order: assessed people first (by stage), then by fit.
  const byFit = (a: T, b: T) => comparePriority(a, b, (c) => c.domainScore);
  const fit = waiting.filter((c) => c.domainScore >= shortlistBar(c)).sort(byFit);
  const below = waiting.filter((c) => c.domainScore < shortlistBar(c)).sort(byFit);
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
  internal?: InternalStanding | null;
  githubIdentity?: "match" | "mismatch" | "unknown";
}

/** Domain technologies the candidate's code proves but the resume never names. */
export function githubTechsNotOnResume(c: GithubSignalCandidate): string[] {
  if (c.githubStatus !== "checked" || c.githubIdentity === "mismatch" || !Array.isArray(c.resumeTechs)) return [];
  const named = new Set(c.resumeTechs.map((t) => t.toLowerCase()));
  return c.githubTechs.filter((t) => !named.has(t.toLowerCase()));
}

/**
 * Strong domain code on GitHub while the resume stays below the domain-fit bar — the
 * candidate did the work but didn't put it on the resume. A signal for a human look;
 * it never changes the shortlist on its own.
 */
export function githubStrengthNotOnResume(c: GithubSignalCandidate): boolean {
  return (
    c.githubStatus === "checked" &&
    c.githubIdentity !== "mismatch" &&
    c.githubScore >= GITHUB_STRONG_SCORE &&
    c.githubMatches > 0 &&
    c.domainScore < shortlistBar(c)
  );
}

// ── The run's strict gates ──────────────────────────────────────────────────

export interface ShortlistGates {
  mandatoryActive: boolean;
  requireExperience: boolean;
  /** @deprecated LeetCode-only gate of older clients (0 = off). */
  minLeetcode: number;
  dsaGates?: DsaGates;
  minCommits: number;
  /** Presentation was graded this run. */
  checkPresentation: boolean;
  /** 0 = graded but gates nobody. */
  minPresentation: number;
}

export type GateKey = "mandatory" | "experience" | "leetcode" | "dsa" | "commits" | "presentation";

interface GateCandidate {
  meetsMandatory: boolean;
  hasDomainExperience: boolean;
  leetcodeSolved: number;
  dsa?: DsaSnapshot;
  githubCommits2y: number;
  githubStatus: string;
  githubNote: string;
  presentationScore: number;
  githubIdentity?: "match" | "mismatch" | "unknown";
  githubAccountName?: string;
}

/**
 * The first strict gate this candidate fails, with the reason in words — or null. Shared by
 * the ranking (server) and the browser (which spends the project-review budget only on
 * candidates who can still be shortlisted).
 */
export function gateFailure(c: GateCandidate, g: ShortlistGates): { gate: GateKey; reason: string } | null {
  if (g.mandatoryActive && !c.meetsMandatory) return { gate: "mandatory", reason: "Missing a mandatory skill" };
  if (g.requireExperience && !c.hasDomainExperience) return { gate: "experience", reason: "No domain internship / experience" };
  if (g.minLeetcode > 0 && c.leetcodeSolved < g.minLeetcode) {
    return { gate: "leetcode", reason: `${c.leetcodeSolved} LeetCode solved, below the ${g.minLeetcode} minimum` };
  }
  if (dsaGatesActive(g.dsaGates)) {
    const why = dsaGateFailure(c.dsa, g.dsaGates);
    if (why) return { gate: "dsa", reason: why };
  }
  // Commits of an account that clearly belongs to someone else don't count.
  if (g.minCommits > 0 && c.githubIdentity === "mismatch") {
    return { gate: "commits", reason: `GitHub account belongs to “${c.githubAccountName || "someone else"}” — its commits can't be counted` };
  }
  if (g.minCommits > 0 && c.githubCommits2y < g.minCommits) {
    // Say WHY the count is low — unknown (failed check) is not the same as zero.
    const reason =
      c.githubStatus === "failed"
        ? `GitHub check failed, commits unknown (${c.githubNote || "error"})`
        : c.githubStatus === "no-link"
          ? `No GitHub link in the resume — commits gate needs one`
          : c.githubStatus === "not-found"
            ? `GitHub user in the resume does not exist — commits gate`
            : `${c.githubCommits2y} GitHub commits (2y), below the ${g.minCommits} minimum`;
    return { gate: "commits", reason };
  }
  if (g.checkPresentation && g.minPresentation > 0 && c.presentationScore < g.minPresentation) {
    return { gate: "presentation", reason: `Resume presentation ${c.presentationScore}, below the ${g.minPresentation} minimum` };
  }
  return null;
}

// ── Deep project review ─────────────────────────────────────────────────────

/** Candidates whose top repos get the deep (file-level) project review, at most — best first. */
export const PROJECT_REVIEW_CAP = 40;
/** Project reviews running at once (each downloads up to two repos and makes a model call per repo). */
export const PROJECT_REVIEW_PARALLEL = 3;

/**
 * The GitHub evidence score used in the rank: the static inspection's score, blended with the
 * deep project review when there is one (the review weighs more — it judges the whole
 * project's features against the requirements, not just which packages it imports).
 */
export function githubEvidenceScore(c: {
  githubScore: number;
  projectReview?: { status: string; score: number } | null;
  githubIdentity?: "match" | "mismatch" | "unknown";
}): number {
  // A GitHub account that clearly belongs to someone else proves nothing about this candidate.
  if (c.githubIdentity === "mismatch") return 0;
  const review = c.projectReview?.status === "reviewed" ? c.projectReview.score : null;
  return review === null ? c.githubScore : Math.round(0.4 * c.githubScore + 0.6 * review);
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

/** What combinedScore is made of — for the CSV's Signals and Rank Score. */
export interface RankParts {
  fit: number;
  github: number;
  dsa: number;
  presentation: number;
  total: number;
}

type RankedCandidate = {
  domainScore: number;
  githubScore: number;
  presentationScore?: number;
  dsa?: { score: number };
  projectReview?: { status: string; score: number } | null;
  githubIdentity?: "match" | "mismatch" | "unknown";
};

export function rankParts(c: RankedCandidate, useGithub: boolean, checkPresentation = false, useDsa = false): RankParts {
  const parts = {
    fit: c.domainScore,
    github: githubBonus(githubEvidenceScore(c), useGithub),
    dsa: dsaBonus(c.dsa?.score, useDsa),
    presentation: presentationBonus(c.presentationScore ?? 0, checkPresentation),
  };
  return { ...parts, total: parts.fit + parts.github + parts.dsa + parts.presentation };
}

/**
 * Final rank score: resume domain fit + the (optional) GitHub / DSA / presentation
 * bonuses. DSA (up to +15, dsa-scoring.ts) sits between GitHub (+20) and presentation
 * (+10): with the DSA toggle on, a strong Codeforces / CodeChef / LeetCode record lifts
 * a candidate among comparable domain fits.
 */
export function combinedScore(c: RankedCandidate, useGithub: boolean, checkPresentation = false, useDsa = false): number {
  return rankParts(c, useGithub, checkPresentation, useDsa).total;
}

/**
 * The full shortlist order: priority group and internal stage (comparePriority), the rank
 * score, then — so equal scores never fall into an arbitrary order — the domain fit, the
 * GitHub evidence, DSA, the number of skills proven in projects / experience, and the name.
 */
export function compareShortlist<T extends RankedCandidate & { internal?: InternalStanding | null; coreSkills: string[]; name: string }>(
  a: T,
  b: T,
  useGithub: boolean,
  checkPresentation = false,
  useDsa = false,
): number {
  return (
    comparePriority(a, b, (c) => combinedScore(c, useGithub, checkPresentation, useDsa)) ||
    b.domainScore - a.domainScore ||
    githubEvidenceScore(b) - githubEvidenceScore(a) ||
    (b.dsa?.score ?? 0) - (a.dsa?.score ?? 0) ||
    b.coreSkills.length - a.coreSkills.length ||
    a.name.localeCompare(b.name)
  );
}
