import { NextResponse } from "next/server";
import { readJson, withUser } from "@/lib/mobile/http";
import { estimate, validateConfig } from "@/lib/mobile/screening";
import { loadTask } from "@/lib/mobile/tasks";

/** POST /tasks/{taskId}/estimate: the recheck screen's ETA, from recent screenings' real speed. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ taskId: string }>(async (req, { user }, { taskId }) => {
  const config = validateConfig(await readJson(req));
  return NextResponse.json(await estimate(await loadTask(user, taskId), config));
});
