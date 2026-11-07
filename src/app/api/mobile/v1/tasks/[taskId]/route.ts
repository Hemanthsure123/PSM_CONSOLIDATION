import { NextResponse } from "next/server";
import { controlLayout } from "@/lib/automation/control-sheet";
import { withUser } from "@/lib/mobile/http";
import { loadTask, toDetail } from "@/lib/mobile/tasks";

/** GET /tasks/{taskId}: everything the task screen shows. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser<{ taskId: string }>(async (_req, { user }, { taskId }) => {
  const ctx = await loadTask(user, taskId, true);
  const layout = await controlLayout(ctx.snapshot.spreadsheetId, ctx.snapshot.tab).catch(() => null);
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${ctx.snapshot.spreadsheetId}/edit#gid=${layout?.sheetId ?? 0}`;
  return NextResponse.json(toDetail(ctx.task, ctx.assignee, ctx.assignment, ctx.job, sheetUrl));
});
