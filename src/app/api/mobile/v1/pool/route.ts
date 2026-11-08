import { NextResponse } from "next/server";
import { withUser } from "@/lib/mobile/http";
import { listPool } from "@/lib/mobile/pool/service";
import { lastPoolSync, SYNC_EVERY_MS, syncPool, syncPoolIfStale } from "@/lib/mobile/pool/sync";

/**
 * GET /pool — the Academy priority pool: the candidates the user mentors (admins and leads: all),
 * with priority, track, tags, assessment highlights, interviews and resumes. Read from the database
 * (the sheet is copied every 10 minutes), so it is fast. ETag-aware: unchanged → 304.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async (req, { user }) => {
  // First use ever: copy the sheet before answering. Afterwards a stale copy refreshes in the background.
  if (!(await lastPoolSync())) await syncPool(`first read (${user.email})`);
  else void syncPoolIfStale(SYNC_EVERY_MS, "app read").catch(() => undefined);
  const { body, etag } = await listPool(user);
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return NextResponse.json(body, { headers: { ETag: etag, "Cache-Control": "no-store" } });
});
