/** Shared types for the DSA (LeetCode / Codeforces / CodeChef) consolidation. */

export type DsaLinkSource = "sheet" | "annotation" | "text" | "llm" | "none";

export type DsaPlatform = "leetcode" | "codeforces" | "codechef";

export const DSA_PLATFORMS: { key: DsaPlatform; label: string }[] = [
  { key: "leetcode", label: "LeetCode" },
  { key: "codeforces", label: "Codeforces" },
  { key: "codechef", label: "CodeChef" },
];

/** One candidate to resolve — the input the client sends to the server action. */
export interface DsaCandidateInput {
  id: string;
  /** Mobile number — the CSV key / uuid. */
  mobile: string;
  resumeUrl: string;
  /** Explicit profile links (or bare handles) from the sheet, if it has such columns. */
  leetcodeUrl?: string;
  codeforcesUrl?: string;
  codechefUrl?: string;
}

/**
 * Per-platform outcome for one candidate. Every number is `null` when it is
 * unknown (no link, or the fetch failed) — never 0 for "unknown". A `null`
 * rating on a profile that was read (`found: true`) means "unrated".
 */
export interface DsaPlatformResult {
  /** Resolved profile URL ("" when no link was found). */
  url: string;
  /** Parsed username / handle ("" when none). */
  handle: string;
  /** Problems solved. */
  solved: number | null;
  /** Rated contests participated (optional: runs saved before this existed lack it). */
  contests?: number | null;
  /** Current contest rating. */
  rating?: number | null;
  /** Highest contest rating (Codeforces / CodeChef). */
  maxRating?: number | null;
  /** Profile exists: true / false (not found) / null (couldn't tell). */
  found?: boolean | null;
  /** Where the link came from. */
  source: DsaLinkSource;
  /** Short human-readable status. */
  note: string;
  /** The name the profile's owner set, when the platform shows one (LeetCode, CodeChef; Codeforces on request). */
  ownerName?: string;
}

/** Full result for one candidate. */
export interface DsaResult {
  id: string;
  mobile: string;
  resumeUrl: string;
  leetcode: DsaPlatformResult;
  codeforces: DsaPlatformResult;
  /** Optional: runs saved before CodeChef support lack it. */
  codechef?: DsaPlatformResult;
  /** Sum of the solved counts that are known; `null` only when none is. */
  totalSolved: number | null;
  /** Sum of the contest counts that are known; `null` only when none is. */
  totalContests?: number | null;
  status: "ok" | "partial" | "no-links" | "error";
  error?: string;
}

/**
 * One candidate's DSA, read the DSA-consolidation way (all three platforms: solved,
 * rated contests, current / highest rating) — what Domain Shortlisting screens on.
 */
export interface DsaSnapshot {
  leetcode: DsaPlatformResult;
  codeforces: DsaPlatformResult;
  codechef: DsaPlatformResult;
  /** Sum of the known solved counts (null = none known). */
  totalSolved: number | null;
  /** Sum of the known rated-contest counts (null = none known). */
  totalContests: number | null;
  /** 0-100 DSA strength, Codeforces > CodeChef > LeetCode (dsa-scoring.ts). */
  score: number;
  /** A linked profile couldn't be read in full (rate limit / timeout) — the numbers may be low. */
  partial: boolean;
}

/** A saved DSA consolidation run — persisted for the dashboard. */
export interface DsaAnalysis {
  id: string;
  name: string;
  sheetTitle: string;
  createdAt: string;
  subsheets: string[];
  total: number;
  results: DsaResult[];
  /** False while the run is still in progress (saved after every batch). */
  complete?: boolean;
}

export const EMPTY_PLATFORM: DsaPlatformResult = {
  url: "",
  handle: "",
  solved: null,
  contests: null,
  rating: null,
  maxRating: null,
  found: null,
  source: "none",
  note: "",
};

/** A platform's result, tolerating runs saved before that platform existed. */
export function platformOf(r: DsaResult, key: DsaPlatform): DsaPlatformResult {
  return r[key] ?? EMPTY_PLATFORM;
}
