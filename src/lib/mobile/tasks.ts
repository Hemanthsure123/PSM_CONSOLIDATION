import "server-only";
import { createHash } from "node:crypto";
import { query } from "@/lib/db/client";
import type { JobRow } from "@/lib/automation/store";
import { type ControlSnapshot, type ControlTask, readControlSnapshot } from "@/lib/mobile/control-rows";
import { UserError } from "@/lib/mobile/http";
import { latestJobsFor } from "@/lib/mobile/jobs";
import { listRoster, matchMentor, type RosterUser } from "@/lib/mobile/roster";

export type TaskState = "new" | "acknowledged" | "screening" | "shortlist_ready" | "shared" | "overdue" | "done";

export interface AssignmentRow {
  task_id: string;
  ack_at: string | null;
  ack_by: string | null;
  assignee_email: string | null;
  job_id: string | null;
}

/** Older rows that are finished don't belong in anyone's inbox. */
const HISTORY_DAYS = 45;

export function deriveState(task: ControlTask, ackAt: string | null, job: JobRow | undefined, now = new Date()): TaskState {
  let state: TaskState;
  if (job && (job.status === "pending" || job.status === "processing")) state = "screening";
  else if (job && (job.status === "completed" || job.status === "awaiting_review")) state = "shortlist_ready";
  else if (ackAt) state = "acknowledged";
  else state = "new";
  if ((state === "new" || state === "acknowledged" || state === "screening") && task.deadline && task.deadline <= now) state = "overdue";
  return state;
}

export async function loadAssignments(taskIds: string[]): Promise<Map<string, AssignmentRow>> {
  if (!taskIds.length) return new Map();
  const rows = await query<AssignmentRow>(
    "select task_id, ack_at, ack_by, assignee_email, job_id from app.assignments where task_id = any($1::text[])",
    [taskIds],
  );
  return new Map(rows.map((r) => [r.task_id, r]));
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toSummary(task: ControlTask, assignee: RosterUser | null, a: AssignmentRow | undefined, job: JobRow | undefined) {
  // An acknowledgement only counts for the person it's assigned to now.
  const ackAt = a?.ack_at && a.assignee_email === assignee?.email ? new Date(a.ack_at) : null;
  return {
    id: task.taskId,
    company: task.company,
    techStack: task.techStack,
    profilesRequired: task.profilesRequired,
    assignedAt: iso(task.assignedAt),
    deadline: iso(task.deadline),
    deadlineInferred: task.deadlineInferred,
    state: deriveState(task, ackAt?.toISOString() ?? null, job),
    assignee: assignee?.email ?? null,
    jobId: job?.id ?? null,
    ackAt: iso(ackAt),
  };
}

export function toDetail(task: ControlTask, assignee: RosterUser | null, a: AssignmentRow | undefined, job: JobRow | undefined, sheetUrl: string) {
  return {
    ...toSummary(task, assignee, a, job),
    product: task.product,
    pc: task.pc,
    crm: task.crm,
    hubspotUrl: task.hubspotUrl || null,
    remarks: task.remarks,
    jdUrl: /^https?:\/\//.test(task.jdUrl) ? task.jdUrl : null,
    internalSheetUrl: /^https?:\/\//.test(task.internalSheetUrl) ? task.internalSheetUrl : null,
    openings: task.openings,
    proposedMechanism: task.mechanism,
    lastConfig: null,
    sheetRowUrl: `${sheetUrl}&range=A${task.row}`,
  };
}

export interface TaskContext {
  snapshot: ControlSnapshot;
  roster: RosterUser[];
  task: ControlTask;
  assignee: RosterUser | null;
  assignment: AssignmentRow | undefined;
  job: JobRow | undefined;
}

export function canSee(user: RosterUser, assignee: RosterUser | null): boolean {
  return user.role === "admin" || user.role === "lead" || assignee?.email === user.email;
}

/** The list for GET /tasks: my rows (or everyone's with a mentor, for leads and admins). */
export async function listTasks(user: RosterUser, scope: "mine" | "team", fresh = false) {
  if (scope === "team" && user.role === "member") throw new UserError(403, "Only leads and admins can see the whole team.", "admin_only");
  const [snapshot, roster] = await Promise.all([readControlSnapshot(fresh), listRoster()]);
  const cutoff = Date.now() - HISTORY_DAYS * 86_400_000;
  const withAssignee = snapshot.tasks
    .map((task) => ({ task, assignee: task.mentor ? matchMentor(task.mentor, roster) : null }))
    .filter(({ task, assignee }) => assignee && (scope === "team" || assignee.email === user.email))
    .filter(({ task }) => !task.assignedAt || task.assignedAt.getTime() >= cutoff || !task.deadline || task.deadline.getTime() >= cutoff);
  const [assignments, jobs] = await Promise.all([
    loadAssignments(withAssignee.map((x) => x.task.taskId)),
    latestJobsFor(snapshot.spreadsheetId, snapshot.tab, withAssignee.map((x) => x.task)),
  ]);
  const tasks = withAssignee.map(({ task, assignee }) => toSummary(task, assignee, assignments.get(task.taskId), jobs.get(task.taskId)));
  const rank = (s: TaskState) => (s === "overdue" ? 0 : s === "new" ? 1 : s === "acknowledged" ? 2 : s === "screening" ? 3 : 4);
  tasks.sort((a, b) => rank(a.state) - rank(b.state) || String(a.deadline ?? "9").localeCompare(String(b.deadline ?? "9")));
  const etag = `"${createHash("sha1").update(JSON.stringify(tasks)).digest("hex").slice(0, 16)}"`;
  return { tasks, syncedAt: snapshot.readAt.toISOString(), etag, snapshot };
}

/** One task the user may see, with everything around it. 404 when it's gone or not theirs. */
export async function loadTask(user: RosterUser, taskId: string, fresh = false): Promise<TaskContext> {
  if (!/^[0-9a-f]{24}$/.test(taskId)) throw new UserError(404, "This task no longer exists.", "not_found");
  let snapshot = await readControlSnapshot(fresh);
  let task = snapshot.tasks.find((t) => t.taskId === taskId);
  if (!task && !fresh) {
    snapshot = await readControlSnapshot(true);
    task = snapshot.tasks.find((t) => t.taskId === taskId);
  }
  if (!task) throw new UserError(404, "This task is no longer in the sheet.", "not_found");
  const roster = await listRoster();
  const assignee = task.mentor ? matchMentor(task.mentor, roster) : null;
  if (!canSee(user, assignee)) throw new UserError(404, "This task is no longer assigned to you.", "not_found");
  const [assignments, jobs] = await Promise.all([
    loadAssignments([task.taskId]),
    latestJobsFor(snapshot.spreadsheetId, snapshot.tab, [task]),
  ]);
  return { snapshot, roster, task, assignee, assignment: assignments.get(task.taskId), job: jobs.get(task.taskId) };
}

/** "Start now": recorded for the person the row is assigned to now. */
export async function acknowledge(ctx: TaskContext, by: RosterUser): Promise<string> {
  const rows = await query<{ ack_at: string }>(
    `insert into app.assignments (task_id, spreadsheet_id, control_tab, control_row, company, assignee_email, assignee_name,
                                  assigned_at, deadline, ack_at, ack_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)
     on conflict (task_id) do update set
       ack_at = case when app.assignments.assignee_email is distinct from excluded.assignee_email or app.assignments.ack_at is null
                     then now() else app.assignments.ack_at end,
       ack_by = excluded.ack_by, assignee_email = excluded.assignee_email, assignee_name = excluded.assignee_name,
       control_row = excluded.control_row, updated_at = now()
     returning ack_at`,
    [
      ctx.task.taskId, ctx.snapshot.spreadsheetId, ctx.snapshot.tab, ctx.task.row, ctx.task.company,
      ctx.assignee?.email ?? null, ctx.assignee?.name ?? ctx.task.mentor, ctx.task.assignedAt, ctx.task.deadline, by.email,
    ],
  );
  return new Date(rows[0].ack_at).toISOString();
}
