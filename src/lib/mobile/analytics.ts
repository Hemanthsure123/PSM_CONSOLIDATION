import "server-only";
import { controlLayout } from "@/lib/automation/control-sheet";
import type { JobRow } from "@/lib/automation/store";
import { query } from "@/lib/db/client";
import { type ControlTask, readControlSnapshot } from "@/lib/mobile/control-rows";
import { UserError } from "@/lib/mobile/http";
import { latestJobsFor } from "@/lib/mobile/jobs";
import { dayOf, type PrepRow } from "@/lib/mobile/preps/parse";
import { readPrepSnapshot } from "@/lib/mobile/preps/sheet";
import { mentorsOf } from "@/lib/mobile/preps/track";
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
  const [assignments, jobs, layout] = await Promise.all([
    loadAssignments(picked.map((p) => p.task.taskId)),
    latestJobsFor(snapshot.spreadsheetId, snapshot.tab, picked.map((p) => p.task)),
    controlLayout(snapshot.spreadsheetId, snapshot.tab).catch(() => null),
  ]);
  // "#gid=…" so "&range=A<row>" lands in the fragment (as GET /tasks/{id} builds it).
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${snapshot.spreadsheetId}/edit#gid=${layout?.sheetId ?? 0}`;
  const now = new Date();
  const rows = picked
    .map(({ task, assignee }) => {
      const a = assignments.get(task.taskId);
      const ack = a?.ack_at && a.assignee_email === assignee?.email ? new Date(a.ack_at).toISOString() : null;
      return rowStats(task, assignee, jobs.get(task.taskId), ack, sheetUrl, now);
    })
    .sort((a, b) => String(b.assignedAt ?? b.deadline).localeCompare(String(a.assignedAt ?? a.deadline)));
  const members = scope === "team" ? roster.filter((u) => u.active) : [roster.find((u) => u.email === user.email) ?? user];
  const activity = await activityFor(members, snapshot.tasks, roster, range, now, (tasks) => latestJobsFor(snapshot.spreadsheetId, snapshot.tab, tasks));
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    scope,
    ...summarize(rows, now),
    rows,
    activity,
    syncedAt: snapshot.readAt.toISOString(),
  };
}

// ── What each member did (GET /analytics → activity) ─────────────────────────

export interface MemberActivity {
  email: string;
  name: string;
  shortlistings: number;
  prepsGiven: number;
  prepCalls: number;
  rsas: number;
  guidanceMeets: number;
  mockInterviews: number;
}

export type ActivityKey = Exclude<keyof MemberActivity, "email" | "name">;
export type ActivityCounts = Partial<Record<ActivityKey, Map<string, number>>>;
type Range = { from: Date; to: Date };

/** A shortlisting delivered before the range can still be one from a task assigned this long before it. */
const SHORTLIST_LOOKBACK_MS = 60 * 86_400_000;

const bump = (m: Map<string, number>, key: string, n = 1) => m.set(key, (m.get(key) ?? 0) + n);

/**
 * Shortlistings: control-tab tasks assigned to the member whose shortlist was delivered in the
 * range (delivered = the early shortlist or the job's end, as byMember.delivered counts it).
 */
export function countShortlistings(items: { assigneeEmail: string | null; deliveredAt: Date | null }[], range: Range): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of items) {
    if (it.assigneeEmail && it.deliveredAt && it.deliveredAt >= range.from && it.deliveredAt < range.to) bump(out, it.assigneeEmail);
  }
  return out;
}

/** The IST days a range touches, first and last (inclusive). */
export function istDays(range: Range): { first: string; last: string } {
  return { first: dayOf(range.from), last: dayOf(range.to.getTime() - 1) };
}

/**
 * Preps given: drill-down rows whose "Prep Given" status is done (the column says Yes, not just a
 * name in "Prep Given By"), whose "Prep Given By" names the member, with the interview on a day in
 * the range. A prep given by two mentors counts for both.
 */
export function countPrepsGiven(preps: Pick<PrepRow, "prepStatus" | "prepBy" | "interviewDay">[], roster: RosterUser[], range: Range): Map<string, number> {
  const { first, last } = istDays(range);
  const out = new Map<string, number>();
  for (const p of preps) {
    if (p.prepStatus !== "done" || !p.interviewDay || p.interviewDay < first || p.interviewDay > last) continue;
    for (const m of mentorsOf(p, roster)) bump(out, m.email);
  }
  return out;
}

/** One row per member (every count a non-negative integer), most active first, then by name. */
export function buildActivity(members: Pick<RosterUser, "email" | "name">[], counts: ActivityCounts): MemberActivity[] {
  const keys: ActivityKey[] = ["shortlistings", "prepsGiven", "prepCalls", "rsas", "guidanceMeets", "mockInterviews"];
  const seen = new Set<string>();
  const rows: MemberActivity[] = [];
  for (const m of members) {
    if (seen.has(m.email)) continue;
    seen.add(m.email);
    const row = { email: m.email, name: m.name } as MemberActivity;
    for (const k of keys) {
      const n = Number(counts[k]?.get(m.email) ?? 0);
      row[k] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    }
    rows.push(row);
  }
  const total = (r: MemberActivity) => keys.reduce((s, k) => s + r[k], 0);
  return rows.sort((a, b) => total(b) - total(a) || a.name.localeCompare(b.name));
}

const missingTable = (err: unknown) => /relation "app\.\w+" does not exist/.test(err instanceof Error ? err.message : String(err));

/** Calls, meetings and RSA documents per member, from the database (meetings only once they've started). */
async function dbCounts(emails: string[], range: Range, now: Date): Promise<ActivityCounts> {
  const safe = <T>(p: Promise<T[]>) => p.catch((err) => (missingTable(err) ? [] : Promise.reject(err)));
  const [calls, meetings, rsas] = await Promise.all([
    safe(
      query<{ email: string; n: number }>(
        `select mentor_email as email, count(*)::int as n from app.call_recordings
          where mentor_email = any($1::text[]) and call_at >= $2 and call_at < $3 group by mentor_email`,
        [emails, range.from, range.to],
      ),
    ),
    safe(
      query<{ email: string; kind: string; n: number }>(
        `select created_by as email, kind, count(*)::int as n from app.meetings
          where created_by = any($1::text[]) and status = 'scheduled' and kind in ('prep', 'guidance', 'mock')
            and starts_at >= $2 and starts_at < $3 and starts_at <= $4
          group by created_by, kind`,
        [emails, range.from, range.to, now],
      ),
    ),
    safe(
      query<{ email: string; n: number }>(
        `select created_by as email, count(*)::int as n from app.rsa_documents
          where created_by = any($1::text[]) and created_at >= $2 and created_at < $3 group by created_by`,
        [emails, range.from, range.to],
      ),
    ),
  ]);
  const prepCalls = new Map<string, number>();
  const guidanceMeets = new Map<string, number>();
  const mockInterviews = new Map<string, number>();
  for (const c of calls) bump(prepCalls, c.email, Number(c.n));
  for (const m of meetings) bump(m.kind === "prep" ? prepCalls : m.kind === "guidance" ? guidanceMeets : mockInterviews, m.email, Number(m.n));
  return { prepCalls, guidanceMeets, mockInterviews, rsas: new Map(rsas.map((r) => [r.email, Number(r.n)])) };
}

/**
 * GET /analytics → activity: per member, over the same range, shortlistings, preps given, prep calls
 * (phone recordings + prep meetings), RSA documents, guidance meets and mock interviews.
 */
async function activityFor(
  members: RosterUser[],
  tasks: ControlTask[],
  roster: RosterUser[],
  range: Range,
  now: Date,
  jobsFor: (tasks: ControlTask[]) => Promise<Map<string, JobRow>>,
): Promise<MemberActivity[]> {
  const emails = new Set(members.map((m) => m.email));
  const lookback = range.from.getTime() - SHORTLIST_LOOKBACK_MS;
  const owned = tasks
    .map((task) => ({ task, assignee: task.mentor ? matchMentor(task.mentor, roster) : null }))
    .filter(({ task, assignee }) => {
      if (!assignee || !emails.has(assignee.email)) return false;
      const at = task.assignedAt ?? task.deadline;
      return !at || at.getTime() >= lookback;
    });
  const [jobs, preps, db] = await Promise.all([
    jobsFor(owned.map((o) => o.task)),
    readPrepSnapshot()
      .then((s) => s.preps)
      .catch((err) => {
        console.warn("[mobile] analytics: the drill-down couldn't be read, preps given count as 0:", err instanceof Error ? err.message.slice(0, 200) : err);
        return [] as PrepRow[];
      }),
    dbCounts([...emails], range, now),
  ]);
  const shortlistings = countShortlistings(
    owned.map(({ task, assignee }) => ({ assigneeEmail: assignee?.email ?? null, deliveredAt: deliveredAt(jobs.get(task.taskId)) })),
    range,
  );
  return buildActivity(members, { ...db, shortlistings, prepsGiven: countPrepsGiven(preps, roster, range) });
}
