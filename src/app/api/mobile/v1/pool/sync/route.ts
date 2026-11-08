import { NextResponse } from "next/server";
import { withUser } from "@/lib/mobile/http";
import { lastPoolSync, MANUAL_SYNC_MIN_MS, syncPool } from "@/lib/mobile/pool/sync";

/**
 * POST /pool/sync — re-read the Academy sheet now (the app's Refresh). At most once a minute: a
 * newer copy than that is simply reported. 200 with the outcome; a failed read keeps the last copy.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = withUser(async (_req, { user }) => {
  const last = await lastPoolSync();
  if (last && Date.now() - last.getTime() < MANUAL_SYNC_MIN_MS) {
    return NextResponse.json({ status: "fresh", syncedAt: last.toISOString(), added: 0, updated: 0, removed: 0, issues: 0 });
  }
  const r = await syncPool(user.email);
  return NextResponse.json({
    status: r.status,
    syncedAt: r.syncedAt,
    added: r.added,
    updated: r.updated,
    removed: r.removed,
    issues: r.issues.length,
    message: r.status === "failed" ? "The Academy sheet couldn't be read just now. The last copy is shown." : undefined,
  });
});
