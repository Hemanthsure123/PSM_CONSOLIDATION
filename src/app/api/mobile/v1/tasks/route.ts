import { NextResponse } from "next/server";
import { syncAssignments } from "@/lib/mobile/assignments";
import { withUser } from "@/lib/mobile/http";
import { listTasks } from "@/lib/mobile/tasks";

/**
 * GET /tasks?scope=mine|team: the rows in the coordination sheet whose Mentor is me (or everyone's,
 * for leads/admins). ETag-aware: an unchanged list answers 304. Each refresh also runs one pass of
 * the assignment/reminder sync in the background.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async (req, { user }) => {
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") === "team" ? "team" : "mine";
  const { tasks, syncedAt, etag, snapshot } = await listTasks(user, scope, url.searchParams.get("fresh") === "1");
  void syncAssignments(snapshot).catch((err) => console.warn("[mobile] sync after refresh failed:", err instanceof Error ? err.message : err));
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return NextResponse.json({ tasks, syncedAt }, { headers: { ETag: etag, "Cache-Control": "no-store" } });
});
