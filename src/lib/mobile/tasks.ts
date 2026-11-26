import "server-only";
import { createHash } from "node:crypto";
import { query } from "@/lib/db/client";
import { controlLayout } from "@/lib/automation/control-sheet";
import type { JobRow } from "@/lib/automation/store";
import { type ControlSnapshot, type ControlTask, readControlSnapshot, readTaskFresh, writeMentorCell } from "@/lib/mobile/control-rows";
import { UserError } from "@/lib/mobile/http";
import { iseOwnerOf } from "@/lib/mobile/ise";
import { latestJobsFor } from "@/lib/mobile/jobs";
import { pushToUser } from "@/lib/mobile/push";
import { listRoster, matchMentor, type RosterUser } from "@/lib/mobile/roster";
import { doneText, istDay, taskDedupe } from "@/lib/mobile/task-nudges";
import { taskDoneReady } from "@/lib/mobile/task-schema";

export type TaskState = "new" | "acknowledged" | "screening" | "shortlist_ready" | "shared" | "overdue" | "done";
/** 1.11.0. How the row got its mentor: typed in the sheet, filled from the ISE mapping, or taken / assigned in the app. */
export type AssignedVia = "sheet" | "ise" | "app";

export interface AssignmentRow {
  task_id: string;
  ack_at: string | null;
  ack_by: string | null;
  assignee_email: string | null;
  job_id: string | null;
  /** 1.11.0 (migration 021): absent before it. */
  done_at?: string | null;
  done_by?: string | null;
  auto_assigned?: boolean | null;
  auto_assigned_at?: string | null;
}

/** Older rows that are finished don't belong in anyone's inbox. */
const HISTORY_DAYS = 45;
/** 1.11.0. Done and delivered tasks stay in the lists this long after they were done / delivered, then drop off. */
export const DONE_KEEP_DAYS = 7;
const DAY_MS = 86_400_000;
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

/** The automation delivered the shortlist: the state is shortlist_ready ("delivered" in the app). */
export const isDelivered = (job: Pick<JobRow, "status"> | undefined) => Boolean(job && (job.status === "completed" || job.status === "awaiting_review"));

/** When a delivered task was delivered (the job's end, else its last update); null when not delivered. */
export function deliveredAtOf(job: Pick<JobRow, "status" | "finishedAt" | "updatedAt"> | undefined): Date | null {
  if (!job || !isDelivered(job)) return null;
  return new Date(job.finishedAt ?? job.updatedAt);
}

/**
 * The "Shortlisting done" mark, when it is for the person the row is assigned to now ([assigneeEmail]
 * null = a row nobody has: a lead or admin marked it done). A reassignment clears it (assignments.ts),
 * and a mark left by the previous assignee never counts.
 */
export function doneAtFor(a: Pick<AssignmentRow, "done_at" | "assignee_email"> | undefined, assigneeEmail: string | null): Date | null {
  if (!a?.done_at) return null;
  return (a.assignee_email ?? null) === (assigneeEmail ?? null) ? new Date(a.done_at) : null;
}

/** "ise" while the server's ISE assignment stands, "app" when the current mentor took it or was assigned it in the app, else "sheet". */
export function assignedViaOf(
  a: Pick<AssignmentRow, "auto_assigned" | "assignee_email"> | undefined,
  assigneeEmail: string | null,
  appAssignee: string | null | undefined,
): AssignedVia {
  if (!assigneeEmail) return "sheet";
  if (a?.auto_assigned && a.assignee_email === assigneeEmail) return "ise";
  if (appAssignee && appAssignee === assigneeEmail) return "app";
  return "sheet";
}

/** POST /tasks/{taskId}/done: the task's mentor, leads and admins. */
export const canMarkDone = (user: Pick<RosterUser, "email" | "role">, assignee: Pick<RosterUser, "email"> | null) =>
  user.role === "admin" || user.role === "lead" || (assignee !== null && assignee.email === user.email);

/** done and delivered (shortlist_ready, shared): finished, never overdue, never nagged. */
export const isFinishedState = (s: TaskState) => s === "done" || s === "shortlist_ready" || s === "shared";

/** The Mine list's sections: 0 overdue · 1 due today (IST) · 2 upcoming · 3 no deadline · 4 done / delivered. */
export function listGroup(s: { state: TaskState; deadline: string | null }, now: Date): number {
  if (isFinishedState(s.state)) return 4;
  if (s.state === "overdue") return 0;
  if (!s.deadline) return 3;
  const d = new Date(s.deadline);
  if (d.getTime() <= now.getTime()) return 0;
  return istDay(d) === istDay(now) ? 1 : 2;
}

/**
 * The list order: overdue, due today, upcoming (each soonest deadline first), no deadline (newest
 * assignment first), then done / delivered (most recently finished first). Ties keep sheet order.
 * [finishedAt]: when a done / delivered task was done or delivered (ms).
 */
export function orderTasks<T extends { state: TaskState; deadline: string | null; assignedAt: string | null }>(
  items: { summary: T; finishedAt: number | null }[],
  now: Date,
): T[] {
  const keyed = items.map((it, i) => ({ ...it, i, group: listGroup(it.summary, now) }));
  const time = (iso: string | null, missing: number) => (iso ? Date.parse(iso) : missing);
  const diff = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);
  keyed.sort((a, b) => {
    if (a.group !== b.group) return a.group - b.group;
    let d = 0;
    if (a.group <= 2) d = diff(time(a.summary.deadline, Infinity), time(b.summary.deadline, Infinity));
    else if (a.group === 3) d = diff(time(b.summary.assignedAt, -Infinity), time(a.summary.assignedAt, -Infinity));
    else d = diff(b.finishedAt ?? -Infinity, a.finishedAt ?? -Infinity);
    return d || a.i - b.i;
  });
  return keyed.map((k) => k.summary);
}

/** Mine / team list a row unless both its assigned date and its deadline are more than HISTORY_DAYS old. */
export function inHistoryWindow(task: Pick<ControlTask, "assignedAt" | "deadline">, now: Date): boolean {
  const cutoff = now.getTime() - HISTORY_DAYS * DAY_MS;
  return !task.assignedAt || task.assignedAt.getTime() >= cutoff || !task.deadline || task.deadline.getTime() >= cutoff;
}

/** Done and delivered tasks stay listed for DONE_KEEP_DAYS after they were done / delivered; open ones always (within HISTORY_DAYS). */
export function keepInList(state: TaskState, finishedAt: number | null, now: Date): boolean {
  if (!isFinishedState(state) || finishedAt === null) return true;
  return finishedAt >= now.getTime() - DONE_KEEP_DAYS * DAY_MS;
}

/** [doneAt] (1.11.0): the done mark for the current assignee (doneAtFor); a done task is "done" whatever its job. */
export function deriveState(task: ControlTask, ackAt: string | null, job: JobRow | undefined, now = new Date(), doneAt: Date | string | null = null): TaskState {
  if (doneAt) return "done";
  let state: TaskState;
  if (job && (job.status === "pending" || job.status === "processing")) state = "screening";
  else if (job && (job.status === "completed" || job.status === "awaiting_review")) state = "shortlist_ready";
  else if (ackAt) state = "acknowledged";
  else state = "new";
  if ((state === "new" || state === "acknowledged" || state === "screening") && task.deadline && task.deadline <= now) state = "overdue";
  return state;
}

/** The 1.11.0 columns of app.assignments when migration 021 is applied ("" before it). */
export async function doneColumns(prefix = ""): Promise<string> {
  if (!(await taskDoneReady())) return "";
  return ["done_at", "done_by", "auto_assigned", "auto_assigned_at"].map((c) => `, ${prefix}${c}`).join("");
}

export async function loadAssignments(taskIds: string[]): Promise<Map<string, AssignmentRow>> {
  if (!taskIds.length) return new Map();
  const rows = await query<AssignmentRow>(
    `select task_id, ack_at, ack_by, assignee_email, job_id${await doneColumns()} from app.assignments where task_id = any($1::text[])`,
    [taskIds],
  );
  return new Map(rows.map((r) => [r.task_id, r]));
}

/**
 * Who each task was last taken by or assigned to in the app (the audit log's task_taken /
 * task_assigned), for assignedVia "app". A failure answers an empty map (the field then says "sheet").
 */
export async function loadAppAssignees(taskIds: string[]): Promise<Map<string, string>> {
  if (!taskIds.length) return new Map();
  const rows = await query<{ target: string; email: string | null }>(
    `select distinct on (target) target, case when action = 'task_taken' then actor_email else detail->>'to' end as email
       from app.audit_log where action in ('task_taken', 'task_assigned') and target = any($1::text[])
      order by target, at desc`,
    [taskIds],
  ).catch(() => [] as { target: string; email: string | null }[]);
  return new Map(rows.filter((r) => r.email).map((r) => [r.target, String(r.email).toLowerCase()]));
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * [roster] gives the ISE owner (ise.ts). An unassigned row (blank Mentor cell) is "overdue" past its
 * deadline and "new" otherwise, whatever its job or acknowledgement. 1.11.0: "done" when the
 * shortlisting was marked done for the current assignee (or, on a row nobody has, by a lead / admin).
 * [opts.appAssignee]: who the row was last taken by / assigned to in the app (assignedVia).
 */
export function toSummary(
  task: ControlTask,
  assignee: RosterUser | null,
  a: AssignmentRow | undefined,
  job: JobRow | undefined,
  roster: RosterUser[] = [],
  now = new Date(),
  opts: { appAssignee?: string | null } = {},
) {
  // An acknowledgement (and a done mark) only counts for the person it's assigned to now.
  const ackAt = a?.ack_at && a.assignee_email === assignee?.email ? new Date(a.ack_at) : null;
  const doneAt = doneAtFor(a, assignee?.email ?? null);
  const owner = iseOwnerOf(task.pc, roster);
  const state: TaskState = doneAt
    ? "done"
    : isUnassigned(task)
      ? task.deadline && task.deadline <= now
        ? "overdue"
        : "new"
      : deriveState(task, ackAt?.toISOString() ?? null, job, now);
  const via = assignedViaOf(a, assignee?.email ?? null, opts.appAssignee);
  const doneBy = doneAt && a?.done_by ? (roster.find((u) => u.email === a.done_by)?.name ?? a.done_by.split("@")[0]) : null;
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
    doneAt: iso(doneAt),
    doneBy,
    autoAssigned: via === "ise",
    assignedVia: via,
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
  opts: { appAssignee?: string | null } = {},
) {
  return {
    ...toSummary(task, assignee, a, job, roster, new Date(), opts),
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
  /** 1.11.0: who the row was last taken by / assigned to in the app (assignedVia). */
  appAssignee?: string | null;
}

export function canSee(user: RosterUser, assignee: RosterUser | null): boolean {
  return user.role === "admin" || user.role === "lead" || assignee?.email === user.email;
}

/**
 * The list for GET /tasks: my rows, everyone's with a mentor (leads and admins), or the rows nobody
 * has taken yet (scope "unassigned": anyone signed in, soonest deadline first).
 * 1.11.0: mine / team are ordered overdue, due today, upcoming, no deadline, then done / delivered
 * (most recent first); done and delivered tasks drop off DONE_KEEP_DAYS after they were finished.
 */
export async function listTasks(user: RosterUser, scope: TaskScope, fresh = false) {
  if (scope === "team" && user.role === "member") throw new UserError(403, "Only leads and admins can see the whole team.", "admin_only");
  const [snapshot, roster] = await Promise.all([readControlSnapshot(fresh), listRoster()]);
  const now = new Date();
  const picked: { task: ControlTask; assignee: RosterUser | null }[] =
    scope === "unassigned"
      ? snapshot.tasks.filter((task) => isUnassignedOpen(task, now)).sort(byDeadline).map((task) => ({ task, assignee: null }))
      : snapshot.tasks
          .map((task) => ({ task, assignee: task.mentor ? matchMentor(task.mentor, roster) : null }))
          .filter(({ assignee }) => assignee && (scope === "team" || assignee.email === user.email))
          .filter(({ task }) => inHistoryWindow(task, now));
  const ids = picked.map((x) => x.task.taskId);
  const [assignments, jobs, appAssignees] = await Promise.all([
    loadAssignments(ids),
    latestJobsFor(snapshot.spreadsheetId, snapshot.tab, picked.map((x) => x.task)),
    scope === "unassigned" ? Promise.resolve(new Map<string, string>()) : loadAppAssignees(ids),
  ]);
  const rows = picked.map(({ task, assignee }) => {
    const job = jobs.get(task.taskId);
    const summary = toSummary(task, assignee, assignments.get(task.taskId), job, roster, now, { appAssignee: appAssignees.get(task.taskId) });
    const finishedAt = summary.doneAt ? Date.parse(summary.doneAt) : (deliveredAtOf(job)?.getTime() ?? null);
    return { summary, finishedAt };
  });
  // Unassigned: soonest deadline first (as picked), without rows a lead / admin marked done.
  const tasks =
    scope === "unassigned"
      ? rows.filter((r) => r.summary.state !== "done").map((r) => r.summary)
      : orderTasks(rows.filter((r) => keepInList(r.summary.state, r.finishedAt, now)), now);
  const etag = `"${createHash("sha1").update(JSON.stringify(tasks)).digest("hex").slice(0, 16)}"`;
  return { tasks, syncedAt: snapshot.readAt.toISOString(), etag, snapshot };
}

/**
 * One task the user may see, with everything around it. 404 when it's gone or not theirs.
 * [opts.unassigned]: a row nobody has taken is visible to everyone (GET /tasks/{taskId}).
 * [opts.anyone]: no visibility check (the caller checks, e.g. POST /tasks/{taskId}/done → 403).
 */
export async function loadTask(
  user: RosterUser,
  taskId: string,
  fresh = false,
  opts: { unassigned?: boolean; anyone?: boolean } = {},
): Promise<TaskContext> {
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
  if (!opts.anyone && !canSee(user, assignee) && !(opts.unassigned && isUnassigned(task))) {
    throw new UserError(404, "This task is no longer assigned to you.", "not_found");
  }
  const [assignments, jobs, app] = await Promise.all([
    loadAssignments([task.taskId]),
    latestJobsFor(snapshot.spreadsheetId, snapshot.tab, [task]),
    loadAppAssignees([task.taskId]),
  ]);
  return { snapshot, roster, task, assignee, assignment: assignments.get(task.taskId), job: jobs.get(task.taskId), appAssignee: app.get(task.taskId) ?? null };
}

/**
 * What a write for a new assignee resets (1.11.0, migration 021): the done mark and the ISE
 * auto-assignment belong to the previous person. "" before the migration.
 */
async function resetOnNewAssignee(): Promise<string> {
  if (!(await taskDoneReady())) return "";
  const changed = "app.assignments.assignee_email is distinct from excluded.assignee_email";
  return `,
       done_at = case when ${changed} then null else app.assignments.done_at end,
       done_by = case when ${changed} then null else app.assignments.done_by end,
       auto_assigned = case when ${changed} then false else app.assignments.auto_assigned end`;
}

/** "Start now": recorded for the person the row is assigned to now. */
export async function acknowledge(ctx: TaskContext, by: RosterUser): Promise<string> {
  const rows = await query<{ ack_at: string }>(
    `insert into app.assignments (task_id, spreadsheet_id, control_tab, control_row, company, assignee_email, assignee_name,
                                  assigned_at, deadline, ack_at, ack_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)
     on conflict (task_id) do update set
       ack_at = case when app.assignments.assignee_email is distinct from excluded.assignee_email or app.assignments.ack_at is null
                     then now() else app.assignments.ack_at end${await resetOnNewAssignee()},
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
  return toDetail(ctx.task, ctx.assignee, ctx.assignment, ctx.job, sheetUrl, ctx.roster, viewer, { appAssignee: ctx.appAssignee });
}

const TASK_ID = /^[0-9a-f]{24}$/;

export async function audit(actor: string, action: string, target: string, detail: Record<string, unknown>): Promise<void> {
  await query("insert into app.audit_log (actor_email, action, target, detail) values ($1, $2, $3, $4)", [actor, action, target, JSON.stringify(detail)]).catch(
    () => undefined,
  );
}

/**
 * The context of a task whose Mentor cell was just written (no second sheet read). [viaApp]: it was
 * just taken / assigned in the app (else the audit log says how it was assigned).
 */
async function contextFor(snapshot: ControlSnapshot, roster: RosterUser[], task: ControlTask, assignee: RosterUser, viaApp = true): Promise<TaskContext> {
  const [assignments, jobs, app] = await Promise.all([
    loadAssignments([task.taskId]),
    latestJobsFor(snapshot.spreadsheetId, snapshot.tab, [task]),
    viaApp ? Promise.resolve(new Map<string, string>()) : loadAppAssignees([task.taskId]),
  ]);
  return {
    snapshot,
    roster,
    task,
    assignee,
    assignment: assignments.get(task.taskId),
    job: jobs.get(task.taskId),
    appAssignee: viaApp ? assignee.email : (app.get(task.taskId) ?? null),
  };
}

const locks = globalThis as unknown as { __taskWrites?: Map<string, Promise<unknown>> };

/**
 * Take / assign / done / the ISE auto-assignment on one task run one at a time (this server is a
 * single process): two people tapping Take together can't both read a blank cell; the second reads
 * the first one's name.
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
    if (holder?.email === me.email) return contextFor(snapshot, roster, task, holder, false);
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

// ── Shortlisting done (1.11.0) ──────────────────────────────────────────────

const short = (err: unknown) => (err instanceof Error ? err.message.slice(0, 200) : String(err));

/**
 * POST /tasks/{taskId}/done { done } (the task's mentor, leads and admins; else 403 not_your_task).
 * done: true sets done_at = now() and done_by = the caller, for the person the row is assigned to
 * now; a second call keeps the first time. done: false clears both (undo). Audit log: task_done /
 * task_reopened (on a change only). A new done mark pushes task_done to every active admin but the
 * caller (in the background; once per mark, by its dedupe key). Before migration 021: 503.
 * Returns the task's context with the assignment as stored now.
 */
export async function markDone(ctx: TaskContext, by: RosterUser, done: boolean): Promise<TaskContext> {
  if (!canMarkDone(by, ctx.assignee)) throw new UserError(403, "Only the task's mentor, leads and admins can mark it done.", "not_your_task");
  if (!(await taskDoneReady())) throw new UserError(503, "Marking a task done needs a server update that isn't installed yet. Try again later.", "not_available");
  const { task, snapshot, assignee } = ctx;
  return oneAtATime(task.taskId, async () => {
    const before = (await loadAssignments([task.taskId])).get(task.taskId);
    const wasDone = doneAtFor(before, assignee?.email ?? null);
    if (done) {
      const changed = "app.assignments.assignee_email is distinct from excluded.assignee_email";
      const rows = await query<{ done_at: string }>(
        `insert into app.assignments (task_id, spreadsheet_id, control_tab, control_row, company, assignee_email, assignee_name,
                                      assigned_at, deadline, done_at, done_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)
         on conflict (task_id) do update set
           done_at = case when ${changed} then now() else coalesce(app.assignments.done_at, now()) end,
           done_by = case when ${changed} or app.assignments.done_at is null then excluded.done_by else app.assignments.done_by end,
           ack_at = case when ${changed} then null else app.assignments.ack_at end,
           ack_by = case when ${changed} then null else app.assignments.ack_by end,
           auto_assigned = case when ${changed} then false else app.assignments.auto_assigned end,
           assignee_email = excluded.assignee_email, assignee_name = excluded.assignee_name,
           control_row = excluded.control_row, updated_at = now()
         returning done_at`,
        [task.taskId, snapshot.spreadsheetId, snapshot.tab, task.row, task.company, assignee?.email ?? null, assignee?.name ?? task.mentor, task.assignedAt, task.deadline, by.email],
      );
      if (!wasDone) {
        const doneAt = new Date(rows[0].done_at);
        await audit(by.email, "task_done", task.taskId, { company: task.company, row: task.row, assignee: assignee?.email ?? null });
        void notifyDone(ctx, by, doneAt).catch((err) => console.warn("[mobile] task_done pushes failed:", short(err)));
      }
    } else {
      const cleared = await query("update app.assignments set done_at = null, done_by = null, updated_at = now() where task_id = $1 and done_at is not null returning task_id", [
        task.taskId,
      ]);
      if (cleared.length && wasDone) await audit(by.email, "task_reopened", task.taskId, { company: task.company, row: task.row, assignee: assignee?.email ?? null });
    }
    const after = (await loadAssignments([task.taskId])).get(task.taskId);
    return { ...ctx, assignment: after };
  });
}

/** task_done → every active admin except [by]: "Rakesh finished Acme's shortlisting". */
async function notifyDone(ctx: TaskContext, by: RosterUser, doneAt: Date): Promise<number> {
  const now = Date.now();
  const text = doneText(by.name, ctx.task.company, doneAt, ctx.task.pc, now);
  let n = 0;
  for (const admin of ctx.roster.filter((u) => u.active && u.role === "admin" && u.email !== by.email)) {
    const r = await pushToUser({
      email: admin.email,
      kind: "task_done",
      taskId: ctx.task.taskId,
      dedupeKey: taskDedupe.done(ctx.task.taskId, doneAt, admin.email),
      data: { taskId: ctx.task.taskId, company: ctx.task.company, by: by.name, title: text.title, body: text.body },
    }).catch((err) => {
      console.warn("[mobile] task_done push failed:", short(err));
      return null;
    });
    if (r && !r.skipped) n++;
  }
  return n;
}
