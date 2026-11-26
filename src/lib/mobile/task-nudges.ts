/**
 * PSM 1.11.0's task pushes, as pure functions (no database, no network): which reminder is due for
 * an assigned task at a moment, the texts, and the daily task digest. assignments.ts sends them
 * (each once, by its dedupe key); scripts/tasks-selftest.ts checks them with an injected `now`.
 *
 *   reminder  nudge:30 / nudge:90   not started (no "Start now", no screening) 30 and 90 minutes after
 *                                   the person was told (the assignment push); never past the deadline,
 *                                   never more than 6 h after (a deploy doesn't replay old rows)
 *   reminder  soon1h / soon15       1 h and 15 min before the deadline, each only when the person was
 *                                   told before that moment (the assignment push said it otherwise)
 *   overdue   overdue:<0-3>         at the deadline, then every 2 h, at most 4, up to a day after it
 * One window at a time: a server that slept through a slot sends the latest one only. Done and
 * delivered tasks get nothing.
 */

const M = 60_000;
const H = 3_600_000;
const IST_MS = 5.5 * H;

export const NUDGE_SLOTS_MS = { "nudge:30": 30 * M, "nudge:90": 90 * M } as const;
/** No "not started" nudge for a task the person was told about longer ago than this. */
export const NUDGE_MAX_AGE_MS = 6 * H;
export const SOON_1H_MS = H;
export const SOON_15_MS = 15 * M;
export const OVERDUE_EVERY_MS = 2 * H;
export const OVERDUE_MAX = 4;
/** A deadline more than a day ago is history: no pushes at all (as in 1.10). */
export const STALE_MS = 24 * H;

export type NudgeSlot = keyof typeof NUDGE_SLOTS_MS;
export type SoonSlot = "soon1h" | "soon15";

export interface TaskNudgeInput {
  now: number;
  /** The deadline (ms); null = none. */
  deadline: number | null;
  /** When the assignee was told (their assignment push); null = unknown. */
  toldAt: number | null;
  /** "Start now" was tapped, or a screening job exists. */
  started: boolean;
  /** Marked done, or the automation delivered the shortlist. */
  finished: boolean;
}

export interface TaskNudge {
  nudge: NudgeSlot | null;
  reminder: SoonSlot | null;
  /** 0 at the deadline, then 1, 2, 3 every 2 h; null = none. */
  overdueSlot: number | null;
}

const NONE: TaskNudge = { nudge: null, reminder: null, overdueSlot: null };

/** The pushes due at [now] for one assigned task (each is then sent once, by its dedupe key). */
export function taskNudge(i: TaskNudgeInput): TaskNudge {
  if (i.finished) return NONE;
  const past = i.deadline !== null && i.now >= i.deadline;
  let nudge: NudgeSlot | null = null;
  if (!i.started && i.toldAt !== null && !past) {
    const age = i.now - i.toldAt;
    if (age >= NUDGE_SLOTS_MS["nudge:90"] && age < NUDGE_MAX_AGE_MS) nudge = "nudge:90";
    else if (age >= NUDGE_SLOTS_MS["nudge:30"] && age < NUDGE_SLOTS_MS["nudge:90"]) nudge = "nudge:30";
  }
  if (i.deadline === null) return { nudge, reminder: null, overdueSlot: null };
  if (!past) {
    const left = i.deadline - i.now;
    const toldBefore = (before: number) => i.toldAt === null || i.toldAt < i.deadline! - before;
    let reminder: SoonSlot | null = null;
    if (left <= SOON_15_MS) reminder = toldBefore(SOON_15_MS) ? "soon15" : null;
    else if (left <= SOON_1H_MS) reminder = toldBefore(SOON_1H_MS) ? "soon1h" : null;
    return { nudge, reminder, overdueSlot: null };
  }
  const since = i.now - i.deadline;
  if (since > STALE_MS) return NONE;
  return { nudge: null, reminder: null, overdueSlot: Math.min(OVERDUE_MAX - 1, Math.floor(since / OVERDUE_EVERY_MS)) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The IST calendar day of an instant ("2026-11-27"). */
export const istDay = (at: Date | number) => new Date(Number(at) + IST_MS).toISOString().slice(0, 10);

/** Minutes since IST midnight. */
export const istMinute = (at: Date | number) => {
  const d = new Date(Number(at) + IST_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** "6:00 PM" (IST) on [now]'s IST day, else "27 Nov, 6:00 PM". */
export function istClock(at: Date, now: number): string {
  const ist = new Date(at.getTime() + IST_MS);
  const h = ist.getUTCHours();
  const clock = `${h % 12 || 12}:${String(ist.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  return istDay(at) === istDay(now) ? clock : `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]}, ${clock}`;
}

const MARK_DONE = "Mark done when the shortlist is shared.";

export interface NudgeTask {
  company: string;
  profilesRequired: number;
  deadline: Date | null;
}

const profiles = (n: number) => (n ? `${n} profile${n === 1 ? "" : "s"}` : "Profiles");

/** The push's title and body (also the inbox line) for a nudge, soon or overdue slot. */
export function nudgeText(slot: NudgeSlot | SoonSlot | `overdue:${number}`, task: NudgeTask, now: number): { title: string; body: string } {
  const due = task.deadline ? istClock(task.deadline, now) : "";
  if (slot === "nudge:30" || slot === "nudge:90") {
    return {
      title: `${slot === "nudge:30" ? "Not started" : "Still not started"} · ${task.company}`,
      body: `Assigned to you ${slot === "nudge:30" ? "30 min" : "90 min"} ago${due ? ` · due ${due}` : ""}. Tap Start now.`,
    };
  }
  if (slot === "soon1h" || slot === "soon15") {
    return {
      title: `Due in ${slot === "soon1h" ? "1 hour" : "15 minutes"} · ${task.company}`,
      body: `${profiles(task.profilesRequired)}${due ? ` by ${due}` : ""}. ${MARK_DONE}`,
    };
  }
  const n = Number(slot.slice("overdue:".length)) || 0;
  return {
    title: `Overdue · ${task.company}`,
    body: n === 0 ? `The deadline${due ? ` (${due})` : ""} has passed. ${MARK_DONE}` : `${n * 2} h past the deadline${due ? ` (${due})` : ""}. ${MARK_DONE}`,
  };
}

/** The assignment push's text for a row the server assigned from the ISE mapping. */
export function iseAssignText(company: string, ise: string): { title: string; body: string } {
  return { title: `New task · ${company}`, body: `Assigned to you as ${ise.trim() || "the ISE"}'s mentor (ISE)` };
}

/** task_done: "Rakesh finished Acme's shortlisting". */
export function doneText(by: string, company: string, doneAt: Date, ise: string, now: number): { title: string; body: string } {
  return { title: `${by} finished ${company}'s shortlisting`, body: `Marked done at ${istClock(doneAt, now)}${ise.trim() ? ` · ISE ${ise.trim()}` : ""}.` };
}

// ── task_digest ─────────────────────────────────────────────────────────────

/** Morning from 09:15 IST, evening from 18:00 IST; each sent until the window closes (a server that slept). */
const AM_FROM = 9 * 60 + 15;
const AM_UNTIL = 12 * 60;
const PM_FROM = 18 * 60;
const PM_UNTIL = 22 * 60;

export type DigestSlot = "am" | "pm";

/** The digest due at [now] ("am" / "pm" on today's IST day), or null outside both windows. */
export function digestSlot(now: number): { slot: DigestSlot; day: string } | null {
  const m = istMinute(now);
  if (m >= AM_FROM && m < AM_UNTIL) return { slot: "am", day: istDay(now) };
  if (m >= PM_FROM && m < PM_UNTIL) return { slot: "pm", day: istDay(now) };
  return null;
}

export interface DigestTask {
  company: string;
  /** 0 overdue · 1 due today · 2 upcoming · 3 no deadline (tasks.ts listGroup; done / delivered never get here). */
  group: number;
}

/** "Acme, Globex, Initech +2 more" (names once each, in the order given). */
export function companyList(tasks: { company: string }[], max = 3): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const t of tasks) {
    const name = t.company.trim();
    const k = name.toLowerCase();
    if (!name || seen.has(k)) continue;
    seen.add(k);
    names.push(name);
  }
  const more = names.length - max;
  return `${names.slice(0, max).join(", ")}${more > 0 ? ` +${more} more` : ""}`;
}

/**
 * The digest for one person's open tasks (already in list order), or null when they have none:
 *   am  "Your tasks today: 3 open · 1 overdue · 2 due today" / "Acme, Globex, Initech +1 more"
 *   pm  "Still open: Acme, Globex" / "Mark done when the shortlist is shared."
 */
export function taskDigestText(slot: DigestSlot, open: DigestTask[]): { title: string; body: string; count: number } | null {
  if (!open.length) return null;
  const overdue = open.filter((t) => t.group === 0).length;
  const today = open.filter((t) => t.group === 1).length;
  if (slot === "am") {
    const parts = [`${open.length} open`, ...(overdue ? [`${overdue} overdue`] : []), ...(today ? [`${today} due today`] : [])];
    return { title: `Your tasks today: ${parts.join(" · ")}`, body: companyList(open), count: open.length };
  }
  return { title: `Still open: ${companyList(open)}`, body: MARK_DONE, count: open.length };
}

/** Dedupe keys of the 1.11.0 task pushes (one push per key, ever). */
export const taskDedupe = {
  slot: (slot: string, taskId: string, email: string) => `${slot}:${taskId}:${email}`,
  done: (taskId: string, doneAt: Date, email: string) => `done:${taskId}:${doneAt.getTime()}:${email}`,
  digest: (slot: DigestSlot, day: string, email: string) => `task:digest:${slot}:${day}:${email}`,
};
