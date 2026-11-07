import "server-only";
import { query } from "@/lib/db/client";
import { toJob, type JobRow } from "@/lib/automation/store";
import type { ControlTask } from "@/lib/mobile/control-rows";

/** The orchestrator's checkpoint names → the app's agent steps (docs/mobile-api.yaml Job.step). */
const STEP: Record<string, string> = {
  queued: "queued",
  planning: "planner",
  screening: "screening",
  evaluating: "evaluation",
  validating: "validation",
  delivering: "delivery",
  done: "delivered",
};

/** automation.jobs row → the contract's Job. */
export function toMobileJob(job: JobRow, taskId: string | null, queueAhead?: number) {
  const p = job.progress ?? {};
  const r = job.result;
  return {
    id: job.id,
    taskId,
    company: job.companyName,
    status: job.status,
    step: STEP[job.step] ?? job.step,
    progress: {
      total: p.read ?? r?.read ?? null,
      screened: p.screened ?? r?.scored ?? null,
      shortlisted: p.shortlistCount ?? r?.shortlisted ?? null,
      githubChecked: p.githubDone ?? null,
    },
    queueAhead: job.status === "pending" ? (queueAhead ?? null) : null,
    stopRequested: Boolean(p.stopRequested),
    // The shortlist goes out before the full screening ends; the job doesn't timestamp that moment,
    // so the last update is the closest honest value.
    earlyShortlistAt: p.shortlistUrl ? job.updatedAt : null,
    deliveredTabUrl: p.shortlistUrl ?? r?.destinationUrl ?? null,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

/** The latest job per control row for these tasks (same row and company = the task's job). */
export async function latestJobsFor(spreadsheetId: string, tab: string, tasks: ControlTask[]): Promise<Map<string, JobRow>> {
  if (!tasks.length) return new Map();
  const rows = await query(
    `select distinct on (control_row) * from automation.jobs
      where spreadsheet_id = $1 and control_tab = $2 and control_row = any($3::int[])
      order by control_row, created_at desc`,
    [spreadsheetId, tab, tasks.map((t) => t.row)],
  );
  const byRow = new Map(rows.map((r) => toJob(r)).map((j) => [j.controlRow, j]));
  const out = new Map<string, JobRow>();
  for (const t of tasks) {
    const j = byRow.get(t.row);
    if (j && j.companyName.trim().toLowerCase() === t.company.trim().toLowerCase()) out.set(t.taskId, j);
  }
  return out;
}

/** The job and the task it belongs to (its control row with the same company), or null. */
export async function jobWithTask(jobId: string) {
  const { getJob } = await import("@/lib/automation/store");
  const { readControlSnapshot } = await import("@/lib/mobile/control-rows");
  const job = await getJob(jobId);
  if (!job) return null;
  const snap = await readControlSnapshot();
  const task = snap.tasks.find(
    (t) => snap.spreadsheetId === job.spreadsheetId && snap.tab === job.controlTab && t.row === job.controlRow &&
      t.company.trim().toLowerCase() === job.companyName.trim().toLowerCase(),
  );
  return { job, task: task ?? null };
}
