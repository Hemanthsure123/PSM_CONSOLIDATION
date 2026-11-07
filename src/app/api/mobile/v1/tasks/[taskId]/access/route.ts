import { NextResponse } from "next/server";
import { withUser } from "@/lib/mobile/http";
import { checkAccess } from "@/lib/mobile/screening";
import { loadTask } from "@/lib/mobile/tasks";

/** GET /tasks/{taskId}/access: can the service account read and edit the row's Internal Sheet? */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser<{ taskId: string }>(async (_req, { user }, { taskId }) =>
  NextResponse.json(await checkAccess(await loadTask(user, taskId))),
);
