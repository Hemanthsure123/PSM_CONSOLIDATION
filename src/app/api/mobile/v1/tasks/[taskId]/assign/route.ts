import { NextResponse } from "next/server";
import { syncAssignments } from "@/lib/mobile/assignments";
import { readJson, withUser } from "@/lib/mobile/http";
import { assignTask, taskDetail } from "@/lib/mobile/tasks";

/**
 * POST /tasks/{taskId}/assign { email } (admins and leads): writes that member's roster name into
 * the Mentor cell (overwrites, so it also reassigns). Their "assignment" push comes from the sync
 * started here in the background. Returns the TaskDetail.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ taskId: string }>(async (req, { user }, { taskId }) => {
  const body = await readJson<{ email?: unknown }>(req);
  const ctx = await assignTask(user, taskId, body?.email);
  void syncAssignments().catch((err) => console.warn("[mobile] sync after assign failed:", err instanceof Error ? err.message : err));
  return NextResponse.json(await taskDetail(ctx, user));
});
