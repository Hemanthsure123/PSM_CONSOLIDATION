import "server-only";
import { coalesce, inspectionCacheKey, readInspectionCache, writeInspectionCache } from "@/lib/github-inspect-cache";
import { PLATFORM, resolvePlatform } from "@/lib/dsa-resolve";
import type { DsaLinkSource, DsaPlatform, DsaPlatformResult } from "@/lib/dsa-types";

/**
 * One platform's DSA numbers, reused for 24 h per platform + handle (the GitHub inspection
 * cache's TTL and folder). Codeforces and CodeChef are paced at 1 request / 2 s and / 5 s, so a
 * sheet of thousands is slow the first time; a re-run, or the same candidate in another sheet,
 * costs nothing. Only definite answers are kept: a profile that was read in full, or one that
 * doesn't exist — never a rate limit or a timeout.
 */

const VERSION = 1;

export async function resolvePlatformCached(platform: DsaPlatform, url: string, source: DsaLinkSource): Promise<DsaPlatformResult & { fromCache?: boolean }> {
  if (!url) return resolvePlatform(platform, url, source);
  const handle = (PLATFORM[platform].parse(url) ?? "").toLowerCase();
  if (!handle) return resolvePlatform(platform, url, source);
  const key = inspectionCacheKey({ scope: "dsa-platform", v: VERSION, platform, handle });
  const hit = await readInspectionCache<DsaPlatformResult>(key);
  if (hit) return { ...hit.value, url, source, fromCache: true };
  return coalesce(key, async () => {
    const r = await resolvePlatform(platform, url, source);
    const definite = r.found === false || (r.found === true && r.solved !== null);
    if (definite) await writeInspectionCache(key, r);
    return r;
  });
}
