import { NextResponse } from "next/server";
import { withUser } from "@/lib/mobile/http";
import { loadTask, taskDetail } from "@/lib/mobile/tasks";

/** GET /tasks/{taskId}: everything the task screen shows. A task nobody has taken is visible to everyone. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser<{ taskId: string }>(async (_req, { user }, { taskId }) => {
  const ctx = await loadTask(user, taskId, true, { unassigned: true });
  return NextResponse.json(await taskDetail(ctx, user));
});
