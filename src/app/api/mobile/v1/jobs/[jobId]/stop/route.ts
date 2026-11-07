import { NextResponse } from "next/server";
import { writeControlStatus } from "@/lib/automation/control-sheet";
import { cancelPendingJob, requestStopJob } from "@/lib/automation/store";
import { kickWorker } from "@/lib/automation/worker";
import { fail, withUser } from "@/lib/mobile/http";
import { jobWithTask, toMobileJob } from "@/lib/mobile/jobs";
import { listRoster, matchMentor } from "@/lib/mobile/roster";

/** POST /jobs/{jobId}/stop: same as the sheet's stop. Queued → cancelled; running → delivers what it screened. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ jobId: string }>(async (_req, { user }, { jobId }) => {
  const found = await jobWithTask(jobId);
  if (!found) return fail(404, "This screening no longer exists.", "not_found");
  const assignee = found.task?.mentor ? matchMentor(found.task.mentor, await listRoster()) : null;
  if (assignee?.email !== user.email && user.role !== "admin") return fail(403, "Only the assigned mentor can stop this screening.", "not_assignee");
  const job = await requestStopJob({ jobId });
  if (!job) return fail(404, "This screening isn't running.", "not_running");
  const cancelled = job.status === "pending" ? await cancelPendingJob(job.id) : null;
  if (cancelled) {
    await writeControlStatus(cancelled, {
      status: "completed",
      step: "done",
      progress: { ...cancelled.progress, note: "Stopped from the app before screening started — nothing was screened" },
      result: null,
      error: null,
    });
    return NextResponse.json(toMobileJob(cancelled, found.task?.taskId ?? null));
  }
  kickWorker();
  return NextResponse.json(toMobileJob(job, found.task?.taskId ?? null));
});
