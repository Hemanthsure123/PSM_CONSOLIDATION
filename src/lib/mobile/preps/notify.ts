import "server-only";
import { query } from "@/lib/db/client";
import { pushToUser } from "@/lib/mobile/push";
import { classKey, classifyMany } from "@/lib/mobile/preps/enrich";
import { addDays, atIst, dayOf, interviewStart, isOpen, type PrepRow, slaFor } from "@/lib/mobile/preps/parse";
import { readPrepSnapshot } from "@/lib/mobile/preps/sheet";
import { mentorsOf, trackPreps } from "@/lib/mobile/preps/track";
import { listRoster, type RosterUser } from "@/lib/mobile/roster";

/**
 * Prep and interview pushes, once a minute (ticker.ts) — each at most once (dedupe keys):
 *   prep_assigned      a prep newly given to a mentor ("Prep given by");
 *   prep_reminder      3 h, 1 h and 15 minutes before the prep is due (each only if the prep was
 *                      assigned before that moment), while "Prep Given" isn't Yes;
 *   prep_overdue       at the deadline, to the mentor, then every 2 h until the interview starts
 *                      (at most 4), while "Prep Given" isn't Yes;
 *   prep_escalation    15 minutes past the deadline, to the mentor's lead or the admins;
 *   prep_unassigned    a prep due today/tomorrow with nobody on it after 10 minutes → leads/admins;
 *   interview_checkin  10 minutes after a scheduled interview starts → its prep mentor:
 *                      "did it happen?" (the status is recorded in the app);
 *   prep_digest        09:00 IST — today's interviews (to everyone, for the cross-check) and
 *                      my preps; 18:00 IST — tomorrow's preps still open (only to their mentors).
 * Rows that were already in the sheet when tracking began (baseline) never alert about SLAs.
 */

const SOON_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;
const OVERDUE_EVERY_MS = 2 * HOUR_MS;
const OVERDUE_MAX = 4;
const ESCALATE_MS = 15 * 60_000;

/** Reminder slots before the deadline, latest first: the dedupe key part and how long before it. */
const REMINDERS: { slot: "soon" | "soon1h" | "soon3h"; before: number }[] = [
  { slot: "soon", before: SOON_MS },
  { slot: "soon1h", before: HOUR_MS },
  { slot: "soon3h", before: 3 * HOUR_MS },
];

export interface PrepNudge {
  /** prep_reminder due now: "soon3h" (3 h before), "soon1h" (1 h), "soon" (15 min); null = none. */
  reminder: "soon3h" | "soon1h" | "soon" | null;
  /** prep_overdue due now: 0 at the deadline, then 1, 2, 3 every 2 h; null = none. */
  overdueSlot: number | null;
}

/**
 * Which nudge an open prep is due at [now] (each is then sent once, by its dedupe key). One window
 * at a time: a prep assigned 40 minutes before its deadline gets the 15-minute reminder only; a
 * server that slept through two overdue slots sends the latest one. Reminders only for a prep that
 * was assigned before the reminder's moment; overdue ones only before the interview starts.
 */
export function prepNudge(now: number, dueAt: number, assignedAt: number | null, interviewStart: number | null): PrepNudge {
  if (now < dueAt) {
    const left = dueAt - now;
    // The tightest window that has opened: 15 min, else 1 h, else 3 h before.
    const open = REMINDERS.find((r) => left <= r.before);
    const reminder = open && (assignedAt === null || assignedAt < dueAt - open.before) ? open.slot : null;
    return { reminder, overdueSlot: null };
  }
  if (interviewStart !== null && now >= interviewStart) return { reminder: null, overdueSlot: null };
  return { reminder: null, overdueSlot: Math.min(OVERDUE_MAX - 1, Math.floor((now - dueAt) / OVERDUE_EVERY_MS)) };
}
const UNASSIGNED_AFTER_MS = 10 * 60_000;
const CHECKIN_AFTER_MS = 10 * 60_000;
const CHECKIN_WINDOW_MS = 3 * 3_600_000;

const g = globalThis as unknown as { __prepNotifyRunning?: boolean };

export async function syncPrepNotifications(now = new Date()): Promise<{ checked: number; pushed: number }> {
  if (g.__prepNotifyRunning) return { checked: 0, pushed: 0 };
  g.__prepNotifyRunning = true;
  try {
    const [snap, roster] = await Promise.all([readPrepSnapshot(true), listRoster()]);
    const tracked = await trackPreps(snap, roster);
    const today = dayOf(now);
    const tomorrow = addDays(today, 1);
    const active = roster.filter((u) => u.active);
    const leads = active.filter((u) => u.role === "admin" || u.role === "lead");
    const relevant = snap.preps.filter((p) => p.interviewDay !== null && p.interviewDay >= today && p.interviewDay <= addDays(today, 30));
    const classes = await classifyMany(relevant.map((p) => ({ phone: p.phone, product: p.product })));
    let pushed = 0;

    const send = async (u: RosterUser, kind: Parameters<typeof pushToUser>[0]["kind"], dedupe: string, data: Record<string, string>) => {
      const r = await pushToUser({ email: u.email, kind, data, dedupeKey: dedupe });
      if (!r.skipped) pushed++;
    };
    // An index lookup on the dedupe key (only asked during an overdue prep's first 2 hours).
    const sentBefore = async (dedupe: string) =>
      (await query<{ one: number }>("select 1 as one from app.notifications where dedupe_key = $1", [dedupe])).length > 0;

    for (const p of relevant) {
      const t = tracked.get(p.key);
      if (!t) continue;
      const mentors = mentorsOf(p, roster);
      const cls = classes.get(classKey(p.phone, p.product));
      const data = payload(p, cls?.category ?? "external", cls?.edgeVersion ?? null);
      const sla = slaFor(p, t.firstSeenAt, t.baseline);
      const open = isOpen(p, today);
      const start = interviewStart(p);

      if (open && !t.baseline) {
        for (const m of mentors) {
          await send(m, "prep_assigned", `prep:assign:${p.key}:${m.email}`, { ...data, ...(sla.dueAt ? { dueAt: sla.dueAt.toISOString() } : {}) });
        }
        if (sla.dueAt) {
          const due = sla.dueAt.getTime();
          const left = due - now.getTime();
          const beforeInterview = !start || now < start;
          const nudge = prepNudge(now.getTime(), due, (t.assignedAt ?? t.firstSeenAt).getTime(), start?.getTime() ?? null);
          if (nudge.reminder) {
            for (const m of mentors) await send(m, "prep_reminder", `prep:${nudge.reminder}:${p.key}:${m.email}`, { ...data, dueAt: sla.dueAt.toISOString() });
          }
          if (nudge.overdueSlot !== null) {
            for (const m of mentors) {
              // Before 1.9.0 the one overdue push was "prep:overdue:<key>:<email>": that counts as slot 0.
              if (nudge.overdueSlot === 0 && (await sentBefore(`prep:overdue:${p.key}:${m.email}`))) continue;
              await send(m, "prep_overdue", `prep:overdue:${nudge.overdueSlot}:${p.key}:${m.email}`, { ...data, dueAt: sla.dueAt.toISOString() });
            }
          }
          if (left <= 0 && beforeInterview) {
            if (-left >= ESCALATE_MS) {
              const targets = escalationTargets(mentors, active, leads);
              const who = mentors.length ? mentors.map((m) => m.name).join(" & ") : "Nobody";
              for (const u of targets) {
                await send(u, "prep_escalation", `prep:esc:${p.key}:${u.email}`, {
                  ...data,
                  dueAt: sla.dueAt.toISOString(),
                  title: `Prep overdue · ${p.company}`,
                  body: `${who} hasn't given ${p.candidate}'s ${p.round || "interview"} prep.`,
                });
              }
            }
          }
        }
        if (!p.prepBy.length && sla.kind === "mandatory" && now.getTime() - t.firstSeenAt.getTime() >= UNASSIGNED_AFTER_MS) {
          for (const u of leads) {
            await send(u, "prep_unassigned", `prep:unassigned:${p.key}:${u.email}`, {
              ...data,
              ...(sla.dueAt ? { dueAt: sla.dueAt.toISOString() } : {}),
              title: `No one on this prep · ${p.company}`,
              body: `${p.candidate} · ${p.round || "Interview"} ${p.interviewDay === today ? "today" : "tomorrow"}. Assign a mentor.`,
            });
          }
        }
      }

      // The interview check: did it start? Only for interviews with a time, still marked scheduled.
      if (p.interviewDay === today && p.interviewTime && start && p.interviewState === "scheduled") {
        const since = now.getTime() - start.getTime();
        if (since >= CHECKIN_AFTER_MS && since <= CHECKIN_WINDOW_MS) {
          for (const m of mentors) await send(m, "interview_checkin", `iv:check:${p.key}:${m.email}`, data);
        }
      }
    }

    await digests(now, today, tomorrow, snap.preps, roster, active, (u, kind, key, d) => send(u, kind, key, d));
    return { checked: relevant.length, pushed };
  } finally {
    g.__prepNotifyRunning = false;
  }
}

function payload(p: PrepRow, category: string, edgeVersion: string | null): Record<string, string> {
  const start = p.interviewTime ? interviewStart(p) : null;
  return {
    prepId: p.key,
    company: p.company,
    candidate: p.candidate,
    round: p.round,
    category,
    ...(edgeVersion ? { edgeVersion } : {}),
    ...(p.interviewDay ? { interviewDay: p.interviewDay } : {}),
    ...(start ? { interviewStart: start.toISOString() } : {}),
  };
}

function escalationTargets(mentors: RosterUser[], active: RosterUser[], leads: RosterUser[]): RosterUser[] {
  const leadEmails = new Set(mentors.map((m) => m.leadEmail).filter((e): e is string => Boolean(e)));
  const direct = active.filter((u) => leadEmails.has(u.email));
  const targets = direct.length ? direct : leads;
  return targets.filter((u) => !mentors.some((m) => m.email === u.email));
}

async function digests(
  now: Date,
  today: string,
  tomorrow: string,
  preps: PrepRow[],
  roster: RosterUser[],
  active: RosterUser[],
  send: (u: RosterUser, kind: "prep_digest", key: string, data: Record<string, string>) => Promise<void>,
): Promise<number> {
  const minute = Math.round((now.getTime() - atIst(today, 0).getTime()) / 60_000);
  const morning = minute >= 9 * 60 && minute < 12 * 60;
  const evening = minute >= 18 * 60 && minute < 22 * 60;
  if (!morning && !evening) return 0;
  const interviewsToday = preps.filter((p) => p.interviewDay === today).length;
  let n = 0;
  for (const u of active) {
    const mine = (day: string) => preps.filter((p) => p.interviewDay === day && p.prepStatus === "pending" && mentorsOf(p, roster).some((m) => m.email === u.email)).length;
    if (morning) {
      const todayOpen = mine(today);
      const tomorrowOpen = mine(tomorrow);
      if (!interviewsToday && !todayOpen && !tomorrowOpen) continue;
      const parts = [
        `${interviewsToday} interview${interviewsToday === 1 ? "" : "s"} today`,
        ...(todayOpen ? [`${todayOpen} prep${todayOpen === 1 ? "" : "s"} for today`] : []),
        ...(tomorrowOpen ? [`${tomorrowOpen} for tomorrow`] : []),
      ];
      await send(u, "prep_digest", `digest:am:${today}:${u.email}`, { title: "Your day", body: parts.join(" · "), digest: "morning", interviewDay: today });
      n++;
    } else {
      const open = mine(tomorrow);
      if (!open) continue;
      await send(u, "prep_digest", `digest:pm:${today}:${u.email}`, {
        title: `${open} prep${open === 1 ? "" : "s"} for tomorrow not done`,
        body: "Give them today, before you log off.",
        digest: "evening",
        interviewDay: tomorrow,
      });
      n++;
    }
  }
  return n;
}
