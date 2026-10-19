"use server";

import { fetchResumeBytes } from "@/lib/resume";
import { extractProfileLinksFromResume } from "@/lib/resume-links";
import { DSA_KEYS as KEYS, PLATFORM, resolveDsaPlatforms } from "@/lib/dsa-resolve";
import { mapWithConcurrency } from "@/lib/rate-limit";
import type { ActionResult } from "@/lib/types";
import { EMPTY_PLATFORM, type DsaCandidateInput, type DsaLinkSource, type DsaPlatform, type DsaResult } from "@/lib/dsa-types";

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

  // 3. All three platforms in parallel — each is paced by its own host bucket (dsa-resolve.ts,
  //    shared with Domain Shortlisting so both read the platforms the same way).
  const r = await resolveDsaPlatforms(links);
  base.leetcode = r.leetcode;
  base.codeforces = r.codeforces;
  base.codechef = r.codechef;
  base.totalSolved = r.totalSolved;
  base.totalContests = r.totalContests;

  // "Complete" = the profile was read in full. A link to a profile that doesn’t exist,
  // or a platform that couldn’t be read, leaves the row "partial" (see the Notes column).
  base.status = r.linked === 0 ? (base.error ? "error" : "no-links") : r.complete === r.linked ? "ok" : "partial";

  return base;
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
