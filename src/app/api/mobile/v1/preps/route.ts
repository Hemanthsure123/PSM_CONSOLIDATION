import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { addDays, dayOf, isDay } from "@/lib/mobile/preps/parse";
import { listPreps, MAX_WINDOW_DAYS } from "@/lib/mobile/preps/service";

/**
 * GET /preps?from=YYYY-MM-DD&to=YYYY-MM-DD — the Calendar's interviews and preps from the EDGE
 * "Edge Team drill down" tab (IST days, at most 62 days), plus every prep still to be given and
 * the prep numbers. ETag-aware: unchanged → 304.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async (req, { user }) => {
  const url = new URL(req.url);
  const today = dayOf(new Date());
  const from = url.searchParams.get("from") ?? addDays(today, -7);
  const to = url.searchParams.get("to") ?? addDays(today, 14);
  if (!isDay(from) || !isDay(to) || to < from) return fail(422, "from and to must be days (YYYY-MM-DD), from ≤ to.", "invalid_window");
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_WINDOW_DAYS) return fail(422, `Ask for at most ${MAX_WINDOW_DAYS} days at once.`, "invalid_window");
  const { items, stats, syncedAt, etag } = await listPreps(user, from, to);
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return NextResponse.json({ from, to, today, items, stats, syncedAt }, { headers: { ETag: etag, "Cache-Control": "no-store" } });
});
