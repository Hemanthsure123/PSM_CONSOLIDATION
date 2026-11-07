import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { acknowledge, loadTask } from "@/lib/mobile/tasks";

/** POST /tasks/{taskId}/ack: "Start now". Stops reminders; idempotent. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ taskId: string }>(async (_req, { user }, { taskId }) => {
  const ctx = await loadTask(user, taskId);
  if (ctx.assignee?.email !== user.email && user.role !== "admin") return fail(403, "Only the assigned mentor can start this task.", "not_assignee");
  return NextResponse.json({ ackAt: await acknowledge(ctx, user) });
});
