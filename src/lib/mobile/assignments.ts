import "server-only";
import { query } from "@/lib/db/client";
import type { JobRow } from "@/lib/automation/store";
import { autoAssignStep } from "@/lib/mobile/auto-assign";
import { type ControlSnapshot, type ControlTask, readControlSnapshot } from "@/lib/mobile/control-rows";
import { iseOwnerOf } from "@/lib/mobile/ise";
import { latestJobsFor } from "@/lib/mobile/jobs";
import { pushToUser } from "@/lib/mobile/push";
import { listRoster, matchMentor, type RosterUser } from "@/lib/mobile/roster";
import {
  digestSlot,
  iseAssignText,
  istClock,
  nudgeText,
  STALE_MS,
  taskDedupe,
  taskDigestText,
  taskNudge,
  type DigestSlot,
  type NudgeSlot,
  type SoonSlot,
} from "@/lib/mobile/task-nudges";
import { taskDoneReady } from "@/lib/mobile/task-schema";
import { deriveState, inHistoryWindow, isDelivered, isFinishedState, isUnassignedOpen, listGroup, type TaskState } from "@/lib/mobile/tasks";

export { istClock };

/**
 * Turns the Mentor column into pushes (docs/decisions/0002 in the app repo), every minute on the
 * server (ticker.ts) and after every task-list refresh:
 *   - 1.11.0: blank Mentor cells whose ISE maps to a mentor are filled first (auto-assign.ts);
 *   - a row newly assigned (or reassigned) to someone → "assignment" to that person (ISE-assigned
 *     rows say "Assigned to you as <ISE>'s mentor (ISE)");
 *   - 1.11.0 (task-nudges.ts): not started 30 and 90 min after that push → reminder nudge:30 /
 *     nudge:90; 1 h and 15 min before the deadline → reminder soon1h / soon15; at the deadline,
 *     then every 2 h (at most 4) → overdue:<0-3>;
 *   - 30 minutes past the deadline, not started → one escalation to the person's lead, else the admins;
 *   - 1.11.0: task_digest at 09:15 and 18:00 IST to each active member with open tasks.
 * Done tasks ("Shortlisting done") and delivered ones (the automation's shortlist) get nothing but
 * their job news. Old rows never alert: a deadline more than a day ago is history.
 * Rows with a blank Mentor cell get "task_unassigned" pushes (unassignedPushes below).
 */

const ESCALATE_AFTER_MS = 30 * 60_000;
/** "New task" goes out for rows assigned this recently (the first sync after a deploy replays nothing older). */
const UNASSIGNED_NEW_MS = 6 * 3_600_000;
const UNASSIGNED_SOON_MS = 30 * 60_000;

interface Stored {
  task_id: string;
  assignee_email: string | null;
  ack_at: string | null;
  done_at?: string | null;
  auto_assigned?: boolean | null;
}

const g = globalThis as unknown as { __mobileSyncRunning?: boolean; __taskDigestSent?: string };
const short = (err: unknown) => (err instanceof Error ? err.message.slice(0, 200) : String(err));

/** An assigned, open task whose reminder slots are worked out after the loop (one batch read). */
interface SlotCandidate {
  task: ControlTask;
  assignee: RosterUser;
  started: boolean;
  /** Its assignment push went out in this pass. */
  toldNow: boolean;
  data: Record<string, string>;
}

/** One assigned row as the lists show it (for the digest). */
export interface StateRow {
  email: string;
  task: ControlTask;
  state: TaskState;
}

export async function syncAssignments(snapshot?: ControlSnapshot): Promise<{ checked: number; pushed: number }> {
  if (g.__mobileSyncRunning) return { checked: 0, pushed: 0 };
  g.__mobileSyncRunning = true;
  try {
    let snap = snapshot ?? (await readControlSnapshot(true));
    const roster = await listRoster();
    const now = Date.now();
    // Blank Mentor cells whose ISE maps to a mentor are filled first (never throws; off before 021).
    const auto = await autoAssignStep(snap, roster, now);
    if (auto.assigned.size) snap = { ...snap, tasks: snap.tasks.map((t) => auto.assigned.get(t.taskId) ?? t) };
    const doneReady = await taskDoneReady();
    // Rows nobody has taken: a failure here never stops the assigned rows' pushes.
    const open = await unassignedPushes(snap, roster, now, auto.hold, doneReady).catch((err) => {
      console.warn("[mobile] unassigned task pushes failed:", short(err));
      return { checked: 0, pushed: 0 };
    });
    const assigned = snap.tasks
      .map((task) => ({ task, assignee: task.mentor ? matchMentor(task.mentor, roster) : null }))
      .filter((x): x is { task: (typeof snap.tasks)[number]; assignee: RosterUser } => x.assignee !== null);
    if (!assigned.length) return open;

    const stored = new Map(
      (
        await query<Stored>(`select task_id, assignee_email, ack_at${doneReady ? ", done_at, auto_assigned" : ""} from app.assignments where task_id = any($1::text[])`, [
          assigned.map((x) => x.task.taskId),
        ])
      ).map((r) => [r.task_id, r]),
    );
    const jobs = await latestJobsFor(snap.spreadsheetId, snap.tab, assigned.map((x) => x.task));
    let pushed = open.pushed;
    const pending: SlotCandidate[] = [];
    const states: StateRow[] = [];
    // A reassignment clears the acknowledgement, and (1.11.0) the done mark and the ISE assignment.
    const reset = doneReady
      ? `, done_at = case when $10 then null else app.assignments.done_at end,
           done_by = case when $10 then null else app.assignments.done_by end,
           auto_assigned = case when $10 then false else app.assignments.auto_assigned end`
      : "";

    for (const { task, assignee } of assigned) {
      const prev = stored.get(task.taskId);
      const reassigned = Boolean(prev && prev.assignee_email !== assignee.email);
      await query(
        `insert into app.assignments (task_id, spreadsheet_id, control_tab, control_row, company, assignee_email, assignee_name, assigned_at, deadline)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (task_id) do update set control_row = excluded.control_row, company = excluded.company,
           assignee_email = excluded.assignee_email, assignee_name = excluded.assignee_name,
           assigned_at = excluded.assigned_at, deadline = excluded.deadline,
           ack_at = case when $10 then null else app.assignments.ack_at end,
           ack_by = case when $10 then null else app.assignments.ack_by end${reset},
           updated_at = now()`,
        [task.taskId, snap.spreadsheetId, snap.tab, task.row, task.company, assignee.email, assignee.name, task.assignedAt, task.deadline, reassigned],
      );

      const job = jobs.get(task.taskId);
      if (job) pushed += await jobUpdates(job, task.taskId, assignee);
      const acked = !reassigned && Boolean(prev?.ack_at);
      const doneAt = !reassigned && prev?.done_at ? new Date(prev.done_at) : null;
      const deadline = task.deadline?.getTime() ?? null;
      states.push({ email: assignee.email, task, state: deriveState(task, acked ? (prev?.ack_at ?? null) : null, job, new Date(now), doneAt) });
      // Done, delivered or history: nothing but the job news above.
      if (doneAt || isDelivered(job) || (deadline !== null && deadline < now - STALE_MS)) continue;

      const data: Record<string, string> = {
        taskId: task.taskId,
        company: task.company,
        profilesRequired: String(task.profilesRequired),
        ...(task.deadline ? { deadline: task.deadline.toISOString() } : {}),
      };
      const key = (k: string) => taskDedupe.slot(k, task.taskId, assignee.email);
      // New to this person: tell them, whatever the deadline (unless it's long past).
      const viaIse = !reassigned && Boolean(prev?.auto_assigned);
      const assignData = viaIse ? { ...data, assignedVia: "ise", ise: task.pc, ...iseAssignText(task.company, task.pc) } : data;
      const r = await pushToUser({ email: assignee.email, kind: "assignment", data: assignData, dedupeKey: key("assign"), taskId: task.taskId });
      if (!r.skipped) pushed++;

      const started = acked || Boolean(job);
      if (deadline !== null && !started && now >= deadline + ESCALATE_AFTER_MS) pushed += await escalate(task.taskId, data, assignee, roster);
      pending.push({ task, assignee, started, toldNow: !r.skipped, data });
    }

    pushed += await slotPushes(pending, now).catch((err) => {
      console.warn("[mobile] task reminder pushes failed:", short(err));
      return 0;
    });
    pushed += await taskDigests(states, roster, now).catch((err) => {
      console.warn("[mobile] task digest failed:", short(err));
      return 0;
    });
    return { checked: assigned.length + open.checked, pushed };
  } finally {
    g.__mobileSyncRunning = false;
  }
}

// ── 1.11.0 reminder slots ───────────────────────────────────────────────────

export interface PlannedSlot {
  kind: "reminder" | "overdue";
  slot: NudgeSlot | SoonSlot | `overdue:${number}`;
  key: string;
  /** The 1.10 key that already stands for this push (soon15 ← "soon", overdue:0 ← "overdue"). */
  legacyKey: string | null;
}

/** The reminder pushes due at [now] for an open assigned task, with their dedupe keys (pure). */
export function plannedSlots(
  c: { taskId: string; email: string; deadline: number | null; toldAt: number | null; started: boolean },
  now: number,
): PlannedSlot[] {
  const n = taskNudge({ now, deadline: c.deadline, toldAt: c.toldAt, started: c.started, finished: false });
  const key = (s: string) => taskDedupe.slot(s, c.taskId, c.email);
  const out: PlannedSlot[] = [];
  if (n.nudge) out.push({ kind: "reminder", slot: n.nudge, key: key(n.nudge), legacyKey: null });
  if (n.reminder) out.push({ kind: "reminder", slot: n.reminder, key: key(n.reminder), legacyKey: n.reminder === "soon15" ? key("soon") : null });
  if (n.overdueSlot !== null) {
    const slot = `overdue:${n.overdueSlot}` as const;
    out.push({ kind: "overdue", slot, key: key(slot), legacyKey: n.overdueSlot === 0 ? key("overdue") : null });
  }
  return out;
}

/** Sends the nudge / soon / overdue pushes due now: one read for the assignment times, one for the keys already sent. */
async function slotPushes(pending: SlotCandidate[], now: number): Promise<number> {
  if (!pending.length) return 0;
  const assignKey = (c: SlotCandidate) => taskDedupe.slot("assign", c.task.taskId, c.assignee.email);
  const toldKeys = pending.filter((c) => !c.toldNow).map(assignKey);
  const told = new Map(
    toldKeys.length
      ? (await query<{ dedupe_key: string; at: Date }>("select dedupe_key, at from app.notifications where dedupe_key = any($1::text[])", [toldKeys])).map((r) => [
          r.dedupe_key,
          new Date(r.at).getTime(),
        ])
      : [],
  );
  const plans = pending.flatMap((c) =>
    plannedSlots(
      {
        taskId: c.task.taskId,
        email: c.assignee.email,
        deadline: c.task.deadline?.getTime() ?? null,
        toldAt: c.toldNow ? now : (told.get(assignKey(c)) ?? null),
        started: c.started,
      },
      now,
    ).map((p) => ({ c, p })),
  );
  if (!plans.length) return 0;
  const keys = plans.flatMap(({ p }) => (p.legacyKey ? [p.key, p.legacyKey] : [p.key]));
  const sent = new Set((await query<{ dedupe_key: string }>("select dedupe_key from app.notifications where dedupe_key = any($1::text[])", [keys])).map((r) => r.dedupe_key));
  let n = 0;
  for (const { c, p } of plans) {
    if (sent.has(p.key) || (p.legacyKey && sent.has(p.legacyKey))) continue;
    const text = nudgeText(p.slot, c.task, now);
    const r = await pushToUser({
      email: c.assignee.email,
      kind: p.kind,
      data: { ...c.data, slot: p.slot, title: text.title, body: text.body },
      dedupeKey: p.key,
      taskId: c.task.taskId,
    }).catch((err) => {
      console.warn(`[mobile] ${p.slot} push failed:`, short(err));
      return null;
    });
    if (r && !r.skipped) n++;
  }
  return n;
}

// ── 1.11.0 task digest ──────────────────────────────────────────────────────

/** One person's open tasks in list order (overdue, due today, upcoming, no deadline), for the digest (pure). */
export function openForDigest(rows: StateRow[], email: string, now: number): { company: string; group: number }[] {
  const at = new Date(now);
  return rows
    .filter((r) => r.email === email && !isFinishedState(r.state) && inHistoryWindow(r.task, at))
    .map((r) => ({
      company: r.task.company,
      group: listGroup({ state: r.state, deadline: r.task.deadline?.toISOString() ?? null }, at),
      deadline: r.task.deadline?.getTime() ?? Number.POSITIVE_INFINITY,
      row: r.task.row,
    }))
    .sort((a, b) => a.group - b.group || (a.deadline === b.deadline ? a.row - b.row : a.deadline < b.deadline ? -1 : 1))
    .map(({ company, group }) => ({ company, group }));
}

/** task_digest at 09:15 and 18:00 IST, once per slot per person, only to active members with open tasks. */
async function taskDigests(rows: StateRow[], roster: RosterUser[], now: number): Promise<number> {
  const due = digestSlot(now);
  if (!due) return 0;
  const mark = `${due.slot}:${due.day}`;
  if (g.__taskDigestSent === mark) return 0;
  let sent = 0;
  for (const u of roster.filter((r) => r.active)) {
    const text = taskDigestText(due.slot as DigestSlot, openForDigest(rows, u.email, now));
    if (!text) continue;
    const r = await pushToUser({
      email: u.email,
      kind: "task_digest",
      dedupeKey: taskDedupe.digest(due.slot, due.day, u.email),
      data: { day: due.day, slot: due.slot, title: text.title, body: text.body, count: String(text.count) },
    }).catch((err) => {
      console.warn("[mobile] task digest push failed:", short(err));
      return null;
    });
    if (r && !r.skipped) sent++;
  }
  g.__taskDigestSent = mark;
  return sent;
}

// ── Rows nobody has taken (a blank Mentor cell) ─────────────────────────────

/** new: to everyone · half / soon: reminders to the ISE's mentor and the admins · due: the deadline passed. */
export type UnassignedStage = "new" | "half" | "soon" | "due";

/**
 * The task_unassigned pushes due at [now] for an unassigned row (each is then sent once, by its
 * dedupe key):
 *   - new: assigned in the last 6 hours, deadline not passed;
 *   - half: half the time between assigned and deadline gone; soon: 30 minutes left; due: the
 *     deadline passed (less than a day ago, like the assigned rows' STALE). One window at a time:
 *     a row first seen with 20 minutes left gets "soon", never also "half".
 */
export function unassignedStages(task: Pick<ControlTask, "assignedAt" | "deadline">, now: number): UnassignedStage[] {
  const out: UnassignedStage[] = [];
  const assigned = task.assignedAt?.getTime() ?? null;
  const deadline = task.deadline?.getTime() ?? null;
  if (assigned !== null && assigned >= now - UNASSIGNED_NEW_MS && (deadline === null || now < deadline)) out.push("new");
  if (deadline === null) return out;
  if (now >= deadline) {
    if (now - deadline <= STALE_MS) out.push("due");
  } else if (deadline - now <= UNASSIGNED_SOON_MS) {
    out.push("soon");
  } else if (assigned !== null && assigned < deadline && now >= assigned + (deadline - assigned) / 2) {
    out.push("half");
  }
  return out;
}

/** The push's title and body (also the inbox line). */
export function unassignedText(stage: UnassignedStage, task: Pick<ControlTask, "company" | "pc" | "profilesRequired" | "deadline">, now: number) {
  const ise = task.pc.trim();
  const due = task.deadline ? istClock(task.deadline, now) : "";
  if (stage === "new") {
    const n = task.profilesRequired;
    const what = n ? `${n} profile${n === 1 ? "" : "s"}` : "Profiles";
    return {
      title: `New task · ${task.company}${ise ? ` (ISE ${ise})` : ""}`,
      body: `${what}${due ? ` by ${due}` : ""} · no mentor yet. Tap to take it.`,
    };
  }
  if (stage === "due") return { title: `Deadline passed · ${task.company}`, body: `Nobody took ${ise ? `${ise}'s` : "this"} task.` };
  return {
    title: `Still no mentor · ${task.company}`,
    body: `${ise ? `${ise}'s task` : "This task"}${due ? ` · due ${due}` : ""}. Take it or assign someone.`,
  };
}

/** Who gets a stage: "new" → every active roster member; reminders and "due" → the ISE's mentor and the admins. */
export function unassignedRecipients(stage: UnassignedStage, owner: RosterUser | null, roster: RosterUser[]): RosterUser[] {
  const active = roster.filter((u) => u.active);
  if (stage === "new") return active;
  const out = active.filter((u) => u.role === "admin");
  if (owner?.active && !out.some((u) => u.email === owner.email)) out.unshift(owner);
  return out;
}

/**
 * One pass over the rows nobody has taken (the same rows GET /tasks?scope=unassigned lists).
 * 1.11.0: rows about to be auto-assigned by their ISE ([hold]) wait, and rows a lead / admin marked
 * done get nothing.
 */
async function unassignedPushes(
  snap: ControlSnapshot,
  roster: RosterUser[],
  now: number,
  hold: Set<string> = new Set(),
  doneReady = false,
): Promise<{ checked: number; pushed: number }> {
  let open = snap.tasks.filter((t) => isUnassignedOpen(t, new Date(now)) && !hold.has(t.taskId));
  if (doneReady && open.length) {
    const done = new Set(
      (
        await query<{ task_id: string }>("select task_id from app.assignments where task_id = any($1::text[]) and assignee_email is null and done_at is not null", [
          open.map((t) => t.taskId),
        ])
      ).map((r) => r.task_id),
    );
    if (done.size) open = open.filter((t) => !done.has(t.taskId));
  }
  const planned: { key: string; email: string; taskId: string; data: Record<string, string> }[] = [];
  for (const task of open) {
    const stages = unassignedStages(task, now);
    if (!stages.length) continue;
    const owner = iseOwnerOf(task.pc, roster);
    for (const stage of stages) {
      const text = unassignedText(stage, task, now);
      const data: Record<string, string> = {
        taskId: task.taskId,
        company: task.company,
        profilesRequired: String(task.profilesRequired),
        ...(task.deadline ? { deadline: task.deadline.toISOString() } : {}),
        ise: task.pc,
        iseOwner: owner?.name ?? "",
        product: task.product,
        stage: stage === "half" || stage === "soon" ? "reminder" : stage,
        title: text.title,
        body: text.body,
      };
      for (const u of unassignedRecipients(stage, owner, roster)) {
        planned.push({ key: `unassigned:${stage}:${task.taskId}:${u.email}`, email: u.email, taskId: task.taskId, data });
      }
    }
  }
  if (!planned.length) return { checked: open.length, pushed: 0 };
  // One read for the keys already sent, instead of one insert attempt per person per minute.
  const sent = new Set(
    (await query<{ dedupe_key: string }>("select dedupe_key from app.notifications where dedupe_key = any($1::text[])", [planned.map((p) => p.key)])).map(
      (r) => r.dedupe_key,
    ),
  );
  let pushed = 0;
  for (const p of planned) {
    if (sent.has(p.key)) continue;
    const r = await pushToUser({ email: p.email, kind: "task_unassigned", data: p.data, dedupeKey: p.key, taskId: p.taskId });
    if (!r.skipped) pushed++;
  }
  return { checked: open.length, pushed };
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
