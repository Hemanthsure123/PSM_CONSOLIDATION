import "server-only";
import {
  getCodeChefStats,
  getCodeforcesStats,
  getLeetCodeStats,
  parseCodeChefHandle,
  parseCodeforcesHandle,
  parseLeetCodeUser,
  type PlatformStats,
} from "@/lib/coding-stats";
import { toCodeChefUrl, toCodeforcesUrl, toLeetCodeUrl } from "@/lib/resume-links";
import { DSA } from "@/lib/bucketing/config";
import { traceEntry } from "@/lib/bucketing/nodes/shared";
import { dsaScore, platformScore, verifierTrust } from "@/lib/bucketing/scoring";
import { DSA_PLATFORMS, emptyDsa, type DsaPlatform, type DsaPlatformKey, type DsaResult, type ProfileLink, type Review } from "@/lib/bucketing/types";
import type { State, Update } from "@/lib/bucketing/state";

/**
 * Agent 5 — DSA consolidation (deterministic): Codeforces, CodeChef and LeetCode
 * solved / contests / rating, from the sheet's links first, then the resume's.
 * Agent 6 — DSA verifier (deterministic): where each handle came from, whether
 * each profile was really read, and whether the numbers are coherent (a rating
 * needs a rated contest); trust is the share of linked platforms read in full.
 * Codeforces > CodeChef > LeetCode (scoring.ts).
 */

const PLATFORM: Record<
  DsaPlatformKey,
  { toUrl: (v: string) => string; parse: (u: string) => string | null; stats: (u: string) => Promise<PlatformStats | null>; label: string }
> = {
  codeforces: { toUrl: toCodeforcesUrl, parse: parseCodeforcesHandle, stats: getCodeforcesStats, label: "Codeforces" },
  codechef: { toUrl: toCodeChefUrl, parse: parseCodeChefHandle, stats: getCodeChefStats, label: "CodeChef" },
  leetcode: { toUrl: toLeetCodeUrl, parse: parseLeetCodeUser, stats: getLeetCodeStats, label: "LeetCode" },
};

const ROW_KEY: Record<DsaPlatformKey, "codeforcesUrl" | "codechefUrl" | "leetcodeUrl"> = {
  codeforces: "codeforcesUrl",
  codechef: "codechefUrl",
  leetcode: "leetcodeUrl",
};

async function readPlatform(key: DsaPlatformKey, link: ProfileLink | null): Promise<DsaPlatform> {
  const empty = emptyDsa().platforms[key];
  if (!link) return { ...empty, note: "no profile link" };
  const handle = PLATFORM[key].parse(link.url) ?? link.handle;
  try {
    const stats = await PLATFORM[key].stats(link.url);
    if (!stats) return { ...empty, url: link.url, handle, source: link.source, note: "could not read the handle from the link" };
    const p: DsaPlatform = {
      url: link.url,
      handle,
      source: link.source,
      found: stats.found,
      solved: stats.solved,
      contests: stats.contests,
      rating: stats.rating,
      maxRating: stats.maxRating,
      note: stats.note || "OK",
      score: 0,
      ratingIgnored: false,
    };
    return { ...p, score: platformScore(key, p) };
  } catch (err) {
    return { ...empty, url: link.url, handle, source: link.source, note: err instanceof Error ? err.message.slice(0, 120) : "fetch failed" };
  }
}

export async function dsaCollectorNode(s: State): Promise<Update> {
  const t0 = Date.now();
  const x = s.extraction;
  const links = Object.fromEntries(
    DSA_PLATFORMS.map((k) => {
      const row = PLATFORM[k].toUrl(s.input[ROW_KEY[k]] ?? "");
      const link: ProfileLink | null = row
        ? { url: row, handle: PLATFORM[k].parse(row) ?? "", source: "row" }
        : (x?.profiles[k] ?? null);
      return [k, link];
    }),
  ) as Record<DsaPlatformKey, ProfileLink | null>;

  const read = await Promise.all(DSA_PLATFORMS.map((k) => readPlatform(k, links[k])));
  const platforms = Object.fromEntries(DSA_PLATFORMS.map((k, i) => [k, read[i]])) as Record<DsaPlatformKey, DsaPlatform>;
  const dsa: DsaResult = { platforms, score: dsaScore(platforms), flags: [] };
  const summary = DSA_PLATFORMS.filter((k) => platforms[k].url)
    .map((k) => `${PLATFORM[k].label} ${platforms[k].solved ?? "?"} solved / ${platforms[k].contests ?? "?"} contests${platforms[k].rating ? ` / ${platforms[k].rating}` : ""}`)
    .join("; ");
  return { dsa, ...traceEntry("dsa_collector", t0, `DSA ${dsa.score}${summary ? ` — ${summary}` : " — no coding profiles"}`) };
}

export async function dsaVerifierNode(s: State): Promise<Update> {
  const t0 = Date.now();
  const dsa = s.dsa ?? emptyDsa();
  const text = (s.resumeText ?? "").toLowerCase();
  const issues: string[] = [];
  const flags: string[] = [];
  let linked = 0;
  let covered = 0;
  const platforms = { ...dsa.platforms };

  for (const k of DSA_PLATFORMS) {
    let p = { ...platforms[k] };
    if (!p.url) continue;
    linked += 1;
    const label = PLATFORM[k].label;
    // A model-found handle must literally be in the resume (ingest enforces this; re-checked here).
    if (p.source === "llm" && p.handle && !text.includes(p.handle.toLowerCase())) {
      issues.push(`${label}: handle "${p.handle}" is not written in the resume — ignored`);
      platforms[k] = { ...emptyDsa().platforms[k], note: "handle not in resume — ignored" };
      continue;
    }
    if (p.found === false) {
      covered += 1;
      issues.push(`${label}: profile "${p.handle}" does not exist`);
      platforms[k] = { ...p, score: 0 };
      continue;
    }
    if (p.found !== true || p.solved === null) {
      issues.push(`${label}: profile could not be read (${p.note || "unknown"}) — not counted`);
      continue;
    }
    covered += 1;
    if (p.rating !== null && (p.contests ?? 0) === 0) {
      issues.push(`${label}: rating ${p.rating} with no rated contest — rating ignored`);
      p = { ...p, rating: null, ratingIgnored: true };
    }
    if (k === "codeforces" && (p.rating ?? 0) >= DSA.cfOutlier) {
      flags.push(`Codeforces rating ${p.rating} is rare among students — confirm the handle is the candidate's`);
    }
    if ((p.solved ?? 0) > 4000) flags.push(`${label}: ${p.solved} problems solved — unusually high, confirm the handle`);
    platforms[k] = { ...p, score: platformScore(k, p) };
  }

  const coverage = linked ? covered / linked : 1;
  const verified: DsaResult = { platforms, score: dsaScore(platforms), flags: [...dsa.flags, ...flags] };
  const review: Review = {
    verdict: "pass",
    trust: verifierTrust(coverage, null),
    coverage: Number(coverage.toFixed(2)),
    agreement: null,
    issues: [...issues, ...flags].slice(0, 10),
    model: "",
  };
  return {
    dsa: verified,
    dsaReview: review,
    ...traceEntry("dsa_verifier", t0, `trust ${review.trust} (${covered}/${linked} profiles read)${verified.score !== dsa.score ? `; DSA ${dsa.score} → ${verified.score}` : ""}`),
  };
}
