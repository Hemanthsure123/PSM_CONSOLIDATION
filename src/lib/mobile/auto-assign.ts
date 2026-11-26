import "server-only";
import { query } from "@/lib/db/client";
import { type ControlSnapshot, type ControlTask, readTaskFresh, writeMentorCell } from "@/lib/mobile/control-rows";
import { iseOwnerOf, iseOwnersFromEnv } from "@/lib/mobile/ise";
import type { RosterUser } from "@/lib/mobile/roster";
import { taskDoneReady } from "@/lib/mobile/task-schema";
import { audit, byDeadline, isUnassigned, isUnassignedOpen, oneAtATime } from "@/lib/mobile/tasks";

/**
 * Automatic assignment by ISE (PSM 1.11.0). Each minute (assignments.ts), an open row with a blank
 * Mentor cell (isUnassignedOpen) whose ISE (the PC column) maps to an active roster mentor
 * (ise.ts: Sneha → Gaurav, Akanksha → Rakesh, Vishaal → Faraaz; MOBILE_ISE_OWNERS overrides) gets
 * that mentor's roster name written into its Mentor cell:
 *   - only after a grace period of 5 minutes past the later of the row's assigned time and the
 *     moment the server first saw it blank for that mentor, so a PC filling the cell by hand wins;
 *   - the row is read again first (readTaskFresh: found by its task id) and written only if the
 *     cell is still blank and the ISE still maps to the same mentor (writeMentorCell: one cell);
 *   - at most 10 writes a minute, one run at a time, each under the task's oneAtATime lock (so it
 *     never races a Take / Assign from the app);
 *   - a row is auto-assigned at most once (auto_assigned_at): a cell someone empties again is left
 *     to people; a row a lead / admin marked done is left alone;
 *   - a write failure is logged and the rest waits for the next tick; nothing here ever throws into
 *     the rest of the sync.
 * Off with MOBILE_ISE_AUTO_ASSIGN=off, and until migration 021 exists. The mentor then gets the
 * usual "assignment" push ("Assigned to you as <ISE>'s mentor (ISE)").
 */

const M = 60_000;
export const AUTO_ASSIGN_GRACE_MS = 5 * M;
/** Past the grace period, a row still blank (the write failed, or waits behind the cap) gets the usual task_unassigned pushes. */
export const AUTO_ASSIGN_HOLD_MS = 15 * M;
export const AUTO_ASSIGN_MAX_PER_TICK = 10;

/** On unless MOBILE_ISE_AUTO_ASSIGN is off / false / 0 / no. */
export const autoAssignEnabled = (value = process.env.MOBILE_ISE_AUTO_ASSIGN) => !/^(off|false|0|no|disabled?)$/i.test(String(value ?? "").trim());

export interface AutoCandidate {
  task: ControlTask;
  owner: RosterUser;
  /** The first-seen key: the task and the mentor it maps to. */
  key: string;
  /** The later of the row's assigned time and when the server first saw it blank for this mentor (ms). */
  anchor: number;
}

export interface AutoPlan {
  /** Past the grace period, soonest deadline first, at most [max]. */
  write: AutoCandidate[];
  /** Past the grace period but over the cap: next minute. */
  deferred: AutoCandidate[];
  /** Still inside the grace period. */
  waiting: AutoCandidate[];
  /** Every candidate's first-seen key, to keep (others can be forgotten). */
  keys: string[];
}

/**
 * Which rows to auto-assign at [now] (pure). [firstSeen]: when each candidate key was first seen
 * (missing = now). [skip]: task ids auto-assigned before, or marked done while nobody had them.
 */
export function autoAssignPlan(
  tasks: ControlTask[],
  roster: RosterUser[],
  now: number,
  opts: { firstSeen: Map<string, number>; skip: Set<string>; owners?: Map<string, string>; max?: number },
): AutoPlan {
  const owners = opts.owners ?? iseOwnersFromEnv();
  const max = opts.max ?? AUTO_ASSIGN_MAX_PER_TICK;
  const due: AutoCandidate[] = [];
  const waiting: AutoCandidate[] = [];
  const keys: string[] = [];
  for (const task of tasks) {
    if (opts.skip.has(task.taskId) || !isUnassignedOpen(task, new Date(now))) continue;
    // Only tasks still ahead of their deadline: assigning one that is already late would hand the
    // mentor an "overdue" and their lead an escalation at once. Late rows keep the unassigned flow
    // ("Deadline passed" to the ISE's mentor and the admins).
    if (task.deadline && task.deadline.getTime() <= now) continue;
    const owner = iseOwnerOf(task.pc, roster, owners);
    if (!owner?.active) continue;
    const key = `${task.taskId}|${owner.email}`;
    keys.push(key);
    const anchor = Math.max(task.assignedAt?.getTime() ?? 0, opts.firstSeen.get(key) ?? now);
    (now >= anchor + AUTO_ASSIGN_GRACE_MS ? due : waiting).push({ task, owner, key, anchor });
  }
  due.sort((a, b) => byDeadline(a.task, b.task));
  return { write: due.slice(0, Math.max(0, max)), deferred: due.slice(Math.max(0, max)), waiting, keys };
}

/** A candidate whose task_unassigned pushes wait: it is about to be auto-assigned (pure). */
export const holdsUnassignedPushes = (c: Pick<AutoCandidate, "anchor">, now: number) => now < c.anchor + AUTO_ASSIGN_HOLD_MS;

export interface AutoAssignResult {
  /** The rows written this tick (their task as read fresh, with the mentor's name in it). */
  assigned: Map<string, ControlTask>;
  /** Task ids whose task_unassigned pushes wait (about to be auto-assigned). */
  hold: Set<string>;
  candidates: number;
}

const EMPTY = (): AutoAssignResult => ({ assigned: new Map(), hold: new Set(), candidates: 0 });
const g = globalThis as unknown as { __autoAssignRunning?: boolean; __autoAssignSeen?: Map<string, number> };
const short = (err: unknown) => (err instanceof Error ? err.message.slice(0, 200) : String(err));

/** One auto-assignment pass over [snap]. Never throws. */
export async function autoAssignStep(snap: ControlSnapshot, roster: RosterUser[], now = Date.now()): Promise<AutoAssignResult> {
  if (!autoAssignEnabled() || g.__autoAssignRunning) return EMPTY();
  g.__autoAssignRunning = true;
  try {
    if (!(await taskDoneReady())) return EMPTY();
    const open = snap.tasks.filter((t) => isUnassignedOpen(t, new Date(now)) && iseOwnerOf(t.pc, roster)?.active);
    if (!open.length) {
      g.__autoAssignSeen = new Map();
      return EMPTY();
    }
    const stored = await query<{ task_id: string }>(
      `select task_id from app.assignments
        where task_id = any($1::text[]) and (auto_assigned_at is not null or (done_at is not null and assignee_email is null))`,
      [open.map((t) => t.taskId)],
    );
    const seen = (g.__autoAssignSeen ??= new Map());
    const plan = autoAssignPlan(open, roster, now, { firstSeen: seen, skip: new Set(stored.map((r) => r.task_id)) });
    // Remember when each candidate was first seen; forget the rest (bounded by the open rows).
    const next = new Map<string, number>();
    for (const k of plan.keys) next.set(k, seen.get(k) ?? now);
    g.__autoAssignSeen = next;
    const hold = new Set([...plan.write, ...plan.deferred, ...plan.waiting].filter((c) => holdsUnassignedPushes(c, now)).map((c) => c.task.taskId));
    const assigned = new Map<string, ControlTask>();
    for (const c of plan.write) {
      try {
        const done = await oneAtATime(c.task.taskId, () => writeOne(c, roster));
        if (done) {
          assigned.set(done.taskId, done);
          hold.delete(done.taskId);
        }
      } catch (err) {
        console.warn(`[mobile] ISE auto-assign of row ${c.task.row} failed (retried next minute):`, short(err));
        break;
      }
    }
    if (assigned.size) console.log(`[mobile] ISE auto-assign: ${assigned.size} row(s) assigned (${plan.deferred.length} waiting for the next minute)`);
    return { assigned, hold, candidates: plan.keys.length };
  } catch (err) {
    console.warn("[mobile] ISE auto-assign step failed:", short(err));
    return EMPTY();
  } finally {
    g.__autoAssignRunning = false;
  }
}

/** Re-read, check, write one cell, record. Null when the row changed (someone filled it, it moved away, the ISE changed). */
async function writeOne(c: AutoCandidate, roster: RosterUser[]): Promise<ControlTask | null> {
  const fresh = await readTaskFresh(c.task.taskId);
  if (!fresh || !isUnassigned(fresh.task)) return null;
  const owner = iseOwnerOf(fresh.task.pc, roster);
  if (!owner?.active || owner.email !== c.owner.email) return null;
  await writeMentorCell(fresh.snapshot, fresh.task, owner.name);
  const task: ControlTask = { ...fresh.task, mentor: owner.name };
  const changed = "app.assignments.assignee_email is distinct from excluded.assignee_email";
  await query(
    `insert into app.assignments (task_id, spreadsheet_id, control_tab, control_row, company, assignee_email, assignee_name, assigned_at, deadline,
                                  auto_assigned, auto_assigned_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, now())
     on conflict (task_id) do update set
       ack_at = case when ${changed} then null else app.assignments.ack_at end,
       ack_by = case when ${changed} then null else app.assignments.ack_by end,
       done_at = case when ${changed} then null else app.assignments.done_at end,
       done_by = case when ${changed} then null else app.assignments.done_by end,
       assignee_email = excluded.assignee_email, assignee_name = excluded.assignee_name, control_row = excluded.control_row,
       company = excluded.company, assigned_at = excluded.assigned_at, deadline = excluded.deadline,
       auto_assigned = true, auto_assigned_at = coalesce(app.assignments.auto_assigned_at, now()), updated_at = now()`,
    [task.taskId, fresh.snapshot.spreadsheetId, fresh.snapshot.tab, task.row, task.company, owner.email, owner.name, task.assignedAt, task.deadline],
  ).catch((err) => console.warn(`[mobile] ISE auto-assign of row ${task.row}: written to the sheet, not recorded:`, short(err)));
  await audit("system:ise-auto-assign", "task_auto_assigned", task.taskId, { company: task.company, row: task.row, to: owner.email, ise: task.pc });
  return task;
}
