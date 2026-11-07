import "server-only";
import type { JobRow } from "@/lib/automation/store";
import { type ControlTask, readControlSnapshot } from "@/lib/mobile/control-rows";
import { UserError } from "@/lib/mobile/http";
import { latestJobsFor } from "@/lib/mobile/jobs";
import { listRoster, matchMentor, type RosterUser } from "@/lib/mobile/roster";
import { loadAssignments } from "@/lib/mobile/tasks";

/**
 * GET /analytics: what happened to the control sheet's rows in a date range, from the real sheet
 * and the real screening jobs (no estimates). A row belongs to the range by its Assigned Date &
 * Time (or its deadline when that's empty). Members see their own rows; leads and admins see the
 * team, including rows nobody has been assigned yet.
 */

export interface AnalyticsRow {
  taskId: string;
  company: string;
  mentor: string | null;
  mentorEmail: string | null;
  profilesRequired: number;
  assignedAt: string | null;
  deadline: string | null;
  acknowledgedAt: string | null;
  jobStatus: string | null;
  profilesRead: number | null;
  shortlisted: number | null;
  deliveredAt: string | null;
  minutesToShortlist: number | null;
  onTime: boolean | null;
  shortlistUrl: string | null;
  sheetRowUrl: string;
}

export interface MemberStats {
  name: string;
  email: string | null;
  tasks: number;
  started: number;
  delivered: number;
  onTime: number;
  overdue: number;
}

const DONE = new Set(["completed", "awaiting_review"]);
const RUNNING = new Set(["pending", "processing"]);
const MAX_DAYS = 365;

/** When the shortlist reached the sheet: the early delivery, else the job's end. */
function deliveredAt(job: JobRow | undefined): Date | null {
  if (!job) return null;
  if (DONE.has(job.status) && job.finishedAt) return new Date(job.finishedAt);
  if (job.progress?.shortlistUrl) return new Date(job.updatedAt);
  return null;
}

export function rowStats(
  task: ControlTask,
  assignee: RosterUser | null,
  job: JobRow | undefined,
  ackAt: string | null,
  sheetUrl: string,
  now = new Date(),
): AnalyticsRow {
  const delivered = deliveredAt(job);
  const started = job ? new Date(job.createdAt) : null;
  // A delivered shortlist is judged against the deadline. An undelivered row only counts as late
  // when someone was assigned it here: rows handled by hand before the app have no job to show.
  let onTime: boolean | null = null;
  if (task.deadline && delivered) onTime = delivered.getTime() <= task.deadline.getTime();
  else if (task.deadline && assignee && task.deadline.getTime() < now.getTime()) onTime = false;
  return {
    taskId: task.taskId,
    company: task.company,
    mentor: assignee?.name ?? (task.mentor || null),
    mentorEmail: assignee?.email ?? null,
    profilesRequired: task.profilesRequired,
    assignedAt: task.assignedAt?.toISOString() ?? null,
    deadline: task.deadline?.toISOString() ?? null,
    acknowledgedAt: ackAt,
    jobStatus: job?.status ?? null,
    profilesRead: job ? (job.result?.read ?? job.progress?.read ?? null) : null,
    shortlisted: job ? (job.result?.shortlisted ?? job.progress?.shortlistCount ?? null) : null,
    deliveredAt: delivered?.toISOString() ?? null,
    minutesToShortlist: delivered && started ? Math.max(0, Math.round((delivered.getTime() - started.getTime()) / 60_000)) : null,
    onTime,
    shortlistUrl: job ? (job.progress?.shortlistUrl ?? job.result?.destinationUrl ?? null) : null,
    sheetRowUrl: `${sheetUrl}&range=A${task.row}`,
  };
}

/** Assigned in the app, past the deadline, no shortlist yet. */
const isOverdue = (r: AnalyticsRow, now: Date) => Boolean(r.mentorEmail && !r.deliveredAt && r.deadline && new Date(r.deadline) < now);

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function summarize(rows: AnalyticsRow[], now = new Date()) {
  const delivered = rows.filter((r) => r.deliveredAt);
  const judged = rows.filter((r) => r.onTime !== null);
  const totals = {
    tasks: rows.length,
    assigned: rows.filter((r) => r.mentorEmail).length,
    started: rows.filter((r) => r.jobStatus).length,
    running: rows.filter((r) => r.jobStatus && RUNNING.has(r.jobStatus)).length,
    delivered: delivered.length,
    failed: rows.filter((r) => r.jobStatus === "failed").length,
    profilesRequired: rows.reduce((n, r) => n + r.profilesRequired, 0),
    profilesRead: rows.reduce((n, r) => n + (r.profilesRead ?? 0), 0),
    shortlisted: rows.reduce((n, r) => n + (r.shortlisted ?? 0), 0),
    medianMinutesToShortlist: median(delivered.map((r) => r.minutesToShortlist ?? 0)),
    onTimePercent: judged.length ? Math.round((100 * judged.filter((r) => r.onTime).length) / judged.length) : null,
    overdue: rows.filter((r) => isOverdue(r, now)).length,
  };
  const members = new Map<string, MemberStats>();
  for (const r of rows) {
    const key = r.mentorEmail ?? (r.mentor ? `name:${r.mentor}` : "unassigned");
    const m = members.get(key) ?? { name: r.mentor ?? "Unassigned", email: r.mentorEmail, tasks: 0, started: 0, delivered: 0, onTime: 0, overdue: 0 };
    m.tasks++;
    if (r.jobStatus) m.started++;
    if (r.deliveredAt) m.delivered++;
    if (r.onTime) m.onTime++;
    if (isOverdue(r, now)) m.overdue++;
    members.set(key, m);
  }
  const byMember = [...members.values()].sort((a, b) => b.tasks - a.tasks || a.name.localeCompare(b.name));
  return { totals, byMember };
}

export function parseRange(params: URLSearchParams, now = new Date()): { from: Date; to: Date } {
  const day = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00+05:30`) : null);
  const days = Math.min(MAX_DAYS, Math.max(1, Number(params.get("days")) || 7));
  const to = day(params.get("to")) ? new Date(day(params.get("to"))!.getTime() + 86_400_000) : now;
  const from = day(params.get("from")) ?? new Date(to.getTime() - days * 86_400_000);
  if (from >= to) throw new UserError(400, "The start date must be before the end date.", "invalid_range");
  if (to.getTime() - from.getTime() > MAX_DAYS * 86_400_000) throw new UserError(400, "Pick a range of a year or less.", "invalid_range");
  return { from, to };
}

export async function analyticsFor(user: RosterUser, scope: "mine" | "team", range: { from: Date; to: Date }) {
  if (scope === "team" && user.role === "member") throw new UserError(403, "Only leads and admins can see the whole team.", "admin_only");
  const [snapshot, roster] = await Promise.all([readControlSnapshot(), listRoster()]);
  const inRange = (t: ControlTask) => {
    const at = t.assignedAt ?? t.deadline;
    return at !== null && at >= range.from && at < range.to;
  };
  const picked = snapshot.tasks
    .filter(inRange)
    .map((task) => ({ task, assignee: task.mentor ? matchMentor(task.mentor, roster) : null }))
    .filter(({ assignee }) => scope === "team" || assignee?.email === user.email);
  const [assignments, jobs] = await Promise.all([
    loadAssignments(picked.map((p) => p.task.taskId)),
    latestJobsFor(snapshot.spreadsheetId, snapshot.tab, picked.map((p) => p.task)),
  ]);
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${snapshot.spreadsheetId}/edit`;
  const now = new Date();
  const rows = picked
    .map(({ task, assignee }) => {
      const a = assignments.get(task.taskId);
      const ack = a?.ack_at && a.assignee_email === assignee?.email ? new Date(a.ack_at).toISOString() : null;
      return rowStats(task, assignee, jobs.get(task.taskId), ack, sheetUrl, now);
    })
    .sort((a, b) => String(b.assignedAt ?? b.deadline).localeCompare(String(a.assignedAt ?? a.deadline)));
  return { from: range.from.toISOString(), to: range.to.toISOString(), scope, ...summarize(rows, now), rows, syncedAt: snapshot.readAt.toISOString() };
}
