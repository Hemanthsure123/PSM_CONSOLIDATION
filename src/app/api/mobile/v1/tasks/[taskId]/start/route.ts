import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { startScreening } from "@/lib/mobile/screening";
import { loadTask } from "@/lib/mobile/tasks";

/** POST /tasks/{taskId}/start (Idempotency-Key): writes the control row like a person, then queues the job. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ taskId: string }>(async (req, { user }, { taskId }) => {
  const ctx = await loadTask(user, taskId, true);
  if (ctx.assignee?.email !== user.email && user.role !== "admin") return fail(403, "Only the assigned mentor can start this screening.", "not_assignee");
  const { status, job } = await startScreening(ctx, await readJson(req), req.headers.get("idempotency-key") ?? "", user);
  return NextResponse.json(job, { status });
});
