"use server";

import { fetchResumeBytes } from "@/lib/resume";
import {
  extractProfileLinksFromResume,
  toLeetCodeUrl,
  toCodeforcesUrl,
  toCodeChefUrl,
} from "@/lib/resume-links";
import {
  getLeetCodeStats,
  getCodeforcesStats,
  getCodeChefStats,
  parseLeetCodeUser,
  parseCodeforcesHandle,
  parseCodeChefHandle,
  type PlatformStats,
} from "@/lib/coding-stats";
import { mapWithConcurrency } from "@/lib/rate-limit";
import type { ActionResult } from "@/lib/types";
import {
  EMPTY_PLATFORM,
  type DsaCandidateInput,
  type DsaLinkSource,
  type DsaPlatform,
  type DsaPlatformResult,
  type DsaResult,
} from "@/lib/dsa-types";

/** Max candidates resolved concurrently within one batch (each platform is paced by its own token bucket). */
const CONCURRENCY = 6;

/** Resume download + link extraction (incl. the LLM fallback) may take at most this long. */
const RESUME_STAGE_MS = 90_000;
/** Hard ceiling per candidate, so one stuck candidate can never freeze a batch. */
const CANDIDATE_MS = 240_000;

/**
 * Settle with `fallback()` if `work` hasn't finished within `ms`. The work
 * itself keeps running in the background (fetches can't all be cancelled), but
 * nobody waits for it any more.
 */
function withDeadline<T>(work: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback()), ms);
  });
  return Promise.race([work.finally(() => clearTimeout(timer)), deadline]);
}

const PLATFORM = {
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

const KEYS: DsaPlatform[] = ["leetcode", "codeforces", "codechef"];

/**
 * Resolve one candidate: find their LeetCode / Codeforces / CodeChef links
 * (sheet column → resume annotations/text → LLM), then read solved, contests
 * and rating from every platform in parallel.
 */
async function resolveOne(input: DsaCandidateInput): Promise<DsaResult> {
  const base: DsaResult = {
    id: input.id,
    mobile: input.mobile,
    resumeUrl: input.resumeUrl,
    leetcode: { ...EMPTY_PLATFORM },
    codeforces: { ...EMPTY_PLATFORM },
    codechef: { ...EMPTY_PLATFORM },
    totalSolved: null,
    totalContests: null,
    status: "no-links",
  };

  // 1. Explicit sheet links (URL or bare handle), validated + normalised.
  const sheet: Record<DsaPlatform, string> = {
    leetcode: input.leetcodeUrl ?? "",
    codeforces: input.codeforcesUrl ?? "",
    codechef: input.codechefUrl ?? "",
  };
  const links = {} as Record<DsaPlatform, { url: string; source: DsaLinkSource }>;
  for (const k of KEYS) {
    const url = PLATFORM[k].toUrl(sheet[k]);
    links[k] = { url, source: url ? "sheet" : "none" };
  }

  // 2. Fill the gaps from the resume (time-boxed — a slow download or LLM call
  //    must not hold up the platform lookups for the links we already have).
  if (KEYS.some((k) => !links[k].url) && input.resumeUrl.trim()) {
    try {
      const stage = (async () => {
        const resume = await fetchResumeBytes(input.resumeUrl);
        if (!resume) return { error: "Resume could not be downloaded (check sharing / link).", found: null };
        return { error: "", found: await extractProfileLinksFromResume(resume) };
      })();
      const out = await withDeadline(stage, RESUME_STAGE_MS, () => ({
        error: `Resume reading timed out after ${RESUME_STAGE_MS / 1000}s — used the sheet links only.`,
        found: null,
      }));
      if (out.error) base.error = out.error;
      if (out.found) {
        for (const k of KEYS) {
          const f = out.found[k];
          if (!links[k].url && f) links[k] = { url: f.url, source: f.source };
        }
      }
    } catch (err) {
      base.error = err instanceof Error ? err.message : "Resume processing failed.";
    }
  }

  // 3. All three platforms in parallel — each is paced by its own host bucket.
  const [lc, cf, cc] = await Promise.all(KEYS.map((k) => resolvePlatform(k, links[k].url, links[k].source)));
  base.leetcode = lc;
  base.codeforces = cf;
  base.codechef = cc;

  const platforms = [lc, cf, cc];
  const sum = (pick: (p: DsaPlatformResult) => number | null | undefined) => {
    const known = platforms.map(pick).filter((n): n is number => typeof n === "number");
    return known.length ? known.reduce((a, b) => a + b, 0) : null;
  };
  base.totalSolved = sum((p) => p.solved);
  base.totalContests = sum((p) => p.contests);

  const linked = platforms.filter((p) => p.url);
  // "Complete" = the profile was read in full. A link to a profile that doesn’t exist,
  // or a platform that couldn’t be read, leaves the row "partial" (see the Notes column).
  const complete = linked.filter((p) => p.found === true && p.solved !== null && p.contests !== null);
  base.status =
    linked.length === 0
      ? base.error
        ? "error"
        : "no-links"
      : complete.length === linked.length
        ? "ok"
        : "partial";

  return base;
}

async function resolvePlatform(platform: DsaPlatform, url: string, source: DsaLinkSource): Promise<DsaPlatformResult> {
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
    };
  } catch (err) {
    return {
      ...EMPTY_PLATFORM,
      url,
      handle,
      source,
      note: err instanceof Error ? err.message.slice(0, 120) : "Fetch failed",
    };
  }
}

/**
 * Resolve a batch of candidates concurrently (bounded). The client sends batches
 * and streams progress, so a large sheet stays responsive and partially
 * downloadable. Never throws — every candidate resolves to a result row.
 */
export async function resolveDsaBatch(inputs: DsaCandidateInput[]): Promise<ActionResult<DsaResult[]>> {
  try {
    const failed = (input: DsaCandidateInput, error: string): DsaResult => ({
      id: input.id,
      mobile: input.mobile,
      resumeUrl: input.resumeUrl,
      leetcode: { ...EMPTY_PLATFORM },
      codeforces: { ...EMPTY_PLATFORM },
      codechef: { ...EMPTY_PLATFORM },
      totalSolved: null,
      totalContests: null,
      status: "error",
      error,
    });
    const results = await mapWithConcurrency(inputs, CONCURRENCY, (input) =>
      withDeadline(
        resolveOne(input).catch((err) => failed(input, err instanceof Error ? err.message : "Resolution failed.")),
        CANDIDATE_MS,
        () => failed(input, `Timed out after ${CANDIDATE_MS / 60_000} min — re-run this candidate.`),
      ),
    );
    return { ok: true, data: results };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "DSA resolution failed." };
  }
}
