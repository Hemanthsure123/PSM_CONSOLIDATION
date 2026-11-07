import { NextResponse } from "next/server";
import { withUser } from "@/lib/mobile/http";
import { listTabs } from "@/lib/mobile/screening";
import { loadTask } from "@/lib/mobile/tasks";

/** GET /tasks/{taskId}/tabs: the Internal Sheet's candidate tabs with row and resume counts. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser<{ taskId: string }>(async (_req, { user }, { taskId }) =>
  NextResponse.json({ tabs: await listTabs(await loadTask(user, taskId)) }),
);
