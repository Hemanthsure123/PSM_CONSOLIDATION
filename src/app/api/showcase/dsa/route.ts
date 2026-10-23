import { NextResponse } from "next/server";
import { readCodeforcesBatch, readPlatformOne } from "@/lib/showcase/dsa";
import { withDeadline } from "@/lib/showcase/deadline";
import type { DsaPlatform } from "@/lib/dsa-types";
import type { SpDsaPlatform } from "@/lib/showcase/types";

/**
 * Sample profiles, DSA for the bar: a batch of Codeforces handles in one call, or a few
 * LeetCode / CodeChef profiles. Paced per host (rate-limit.ts), cached 24 h per handle.
 * Profiles that weren't reached before the deadline are simply missing — the browser retries them.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PLATFORMS: DsaPlatform[] = ["leetcode", "codeforces", "codechef"];

export async function POST(req: Request) {
  let body: { platform?: DsaPlatform; items?: { id: string; url: string }[]; minRating?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const platform = body.platform;
  const items = Array.isArray(body.items) ? body.items.filter((i) => i?.id && i?.url) : [];
  if (!platform || !PLATFORMS.includes(platform) || !items.length) {
    return NextResponse.json({ error: "platform and items are required." }, { status: 400 });
  }
  const results: Record<string, SpDsaPlatform> = {};
  const work = (async () => {
    if (platform === "codeforces") Object.assign(results, await readCodeforcesBatch(items.slice(0, 100), Number(body.minRating) || 0));
    else for (const it of items.slice(0, 5)) results[it.id] = await readPlatformOne(platform, it.url);
    return results;
  })();
  return NextResponse.json({ results: await withDeadline(work, 240_000, () => ({ ...results })) });
}
