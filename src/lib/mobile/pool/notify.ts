import "server-only";
import { query } from "@/lib/db/client";
import { TRACK_LABEL, type PoolTrack } from "@/lib/mobile/pool/parse";
import { academySchemaReady, hasRunBefore, markRun } from "@/lib/mobile/pool/schema";
import {
  capPushes,
  dayLabel,
  digestText,
  interviewTimeKey,
  interviewTimeLabel,
  isLiveInterview,
  OUTCOME_RANK,
  poolDedupe,
  type ShareOutcome,
  weekStart,
} from "@/lib/mobile/pool/shares";
import { addDays, atIst, dayOf, normRound, type PrepRow } from "@/lib/mobile/preps/parse";
import { readPrepSnapshot } from "@/lib/mobile/preps/sheet";
import { pushToUser, type PushKind } from "@/lib/mobile/push";
import { listRoster, matchMentor, type RosterUser } from "@/lib/mobile/roster";

/**
 * The Academy candidates' pushes (PSM 1.10.0), each at most once (dedupe keys, shares.ts poolDedupe):
 *   pool_assigned   a candidate's MENTOR set to a roster mentor (pool sync, every 10 min);
 *   pool_shared     a candidate newly listed in a company sheet (shares sync, hourly);
 *   pool_status     a round or the final status changed there (one push per candidate per company per run);
 *   pool_interview  a drill-down interview row for the candidate appears, or its date / time changes (every minute);
 *   pool_meeting    someone else scheduled a mock interview / guidance meet with the candidate;
 *   academy_digest  08:30 IST: Academy interviews today / tomorrow, shared yesterday, selected this week.
 * They go to the candidate's mentor (unassigned candidates: nobody; they are in the digest). At most
 * MAX_PER_RUN pushes per mentor per run: the rest are summed up in one push. Every first run is a
 * baseline (it records what is there and sends nothing). Texts carry names and companies, never phones.
 */

export const MAX_PER_RUN = 30;

const short = (err: unknown) => (err instanceof Error ? err.message.slice(0, 200) : String(err));

interface PlannedPush {
  kind: PushKind;
  dedupe: string;
  data: Record<string, string>;
}

/** Sends one person's pushes of a run, capped; the overflow becomes one summary push. */
async function sendCapped(email: string, pushes: PlannedPush[], run: string, summary: { kind: PushKind; title: (n: number) => string; body: string }): Promise<number> {
  const { send, summarised } = capPushes(pushes, MAX_PER_RUN);
  let n = 0;
  for (const p of send) {
    const r = await pushToUser({ email, kind: p.kind, data: p.data, dedupeKey: p.dedupe }).catch((err) => {
      console.warn(`[pool] ${p.kind} push failed:`, short(err));
      return null;
    });
    if (r && !r.skipped) n++;
  }
  if (summarised.length) {
    const r = await pushToUser({
      email,
      kind: summary.kind,
      dedupeKey: poolDedupe.summary(`${summary.kind}:${run}`, email),
      data: { title: summary.title(summarised.length), body: summary.body, summary: "true" },
    }).catch(() => null);
    if (r && !r.skipped) n++;
  }
  return n;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ── People ──────────────────────────────────────────────────────────────────

export interface PoolPerson {
  uid: string;
  name: string;
  phone: string | null;
  email: string | null;
  mentor_name: string;
  track: PoolTrack | null;
}

const g = globalThis as unknown as {
  __poolPeople?: { at: number; rows: PoolPerson[] };
  __poolIvRunning?: boolean;
  __academyDigestDay?: string;
};

/** The active pool (uid, name, phone, email, mentor, track), cached 60 s. */
export async function poolPeople(fresh = false): Promise<PoolPerson[]> {
  const hit = g.__poolPeople;
  if (hit && !fresh && Date.now() - hit.at < 60_000) return hit.rows;
  const rows = await query<PoolPerson>(
    `select p.uid, p.name, p.phone, p.email, p.mentor_name, coalesce(s.track, p.sheet_track) as track
       from app.pool_candidates p left join app.pool_state s on s.uid = p.uid
      where p.removed_at is null`,
  );
  g.__poolPeople = { at: Date.now(), rows };
  return rows;
}

const mentorOf = (p: Pick<PoolPerson, "mentor_name">, roster: RosterUser[]) => (p.mentor_name ? matchMentor(p.mentor_name, roster) : null);

// ── pool_assigned ───────────────────────────────────────────────────────────

export interface AssignedChange {
  uid: string;
  name: string;
  track: PoolTrack | null;
  /** The MENTOR cell now and before ("" = blank / a new row). */
  mentor: string;
  prevMentor: string;
}

/**
 * Pushes pool_assigned for rows whose MENTOR now names a roster mentor who wasn't their mentor
 * before. The first run after migration 020 is a baseline. Returns the pushes sent.
 */
export async function notifyAssigned(changes: AssignedChange[], run: string): Promise<number> {
  if (!(await academySchemaReady())) return 0;
  if (!(await hasRunBefore("pool:assigned"))) {
    await markRun("pool:assigned");
    return 0;
  }
  if (!changes.length) return 0;
  const roster = await listRoster();
  const byMentor = new Map<string, PlannedPush[]>();
  for (const c of changes) {
    const now = c.mentor ? matchMentor(c.mentor, roster) : null;
    if (!now?.active) continue;
    const before = c.prevMentor ? matchMentor(c.prevMentor, roster) : null;
    if (before?.email === now.email) continue;
    const track = c.track ? TRACK_LABEL[c.track] : "";
    const list = byMentor.get(now.email) ?? [];
    list.push({
      kind: "pool_assigned",
      dedupe: poolDedupe.assigned(c.uid, now.email),
      data: {
        uid: c.uid,
        name: c.name,
        track: c.track ?? "",
        title: clip(`New candidate · ${c.name || "Academy candidate"}`, 200),
        body: `Assigned to you in the Academy pool${track ? ` (${track})` : ""}.`,
      },
    });
    byMentor.set(now.email, list);
  }
  let n = 0;
  for (const [email, pushes] of byMentor) {
    n += await sendCapped(email, pushes, run, { kind: "pool_assigned", title: (k) => `${k} more candidates assigned to you`, body: "Open the Pool tab to see them." });
  }
  return n;
}

// ── pool_shared / pool_status ───────────────────────────────────────────────

export interface ShareNotice {
  type: "new" | "status";
  shareId: string;
  uid: string;
  company: string;
  role: string;
  stage: string;
  outcome: ShareOutcome;
  hash: string;
  /** What changed ("TR Round 1: Cleared · Final status: Selected"). */
  text: string;
  /** The final status changed (sent first). */
  finalChanged: boolean;
}

/** Pushes the share events of one sync run to the candidates' mentors. */
export async function notifyShareEvents(events: ShareNotice[], run: string): Promise<number> {
  if (!events.length) return 0;
  const [people, roster] = await Promise.all([poolPeople(true), listRoster()]);
  const byUid = new Map(people.map((p) => [p.uid, p]));
  // One status push per candidate per company per run: the most telling change, "+n" for the rest.
  const status = new Map<string, { e: ShareNotice; more: number }>();
  const shared: ShareNotice[] = [];
  for (const e of events) {
    if (e.type === "new") {
      shared.push(e);
      continue;
    }
    const k = `${e.uid}|${e.company.toLowerCase()}`;
    const cur = status.get(k);
    const better = (a: ShareNotice, b: ShareNotice) => Number(a.finalChanged) - Number(b.finalChanged) || OUTCOME_RANK[a.outcome] - OUTCOME_RANK[b.outcome];
    if (!cur) status.set(k, { e, more: 0 });
    else status.set(k, better(e, cur.e) > 0 ? { e, more: cur.more + 1 } : { e: cur.e, more: cur.more + 1 });
  }
  const byMentor = new Map<string, { push: PlannedPush; rank: number }[]>();
  const add = (uid: string, rank: number, make: (email: string, name: string) => PlannedPush) => {
    const p = byUid.get(uid);
    const m = p ? mentorOf(p, roster) : null;
    if (!p || !m?.active) return;
    const list = byMentor.get(m.email) ?? [];
    list.push({ push: make(m.email, p.name || "Academy candidate"), rank });
    byMentor.set(m.email, list);
  };
  for (const { e, more } of status.values()) {
    add(e.uid, e.finalChanged ? 0 : 1, (email, name) => ({
      kind: "pool_status",
      dedupe: poolDedupe.status(e.shareId, e.hash, email),
      data: {
        uid: e.uid,
        name,
        company: e.company,
        role: e.role,
        stage: e.stage,
        outcome: e.outcome,
        title: clip(`${name} · ${e.company}`, 200),
        body: clip(`${e.text}${more ? ` (+${more} more in this company's sheet)` : ""}`, 1000),
      },
    }));
  }
  for (const e of shared) {
    add(e.uid, 2, (email, name) => ({
      kind: "pool_shared",
      dedupe: poolDedupe.shared(e.shareId, email),
      data: {
        uid: e.uid,
        name,
        company: e.company,
        role: e.role,
        title: clip(`Shared with ${e.company} · ${name}`, 200),
        body: clip(`${e.role && e.role !== "—" ? `${e.role}. ` : ""}Follow the rounds in the app.`, 1000),
      },
    }));
  }
  let n = 0;
  for (const [email, list] of byMentor) {
    list.sort((a, b) => a.rank - b.rank);
    n += await sendCapped(
      email,
      list.map((x) => x.push),
      run,
      { kind: "pool_status", title: (k) => `${k} updates for your candidates`, body: "Open the Pool tab to see them." },
    );
  }
  return n;
}

// ── pool_interview ──────────────────────────────────────────────────────────

/**
 * pool_interview: every minute, the drill-down rows of assessed candidates with an interview from
 * today on (60 days ahead) are compared with app.pool_interview_marks; a new row or a new date / time
 * goes to the candidate's mentor. The first run records and sends nothing.
 */
export async function syncPoolInterviews(now = new Date()): Promise<{ checked: number; pushed: number }> {
  if (g.__poolIvRunning || !(await academySchemaReady())) return { checked: 0, pushed: 0 };
  g.__poolIvRunning = true;
  try {
    const [snap, people] = await Promise.all([readPrepSnapshot(), poolPeople()]);
    const byPhone = new Map(people.filter((p) => p.phone).map((p) => [p.phone!, p]));
    const today = dayOf(now);
    const last = addDays(today, 60);
    const relevant = snap.preps.filter((p) => p.phone && byPhone.has(p.phone) && isLiveInterview(p) && p.interviewDay! >= today && p.interviewDay! <= last);
    const baseline = !(await hasRunBefore("pool:interviews"));
    if (!relevant.length) {
      if (baseline) await markRun("pool:interviews");
      return { checked: 0, pushed: 0 };
    }
    const marks = await query<{ prep_key: string; day: string; time_key: string }>(
      "select prep_key, to_char(day, 'YYYY-MM-DD') as day, time_key from app.pool_interview_marks where prep_key = any($1::text[])",
      [relevant.map((p) => p.key)],
    );
    const known = new Map(marks.map((m) => [m.prep_key, m]));
    const changed: { p: PrepRow; person: PoolPerson; moved: boolean }[] = [];
    for (const p of relevant) {
      const k = known.get(p.key);
      const timeKey = interviewTimeKey(p);
      if (k && k.day === p.interviewDay && k.time_key === timeKey) continue;
      changed.push({ p, person: byPhone.get(p.phone)!, moved: Boolean(k) });
    }
    if (changed.length) {
      await query(
        `insert into app.pool_interview_marks (prep_key, uid, day, time_key)
         select k, u, d::date, t from unnest($1::text[], $2::text[], $3::text[], $4::text[]) as x(k, u, d, t)
         on conflict (prep_key) do update set uid = excluded.uid, day = excluded.day, time_key = excluded.time_key, updated_at = now()`,
        [changed.map((c) => c.p.key), changed.map((c) => c.person.uid), changed.map((c) => c.p.interviewDay), changed.map((c) => interviewTimeKey(c.p))],
      );
    }
    if (baseline) {
      await markRun("pool:interviews");
      return { checked: relevant.length, pushed: 0 };
    }
    if (!changed.length) return { checked: relevant.length, pushed: 0 };
    const roster = await listRoster();
    const byMentor = new Map<string, PlannedPush[]>();
    for (const { p, person, moved } of changed) {
      const m = mentorOf(person, roster);
      if (!m?.active) continue;
      const time = interviewTimeLabel(p);
      const round = normRound(p.round) || "Interview";
      const when = `${dayLabel(p.interviewDay!, today)}${time ? `, ${time}` : ""}`;
      const list = byMentor.get(m.email) ?? [];
      list.push({
        kind: "pool_interview",
        dedupe: poolDedupe.interview(p.key, p.interviewDay!, interviewTimeKey(p), m.email),
        data: {
          uid: person.uid,
          name: person.name,
          company: p.company,
          round,
          day: p.interviewDay!,
          time,
          prepId: p.key,
          title: clip(`Interview · ${person.name || p.candidate} · ${p.company}`, 200),
          body: clip(moved ? `${round} moved to ${when}.` : `${round} ${when}.`, 1000),
        },
      });
      byMentor.set(m.email, list);
    }
    let pushed = 0;
    const run = now.toISOString().slice(0, 16);
    for (const [email, list] of byMentor) {
      pushed += await sendCapped(email, list, run, { kind: "pool_interview", title: (k) => `${k} more interview updates for your candidates`, body: "Open the Calendar to see them." });
    }
    return { checked: relevant.length, pushed };
  } finally {
    g.__poolIvRunning = false;
  }
}

// ── academy_digest ──────────────────────────────────────────────────────────

const DIGEST_FROM_MIN = 8 * 60 + 30;
const DIGEST_UNTIL_MIN = 12 * 60;

/**
 * academy_digest at 08:30 IST (until noon, for a server that was asleep), once a day per active
 * member: "Academy interviews today 5 (2 yours) · tomorrow 3 · shared yesterday 12 · selected this
 * week 1". Nothing when every number is zero.
 */
export async function sendAcademyDigest(now = new Date()): Promise<number> {
  const today = dayOf(now);
  const minute = Math.round((now.getTime() - atIst(today, 0).getTime()) / 60_000);
  if (minute < DIGEST_FROM_MIN || minute >= DIGEST_UNTIL_MIN || g.__academyDigestDay === today) return 0;
  if (!(await academySchemaReady())) return 0;
  const tomorrow = addDays(today, 1);
  const [snap, people, roster, counts] = await Promise.all([
    readPrepSnapshot(),
    poolPeople(),
    listRoster(),
    query<{ shared: number; selected: number }>(
      `select (select count(*) from app.company_shares where not baseline and removed_at is null and first_seen_at >= $1 and first_seen_at < $2)::int as shared,
              (select count(distinct uid) from app.company_shares where outcome = 'selected' and removed_at is null and outcome_at >= $3)::int as selected`,
      [atIst(addDays(today, -1), 0), atIst(today, 0), atIst(weekStart(today), 0)],
    ),
  ]);
  const byPhone = new Map(people.filter((p) => p.phone).map((p) => [p.phone!, p]));
  const ivs = snap.preps.filter((p) => p.phone && byPhone.has(p.phone) && isLiveInterview(p) && (p.interviewDay === today || p.interviewDay === tomorrow));
  const mentorEmail = (p: PrepRow) => {
    const person = byPhone.get(p.phone)!;
    return mentorOf(person, roster)?.email ?? null;
  };
  const withMentor = ivs.map((p) => ({ day: p.interviewDay, mentor: mentorEmail(p) }));
  let sent = 0;
  for (const u of roster.filter((r) => r.active)) {
    const body = digestText({
      today: withMentor.filter((x) => x.day === today).length,
      todayMine: withMentor.filter((x) => x.day === today && x.mentor === u.email).length,
      tomorrow: withMentor.filter((x) => x.day === tomorrow).length,
      tomorrowMine: withMentor.filter((x) => x.day === tomorrow && x.mentor === u.email).length,
      sharedYesterday: counts[0]?.shared ?? 0,
      selectedThisWeek: counts[0]?.selected ?? 0,
    });
    if (!body) continue;
    const r = await pushToUser({ email: u.email, kind: "academy_digest", dedupeKey: poolDedupe.digest(today, u.email), data: { day: today, title: "Academy candidates", body } }).catch((err) => {
      console.warn("[pool] academy digest push failed:", short(err));
      return null;
    });
    if (r && !r.skipped) sent++;
  }
  g.__academyDigestDay = today;
  return sent;
}

// ── pool_meeting ────────────────────────────────────────────────────────────

const MEETING_LABEL: Record<string, string> = { mock: "Mock interview", guidance: "Guidance meet" };

/**
 * pool_meeting: a mock interview / guidance meet with pool candidates → each candidate's mentor,
 * unless they scheduled it themselves. One push per meeting per mentor.
 */
export async function notifyPoolMeeting(creator: RosterUser, meeting: { id: string; kind: string; startsAt: Date }, members: { uid: string; name: string; mentor: string }[]): Promise<number> {
  if (!MEETING_LABEL[meeting.kind] || !members.length) return 0;
  if (!(await academySchemaReady())) return 0;
  const roster = await listRoster();
  const byMentor = new Map<string, typeof members>();
  for (const m of members) {
    const u = m.mentor ? matchMentor(m.mentor, roster) : null;
    if (!u?.active || u.email === creator.email) continue;
    byMentor.set(u.email, [...(byMentor.get(u.email) ?? []), m]);
  }
  const when = meeting.startsAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  let n = 0;
  for (const [email, list] of byMentor) {
    const name = list.length === 1 ? list[0].name : `${list[0].name} + ${list.length - 1} more`;
    const r = await pushToUser({
      email,
      kind: "pool_meeting",
      dedupeKey: poolDedupe.meeting(meeting.id, email),
      data: {
        uid: list[0].uid,
        name,
        kind: meeting.kind,
        startsAt: meeting.startsAt.toISOString(),
        by: creator.name,
        meetingId: meeting.id,
        title: clip(`${MEETING_LABEL[meeting.kind]} · ${name}`, 200),
        body: `${creator.name} scheduled it for ${when}.`,
      },
    }).catch((err) => {
      console.warn("[pool] meeting push failed:", short(err));
      return null;
    });
    if (r && !r.skipped) n++;
  }
  return n;
}
