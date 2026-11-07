import "server-only";
import { query } from "@/lib/db/client";
import type { JobRow } from "@/lib/automation/store";
import { type ControlSnapshot, readControlSnapshot } from "@/lib/mobile/control-rows";
import { latestJobsFor } from "@/lib/mobile/jobs";
import { pushToUser } from "@/lib/mobile/push";
import { listRoster, matchMentor, type RosterUser } from "@/lib/mobile/roster";

/**
 * Turns the Mentor column into pushes (docs/decisions/0002 in the app repo):
 *   - a row newly assigned (or reassigned) to someone → "assignment" to that person;
 *   - half the time gone, 15 minutes left, past the deadline → one reminder each;
 *   - 30 minutes past the deadline → one escalation to the person's lead, else the admins.
 * A row that was acknowledged ("Start now") or already has a screening job gets no reminders.
 * Old rows never alert: a deadline more than a day ago, or a finished job, is history.
 * Runs every minute on the server (ticker.ts) and after every task-list refresh.
 */

const DUE_SOON_MS = 15 * 60_000;
const ESCALATE_AFTER_MS = 30 * 60_000;
const STALE_MS = 24 * 3_600_000;

interface Stored {
  task_id: string;
  assignee_email: string | null;
  ack_at: string | null;
}

const g = globalThis as unknown as { __mobileSyncRunning?: boolean };

export async function syncAssignments(snapshot?: ControlSnapshot): Promise<{ checked: number; pushed: number }> {
  if (g.__mobileSyncRunning) return { checked: 0, pushed: 0 };
  g.__mobileSyncRunning = true;
  try {
    const snap = snapshot ?? (await readControlSnapshot(true));
    const roster = await listRoster();
    const assigned = snap.tasks
      .map((task) => ({ task, assignee: task.mentor ? matchMentor(task.mentor, roster) : null }))
      .filter((x): x is { task: (typeof snap.tasks)[number]; assignee: RosterUser } => x.assignee !== null);
    if (!assigned.length) return { checked: 0, pushed: 0 };

    const stored = new Map(
      (await query<Stored>("select task_id, assignee_email, ack_at from app.assignments where task_id = any($1::text[])", [
        assigned.map((x) => x.task.taskId),
      ])).map((r) => [r.task_id, r]),
    );
    const jobs = await latestJobsFor(snap.spreadsheetId, snap.tab, assigned.map((x) => x.task));
    const now = Date.now();
    let pushed = 0;

    for (const { task, assignee } of assigned) {
      const prev = stored.get(task.taskId);
      const reassigned = prev && prev.assignee_email !== assignee.email;
      await query(
        `insert into app.assignments (task_id, spreadsheet_id, control_tab, control_row, company, assignee_email, assignee_name, assigned_at, deadline)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (task_id) do update set control_row = excluded.control_row, company = excluded.company,
           assignee_email = excluded.assignee_email, assignee_name = excluded.assignee_name,
           assigned_at = excluded.assigned_at, deadline = excluded.deadline,
           ack_at = case when $10 then null else app.assignments.ack_at end,
           ack_by = case when $10 then null else app.assignments.ack_by end,
           updated_at = now()`,
        [task.taskId, snap.spreadsheetId, snap.tab, task.row, task.company, assignee.email, assignee.name, task.assignedAt, task.deadline, Boolean(reassigned)],
      );

      const job = jobs.get(task.taskId);
      if (job) pushed += await jobUpdates(job, task.taskId, assignee);
      const acked = !reassigned && Boolean(prev?.ack_at);
      const deadline = task.deadline?.getTime() ?? null;
      const finished = job && job.status !== "pending" && job.status !== "processing";
      if (finished || (deadline !== null && deadline < now - STALE_MS)) continue;

      const data = {
        taskId: task.taskId,
        company: task.company,
        profilesRequired: String(task.profilesRequired),
        ...(task.deadline ? { deadline: task.deadline.toISOString() } : {}),
      };
      const key = (k: string) => `${k}:${task.taskId}:${assignee.email}`;
      const send = async (kind: "assignment" | "reminder" | "overdue", dedupe: string) => {
        const r = await pushToUser({ email: assignee.email, kind, data, dedupeKey: key(dedupe), taskId: task.taskId });
        if (!r.skipped) pushed++;
      };

      // New to this person: tell them, whatever the deadline (unless it's long past).
      await send("assignment", "assign");
      if (acked || job || deadline === null) continue;

      const assignedAt = task.assignedAt?.getTime() ?? null;
      if (now >= deadline) {
        await send("overdue", "overdue");
        if (now >= deadline + ESCALATE_AFTER_MS) pushed += await escalate(task.taskId, data, assignee, roster);
      } else if (deadline - now <= DUE_SOON_MS) {
        await send("reminder", "soon");
      } else if (assignedAt !== null && assignedAt < deadline && now >= assignedAt + (deadline - assignedAt) / 2) {
        await send("reminder", "half");
      }
    }
    return { checked: assigned.length, pushed };
  } finally {
    g.__mobileSyncRunning = false;
  }
}

/** Only recent jobs announce themselves (the first run after a deploy must not replay history). */
const JOB_NEWS_WINDOW_MS = 6 * 3_600_000;

/** "Shortlist ready" (early delivery), then "finished" / "failed" / "needs review", each once per job. */
async function jobUpdates(job: JobRow, taskId: string, assignee: RosterUser): Promise<number> {
  if (Date.now() - new Date(job.updatedAt).getTime() > JOB_NEWS_WINDOW_MS) return 0;
  const base = { taskId, jobId: job.id, company: job.companyName };
  const events: { key: string; data: Record<string, string> }[] = [];
  if (job.progress?.shortlistUrl) events.push({ key: "early", data: { ...base, jobStatus: job.status, earlyShortlist: "true" } });
  if (job.status === "completed" || job.status === "failed" || job.status === "awaiting_review") {
    events.push({ key: job.status, data: { ...base, jobStatus: job.status, earlyShortlist: "false" } });
  }
  let n = 0;
  for (const e of events) {
    const r = await pushToUser({ email: assignee.email, kind: "job_update", data: e.data, dedupeKey: `job:${e.key}:${job.id}`, taskId, jobId: job.id });
    if (!r.skipped) n++;
  }
  return n;
}

/** Overdue and not started: tell the person's lead, or every admin if they have none. */
async function escalate(taskId: string, data: Record<string, string>, assignee: RosterUser, roster: RosterUser[]): Promise<number> {
  const lead = assignee.leadEmail ? roster.find((u) => u.email === assignee.leadEmail && u.active) : undefined;
  const targets = lead ? [lead] : roster.filter((u) => u.active && u.role === "admin" && u.email !== assignee.email);
  let n = 0;
  for (const t of targets) {
    const r = await pushToUser({
      email: t.email,
      kind: "escalation",
      data: { ...data, title: `Overdue · ${data.company}`, body: `${assignee.name} hasn't started this task.` },
      dedupeKey: `escalate:${taskId}:${t.email}`,
      taskId,
    });
    if (!r.skipped) n++;
  }
  return n;
}
