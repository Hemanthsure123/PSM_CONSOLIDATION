import "server-only";
import { query } from "@/lib/db/client";
import type { JobRow } from "@/lib/automation/store";
import { type ControlSnapshot, type ControlTask, readControlSnapshot } from "@/lib/mobile/control-rows";
import { iseOwnerOf } from "@/lib/mobile/ise";
import { latestJobsFor } from "@/lib/mobile/jobs";
import { pushToUser } from "@/lib/mobile/push";
import { listRoster, matchMentor, type RosterUser } from "@/lib/mobile/roster";
import { isUnassignedOpen } from "@/lib/mobile/tasks";

/**
 * Turns the Mentor column into pushes (docs/decisions/0002 in the app repo):
 *   - a row newly assigned (or reassigned) to someone → "assignment" to that person;
 *   - half the time gone, 15 minutes left, past the deadline → one reminder each;
 *   - 30 minutes past the deadline → one escalation to the person's lead, else the admins.
 * A row that was acknowledged ("Start now") or already has a screening job gets no reminders.
 * Old rows never alert: a deadline more than a day ago, or a finished job, is history.
 * Rows with a blank Mentor cell get "task_unassigned" pushes (unassignedPushes below).
 * Runs every minute on the server (ticker.ts) and after every task-list refresh.
 */

const DUE_SOON_MS = 15 * 60_000;
const ESCALATE_AFTER_MS = 30 * 60_000;
const STALE_MS = 24 * 3_600_000;
/** "New task" goes out for rows assigned this recently (the first sync after a deploy replays nothing older). */
const UNASSIGNED_NEW_MS = 6 * 3_600_000;
const UNASSIGNED_SOON_MS = 30 * 60_000;

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
    // Rows nobody has taken: a failure here never stops the assigned rows' pushes.
    const open = await unassignedPushes(snap, roster, Date.now()).catch((err) => {
      console.warn("[mobile] unassigned task pushes failed:", err instanceof Error ? err.message.slice(0, 200) : err);
      return { checked: 0, pushed: 0 };
    });
    const assigned = snap.tasks
      .map((task) => ({ task, assignee: task.mentor ? matchMentor(task.mentor, roster) : null }))
      .filter((x): x is { task: (typeof snap.tasks)[number]; assignee: RosterUser } => x.assignee !== null);
    if (!assigned.length) return open;

    const stored = new Map(
      (await query<Stored>("select task_id, assignee_email, ack_at from app.assignments where task_id = any($1::text[])", [
        assigned.map((x) => x.task.taskId),
      ])).map((r) => [r.task_id, r]),
    );
    const jobs = await latestJobsFor(snap.spreadsheetId, snap.tab, assigned.map((x) => x.task));
    const now = Date.now();
    let pushed = open.pushed;

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
    return { checked: assigned.length + open.checked, pushed };
  } finally {
    g.__mobileSyncRunning = false;
  }
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IST_MS = 5.5 * 3_600_000;

/** "6:00 PM" (IST) on [now]'s IST day, else "27 Nov, 6:00 PM". */
export function istClock(at: Date, now: number): string {
  const ist = new Date(at.getTime() + IST_MS);
  const h = ist.getUTCHours();
  const clock = `${h % 12 || 12}:${String(ist.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  const sameDay = ist.toISOString().slice(0, 10) === new Date(now + IST_MS).toISOString().slice(0, 10);
  return sameDay ? clock : `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]}, ${clock}`;
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

/** One pass over the rows nobody has taken (the same rows GET /tasks?scope=unassigned lists). */
async function unassignedPushes(snap: ControlSnapshot, roster: RosterUser[], now: number): Promise<{ checked: number; pushed: number }> {
  const open = snap.tasks.filter((t) => isUnassignedOpen(t, new Date(now)));
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
