import "server-only";
import { toCodeChefUrl, toCodeforcesUrl, toLeetCodeUrl } from "@/lib/resume-links";
import {
  getCodeChefStats,
  getCodeforcesStats,
  getLeetCodeStats,
  parseCodeChefHandle,
  parseCodeforcesHandle,
  parseLeetCodeUser,
  type PlatformStats,
} from "@/lib/coding-stats";
import { EMPTY_PLATFORM, type DsaLinkSource, type DsaPlatform, type DsaPlatformResult } from "@/lib/dsa-types";

/**
 * The DSA consolidation's per-platform lookup — shared by DSA Consolidation and
 * Domain Shortlisting so both read LeetCode / Codeforces / CodeChef the same way:
 * solved, rated contests, current and highest rating, and whether the profile
 * exists. Every number is `null` when unknown (no link / fetch failed), never 0.
 * Each platform is paced by its own host token bucket (rate-limit.ts).
 */

export const DSA_KEYS: DsaPlatform[] = ["leetcode", "codeforces", "codechef"];

export const PLATFORM = {
  leetcode: { toUrl: toLeetCodeUrl, parse: parseLeetCodeUser, stats: getLeetCodeStats, label: "LeetCode" },
  codeforces: { toUrl: toCodeforcesUrl, parse: parseCodeforcesHandle, stats: getCodeforcesStats, label: "Codeforces" },
  codechef: { toUrl: toCodeChefUrl, parse: parseCodeChefHandle, stats: getCodeChefStats, label: "CodeChef" },
} satisfies Record<
  DsaPlatform,
  {
    toUrl: (v: string) => string;
    parse: (url: string) => string | null;
    stats: (url: string) => Promise<PlatformStats | null>;
    label: string;
  }
>;

export async function resolvePlatform(platform: DsaPlatform, url: string, source: DsaLinkSource): Promise<DsaPlatformResult> {
  if (!url) return { ...EMPTY_PLATFORM, note: "No profile link found" };
  const handle = PLATFORM[platform].parse(url) ?? "";
  try {
    const stats = await PLATFORM[platform].stats(url);
    if (!stats) return { ...EMPTY_PLATFORM, url, handle, source, note: "Could not read the handle from the link" };
    return {
      url,
      handle,
      solved: stats.solved,
      contests: stats.contests,
      rating: stats.rating,
      maxRating: stats.maxRating,
      found: stats.found,
      source,
      note: stats.note || "OK",
      ...(stats.ownerName ? { ownerName: stats.ownerName } : {}),
    };
  } catch (err) {
    return { ...EMPTY_PLATFORM, url, handle, source, note: err instanceof Error ? err.message.slice(0, 120) : "Fetch failed" };
  }
}

export interface ResolvedPlatforms {
  leetcode: DsaPlatformResult;
  codeforces: DsaPlatformResult;
  codechef: DsaPlatformResult;
  /** Sum of the known solved counts; null only when none is known. */
  totalSolved: number | null;
  /** Sum of the known contest counts; null only when none is known. */
  totalContests: number | null;
  /** Profiles that were linked. */
  linked: number;
  /** Linked profiles read in full (exists, solved and contests known). */
  complete: number;
}

/** All three platforms in parallel — each paced by its own host bucket. */
export async function resolveDsaPlatforms(links: Record<DsaPlatform, { url: string; source: DsaLinkSource }>): Promise<ResolvedPlatforms> {
  const [leetcode, codeforces, codechef] = await Promise.all(DSA_KEYS.map((k) => resolvePlatform(k, links[k].url, links[k].source)));
  const platforms = [leetcode, codeforces, codechef];
  const sum = (pick: (p: DsaPlatformResult) => number | null | undefined) => {
    const known = platforms.map(pick).filter((n): n is number => typeof n === "number");
    return known.length ? known.reduce((a, b) => a + b, 0) : null;
  };
  const linked = platforms.filter((p) => p.url);
  return {
    leetcode,
    codeforces,
    codechef,
    totalSolved: sum((p) => p.solved),
    totalContests: sum((p) => p.contests),
    linked: linked.length,
    complete: linked.filter((p) => p.found === true && p.solved !== null && p.contests !== null).length,
  };
}
