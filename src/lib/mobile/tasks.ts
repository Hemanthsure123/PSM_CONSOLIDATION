import "server-only";
import { createHash } from "node:crypto";
import { query } from "@/lib/db/client";
import { controlLayout } from "@/lib/automation/control-sheet";
import type { JobRow } from "@/lib/automation/store";
import { type ControlSnapshot, type ControlTask, readControlSnapshot, readTaskFresh, writeMentorCell } from "@/lib/mobile/control-rows";
import { UserError } from "@/lib/mobile/http";
import { iseOwnerOf } from "@/lib/mobile/ise";
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
/** Unassigned rows are listed for a week after they were assigned, and until a day past their deadline. */
const UNASSIGNED_DAYS = 7;
const UNASSIGNED_AFTER_DEADLINE_MS = 24 * 3_600_000;

export type TaskScope = "mine" | "team" | "unassigned";

/** Nobody in the Mentor cell (a name that isn't on the roster still counts as assigned). */
export const isUnassigned = (task: Pick<ControlTask, "mentor">) => !task.mentor.trim();

/**
 * GET /tasks?scope=unassigned: a blank Mentor cell, a company, assigned in the last 7 days (or no
 * assigned date), and a deadline not more than 24 hours ago (or none).
 */
export function isUnassignedOpen(task: Pick<ControlTask, "mentor" | "company" | "assignedAt" | "deadline">, now = new Date()): boolean {
  if (!isUnassigned(task) || !task.company.trim()) return false;
  const t = now.getTime();
  if (task.assignedAt && task.assignedAt.getTime() < t - UNASSIGNED_DAYS * 86_400_000) return false;
  if (task.deadline && task.deadline.getTime() < t - UNASSIGNED_AFTER_DEADLINE_MS) return false;
  return true;
}

/** Soonest deadline first; rows without a deadline last (then in sheet order). */
export function byDeadline(a: Pick<ControlTask, "deadline" | "row">, b: Pick<ControlTask, "deadline" | "row">): number {
  const da = a.deadline?.getTime() ?? Number.POSITIVE_INFINITY;
  const db = b.deadline?.getTime() ?? Number.POSITIVE_INFINITY;
  return da === db ? a.row - b.row : da < db ? -1 : 1;
}

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

/**
 * [roster] gives the ISE owner (ise.ts). An unassigned row (blank Mentor cell) is "overdue" past its
 * deadline and "new" otherwise, whatever its job or acknowledgement.
 */
export function toSummary(
  task: ControlTask,
  assignee: RosterUser | null,
  a: AssignmentRow | undefined,
  job: JobRow | undefined,
  roster: RosterUser[] = [],
  now = new Date(),
) {
  // An acknowledgement only counts for the person it's assigned to now.
  const ackAt = a?.ack_at && a.assignee_email === assignee?.email ? new Date(a.ack_at) : null;
  const owner = iseOwnerOf(task.pc, roster);
  const state: TaskState = isUnassigned(task)
    ? task.deadline && task.deadline <= now
      ? "overdue"
      : "new"
    : deriveState(task, ackAt?.toISOString() ?? null, job, now);
  return {
    id: task.taskId,
    company: task.company,
    techStack: task.techStack,
    profilesRequired: task.profilesRequired,
    assignedAt: iso(task.assignedAt),
    deadline: iso(task.deadline),
    deadlineInferred: task.deadlineInferred,
    state,
    assignee: assignee?.email ?? null,
    jobId: job?.id ?? null,
    ackAt: iso(ackAt),
    assigneeName: assignee?.name ?? null,
    ise: task.pc,
    product: task.product,
    iseOwner: owner ? { email: owner.email, name: owner.name } : null,
  };
}

/** [viewer] decides canAssign (admins and leads); canTake = the Mentor cell is blank. */
export function toDetail(
  task: ControlTask,
  assignee: RosterUser | null,
  a: AssignmentRow | undefined,
  job: JobRow | undefined,
  sheetUrl: string,
  roster: RosterUser[] = [],
  viewer?: Pick<RosterUser, "role">,
) {
  return {
    ...toSummary(task, assignee, a, job, roster),
    canTake: isUnassigned(task),
    canAssign: viewer?.role === "admin" || viewer?.role === "lead",
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

/**
 * The list for GET /tasks: my rows, everyone's with a mentor (leads and admins), or the rows nobody
 * has taken yet (scope "unassigned": anyone signed in, soonest deadline first).
 */
export async function listTasks(user: RosterUser, scope: TaskScope, fresh = false) {
  if (scope === "team" && user.role === "member") throw new UserError(403, "Only leads and admins can see the whole team.", "admin_only");
  const [snapshot, roster] = await Promise.all([readControlSnapshot(fresh), listRoster()]);
  const now = new Date();
  const cutoff = now.getTime() - HISTORY_DAYS * 86_400_000;
  const picked: { task: ControlTask; assignee: RosterUser | null }[] =
    scope === "unassigned"
      ? snapshot.tasks.filter((task) => isUnassignedOpen(task, now)).sort(byDeadline).map((task) => ({ task, assignee: null }))
      : snapshot.tasks
          .map((task) => ({ task, assignee: task.mentor ? matchMentor(task.mentor, roster) : null }))
          .filter(({ assignee }) => assignee && (scope === "team" || assignee.email === user.email))
          .filter(({ task }) => !task.assignedAt || task.assignedAt.getTime() >= cutoff || !task.deadline || task.deadline.getTime() >= cutoff);
  const [assignments, jobs] = await Promise.all([
    loadAssignments(picked.map((x) => x.task.taskId)),
    latestJobsFor(snapshot.spreadsheetId, snapshot.tab, picked.map((x) => x.task)),
  ]);
  const tasks = picked.map(({ task, assignee }) => toSummary(task, assignee, assignments.get(task.taskId), jobs.get(task.taskId), roster, now));
  if (scope !== "unassigned") {
    const rank = (s: TaskState) => (s === "overdue" ? 0 : s === "new" ? 1 : s === "acknowledged" ? 2 : s === "screening" ? 3 : 4);
    tasks.sort((a, b) => rank(a.state) - rank(b.state) || String(a.deadline ?? "9").localeCompare(String(b.deadline ?? "9")));
  }
  const etag = `"${createHash("sha1").update(JSON.stringify(tasks)).digest("hex").slice(0, 16)}"`;
  return { tasks, syncedAt: snapshot.readAt.toISOString(), etag, snapshot };
}

/**
 * One task the user may see, with everything around it. 404 when it's gone or not theirs.
 * [opts.unassigned]: a row nobody has taken is visible to everyone (GET /tasks/{taskId}).
 */
export async function loadTask(user: RosterUser, taskId: string, fresh = false, opts: { unassigned?: boolean } = {}): Promise<TaskContext> {
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
  if (!canSee(user, assignee) && !(opts.unassigned && isUnassigned(task))) throw new UserError(404, "This task is no longer assigned to you.", "not_found");
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

/** TaskDetail for [ctx] as [viewer] sees it, with the link to its row in the control tab. */
export async function taskDetail(ctx: TaskContext, viewer: RosterUser) {
  const layout = await controlLayout(ctx.snapshot.spreadsheetId, ctx.snapshot.tab).catch(() => null);
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${ctx.snapshot.spreadsheetId}/edit#gid=${layout?.sheetId ?? 0}`;
  return toDetail(ctx.task, ctx.assignee, ctx.assignment, ctx.job, sheetUrl, ctx.roster, viewer);
}

const TASK_ID = /^[0-9a-f]{24}$/;

async function audit(actor: string, action: string, target: string, detail: Record<string, unknown>): Promise<void> {
  await query("insert into app.audit_log (actor_email, action, target, detail) values ($1, $2, $3, $4)", [actor, action, target, JSON.stringify(detail)]).catch(
    () => undefined,
  );
}

/** The context of a task whose Mentor cell was just written (no second sheet read). */
async function contextFor(snapshot: ControlSnapshot, roster: RosterUser[], task: ControlTask, assignee: RosterUser): Promise<TaskContext> {
  const [assignments, jobs] = await Promise.all([loadAssignments([task.taskId]), latestJobsFor(snapshot.spreadsheetId, snapshot.tab, [task])]);
  return { snapshot, roster, task, assignee, assignment: assignments.get(task.taskId), job: jobs.get(task.taskId) };
}

const locks = globalThis as unknown as { __taskWrites?: Map<string, Promise<unknown>> };

/**
 * Take / assign on one task run one at a time (this server is a single process): two people
 * tapping Take together can't both read a blank cell; the second reads the first one's name.
 */
export async function oneAtATime<T>(taskId: string, work: () => Promise<T>): Promise<T> {
  const map = (locks.__taskWrites ??= new Map());
  const run = (map.get(taskId) ?? Promise.resolve()).catch(() => undefined).then(work);
  map.set(taskId, run);
  try {
    return await run;
  } finally {
    if (map.get(taskId) === run) map.delete(taskId);
  }
}

async function freshTask(taskId: string): Promise<{ snapshot: ControlSnapshot; task: ControlTask }> {
  if (!TASK_ID.test(taskId)) throw new UserError(404, "This task no longer exists.", "not_found");
  const found = await readTaskFresh(taskId);
  if (!found) throw new UserError(404, "This task is no longer in the sheet.", "not_found");
  return found;
}

/**
 * POST /tasks/{taskId}/take (anyone signed in): the caller's roster name goes into the blank Mentor
 * cell. The row is read again first (found by its task id, so a moved row is never overwritten);
 * a cell that's no longer blank → 409 already_assigned. The caller's "assignment" push is claimed
 * before the write (so a tick in between can't send them "New task" for a task they took) and
 * released if the write fails. The task is then acknowledged for them: no sticky alarm.
 * Taking a task that's already the caller's answers it as is (a double tap, a retried request).
 */
export async function takeTask(user: RosterUser, taskId: string): Promise<TaskContext> {
  if (!TASK_ID.test(taskId)) throw new UserError(404, "This task no longer exists.", "not_found");
  return oneAtATime(taskId, () => take(user, taskId));
}

async function take(user: RosterUser, taskId: string): Promise<TaskContext> {
  const [{ snapshot, task }, roster] = await Promise.all([freshTask(taskId), listRoster()]);
  const me = roster.find((u) => u.email === user.email) ?? user;
  if (!isUnassigned(task)) {
    const holder = matchMentor(task.mentor, roster);
    if (holder?.email === me.email) return contextFor(snapshot, roster, task, holder);
    throw new UserError(409, `${holder?.name ?? task.mentor} already took this task.`, "already_assigned");
  }
  const claimed = await query<{ id: string }>(
    `insert into app.notifications (user_email, kind, task_id, dedupe_key, detail)
     values ($1, 'assignment', $2, $3, 'Taken in the app: no push') on conflict (dedupe_key) do nothing returning id`,
    [me.email, task.taskId, `assign:${task.taskId}:${me.email}`],
  );
  try {
    await writeMentorCell(snapshot, task, me.name);
  } catch (err) {
    if (claimed[0]) await query("delete from app.notifications where id = $1", [claimed[0].id]).catch(() => undefined);
    throw err;
  }
  const taken: ControlTask = { ...task, mentor: me.name };
  await acknowledge({ snapshot, roster, task: taken, assignee: me, assignment: undefined, job: undefined }, me);
  await audit(me.email, "task_taken", task.taskId, { company: task.company, row: task.row });
  return contextFor(snapshot, roster, taken, me);
}

/**
 * POST /tasks/{taskId}/assign { email } (admins and leads): that member's roster name goes into
 * the Mentor cell, overwriting what's there (so this also reassigns). Their "assignment" push comes
 * from the next sync (the route starts one at once).
 */
export async function assignTask(user: RosterUser, taskId: string, email: unknown): Promise<TaskContext> {
  if (user.role !== "admin" && user.role !== "lead") throw new UserError(403, "Only leads and admins can assign tasks.", "admin_only");
  const roster = await listRoster();
  const to = String(email ?? "").trim().toLowerCase();
  const member = roster.find((u) => u.email === to && u.active);
  if (!member) throw new UserError(422, "Choose an active team member.", "invalid_member");
  if (!TASK_ID.test(taskId)) throw new UserError(404, "This task no longer exists.", "not_found");
  return oneAtATime(taskId, async () => {
    const { snapshot, task } = await freshTask(taskId);
    const previous = task.mentor;
    if (previous !== member.name) await writeMentorCell(snapshot, task, member.name);
    await audit(user.email, "task_assigned", task.taskId, { company: task.company, row: task.row, to: member.email, previous });
    return contextFor(snapshot, roster, { ...task, mentor: member.name }, member);
  });
}
