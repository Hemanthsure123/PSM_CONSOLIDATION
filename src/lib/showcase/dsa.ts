import "server-only";
import { getCodeforcesRatedContests, getCodeforcesUsers, parseCodeforcesHandle } from "@/lib/coding-stats";
import { resolvePlatformCached } from "@/lib/dsa-cache";
import { inspectionCacheKey, readInspectionCache, writeInspectionCache } from "@/lib/github-inspect-cache";
import { EMPTY_PLATFORM, type DsaPlatform } from "@/lib/dsa-types";
import type { SpDsaPlatform } from "@/lib/showcase/types";

/**
 * Sample profiles — DSA lookups for the bar. Codeforces is read in batches (one paced user.info
 * call covers many handles; the rated-contest count is fetched only for handles whose rating can
 * clear the bar). LeetCode and CodeChef are read one profile at a time through the shared 24 h
 * DSA cache. Never throws; an unreadable profile comes back with `found: null` and a note.
 */

const CF_VERSION = 1;

interface CfInfo {
  found: boolean;
  rating: number | null;
  maxRating: number | null;
  name: string;
  handle: string;
  contests: number | null;
}

/** Codeforces for many candidates at once. `minRating` = the bar (contests are only counted for handles that can clear it). */
export async function readCodeforcesBatch(items: { id: string; url: string }[], minRating: number): Promise<Record<string, SpDsaPlatform>> {
  const out: Record<string, SpDsaPlatform> = {};
  const byHandle = new Map<string, { id: string; url: string }[]>();
  for (const it of items) {
    const h = parseCodeforcesHandle(it.url);
    if (!h) {
      out[it.id] = { ...EMPTY_PLATFORM, url: it.url, source: "text", note: "Could not read the handle from the link" };
      continue;
    }
    byHandle.set(h.toLowerCase(), [...(byHandle.get(h.toLowerCase()) ?? []), it]);
  }
  const cached = new Map<string, CfInfo>();
  const toFetch: string[] = [];
  for (const h of byHandle.keys()) {
    const hit = await readInspectionCache<CfInfo>(inspectionCacheKey({ scope: "showcase-cf", v: CF_VERSION, handle: h }));
    // A reading made under a higher bar has no contest count — read again once the bar can be cleared.
    const stale = hit && hit.value.found && hit.value.contests === null && Math.max(hit.value.rating ?? 0, hit.value.maxRating ?? 0) >= minRating;
    if (hit && !stale) cached.set(h, hit.value);
    else toFetch.push(h);
  }
  for (let i = 0; i < toFetch.length; i += 50) {
    const chunk = toFetch.slice(i, i + 50);
    const users = await getCodeforcesUsers(chunk);
    for (const h of chunk) {
      const u = users.get(h);
      if (!u) continue; // unknown (rate limit / network) — left unread, retried later
      const info: CfInfo = { found: u.found, rating: u.rating, maxRating: u.maxRating, name: u.name, handle: u.handle, contests: null };
      if (u.found && Math.max(u.rating ?? 0, u.maxRating ?? 0) >= minRating) info.contests = await getCodeforcesRatedContests(u.handle);
      if (!u.found || info.contests !== null || Math.max(u.rating ?? 0, u.maxRating ?? 0) < minRating) {
        await writeInspectionCache(inspectionCacheKey({ scope: "showcase-cf", v: CF_VERSION, handle: h }), info);
      }
      cached.set(h, info);
    }
  }
  for (const [h, list] of byHandle) {
    const info = cached.get(h);
    for (const it of list) {
      out[it.id] = info
        ? {
            url: it.url,
            handle: info.handle,
            solved: null,
            contests: info.contests,
            rating: info.rating,
            maxRating: info.maxRating,
            found: info.found,
            source: "text",
            note: info.found ? "OK" : "Profile not found",
            ...(info.name ? { ownerName: info.name } : {}),
            readAt: new Date().toISOString(),
          }
        : { ...EMPTY_PLATFORM, url: it.url, handle: h, source: "text", found: null, note: "Codeforces didn't answer — retried later" };
    }
  }
  return out;
}

/** One LeetCode / CodeChef (or a full Codeforces) profile, through the 24 h cache. */
export async function readPlatformOne(platform: DsaPlatform, url: string): Promise<SpDsaPlatform> {
  const r = await resolvePlatformCached(platform, url, "text");
  // A page that doesn't exist is a definite answer, not a passing failure.
  const missing = r.found === null && /HTTP 404\b/.test(r.note ?? "");
  return { ...r, ...(missing ? { found: false, note: "Profile not found" } : {}), readAt: new Date().toISOString() };
}

