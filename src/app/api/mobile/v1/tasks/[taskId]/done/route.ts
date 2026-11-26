import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { loadTask, markDone, taskDetail } from "@/lib/mobile/tasks";

/**
 * POST /tasks/{taskId}/done { done: true | false } (1.11.0): "Shortlisting done", or undo. The task's
 * mentor, leads and admins (anyone else: 403 not_your_task). Idempotent: a second "done" keeps the
 * first time. A done task stops showing as overdue and gets no more reminders. Returns the TaskDetail.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ taskId: string }>(async (req, { user }, { taskId }) => {
  const body = await readJson<{ done?: unknown }>(req);
  if (typeof body?.done !== "boolean") return fail(400, 'Send { "done": true } or { "done": false }.', "invalid_body");
  const ctx = await loadTask(user, taskId, false, { anyone: true });
  return NextResponse.json(await taskDetail(await markDone(ctx, user, body.done), user));
});
