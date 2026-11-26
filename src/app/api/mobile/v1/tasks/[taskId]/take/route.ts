import { NextResponse } from "next/server";
import { withUser } from "@/lib/mobile/http";
import { takeTask, taskDetail } from "@/lib/mobile/tasks";

/**
 * POST /tasks/{taskId}/take (anyone signed in): writes the caller's roster name into the row's blank
 * Mentor cell. 409 already_assigned when someone else is in it now. Returns the TaskDetail.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ taskId: string }>(async (_req, { user }, { taskId }) =>
  NextResponse.json(await taskDetail(await takeTask(user, taskId), user)),
);
