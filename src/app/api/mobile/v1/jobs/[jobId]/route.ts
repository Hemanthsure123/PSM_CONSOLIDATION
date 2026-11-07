import { NextResponse } from "next/server";
import { queuePosition } from "@/lib/automation/store";
import { fail, withUser } from "@/lib/mobile/http";
import { jobWithTask, toMobileJob } from "@/lib/mobile/jobs";
import { listRoster, matchMentor } from "@/lib/mobile/roster";
import { canSee } from "@/lib/mobile/tasks";

/** GET /jobs/{jobId}: live state (the app polls every 5 s while the job screen is open). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser<{ jobId: string }>(async (_req, { user }, { jobId }) => {
  const found = await jobWithTask(jobId);
  if (!found) return fail(404, "This screening no longer exists.", "not_found");
  const assignee = found.task?.mentor ? matchMentor(found.task.mentor, await listRoster()) : null;
  if (!canSee(user, assignee)) return fail(404, "This screening isn't one of yours.", "not_found");
  const ahead = found.job.status === "pending" ? await queuePosition(found.job) : undefined;
  return NextResponse.json(toMobileJob(found.job, found.task?.taskId ?? null, ahead));
});
