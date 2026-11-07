import "server-only";
import { query, transaction } from "@/lib/db/client";
import { addDays, dayOf, type PrepRow, slaFor } from "@/lib/mobile/preps/parse";
import type { PrepSnapshot } from "@/lib/mobile/preps/sheet";
import { matchMentor, type RosterUser } from "@/lib/mobile/roster";

/**
 * What the server remembers about each drill-down row (app.prep_rows): when it first appeared
 * (the SLA clock), whether it was already there when tracking began, its mentors as matched to
 * the roster, and when the prep was first seen given. Synced from every fresh sheet read; only
 * rows that changed are written.
 */

export interface Tracked {
  firstSeenAt: Date;
  baseline: boolean;
  mentorEmails: string[];
  assignedAt: Date | null;
  doneAt: Date | null;
  dueAt: Date | null;
}

interface DbRow {
  key: string;
  first_seen_at: Date;
  baseline: boolean;
  sheet_row: number;
  company: string;
  interview_day: string | null;
  due_at: Date | null;
  mentor_emails: string[];
  assigned_at: Date | null;
  prep_status: string;
  done_at: Date | null;
}

const g = globalThis as unknown as { __prepTracked?: { readAt: number; map: Map<string, Tracked> }; __prepTrackRunning?: Promise<Map<string, Tracked>> };

/** The roster people named in a "Prep given by" cell ("HEMANTH, RAKESH"). Unknown names are ignored. */
export function mentorsOf(p: Pick<PrepRow, "prepBy">, roster: RosterUser[]): RosterUser[] {
  const out: RosterUser[] = [];
  for (const name of p.prepBy) {
    const u = matchMentor(name, roster);
    if (u && !out.some((x) => x.email === u.email)) out.push(u);
  }
  return out;
}

/** Syncs app.prep_rows with a snapshot (once per snapshot) and returns every tracked row. */
export async function trackPreps(snap: PrepSnapshot, roster: RosterUser[]): Promise<Map<string, Tracked>> {
  const cached = g.__prepTracked;
  if (cached && cached.readAt >= snap.readAt.getTime()) return cached.map;
  if (g.__prepTrackRunning) return g.__prepTrackRunning;
  g.__prepTrackRunning = run(snap, roster);
  try {
    return await g.__prepTrackRunning;
  } finally {
    g.__prepTrackRunning = undefined;
  }
}

async function run(snap: PrepSnapshot, roster: RosterUser[]): Promise<Map<string, Tracked>> {
  const rows = await query<DbRow>(
    `select key, first_seen_at, baseline, sheet_row, company, to_char(interview_day, 'YYYY-MM-DD') interview_day, due_at,
            mentor_emails, assigned_at, prep_status, done_at from app.prep_rows`,
  );
  const known = new Map(rows.map((r) => [r.key, r]));
  // The very first sync: everything already in the sheet is history (no SLA, no pushes).
  const firstSync = known.size === 0;
  const now = new Date();
  const today = dayOf(now);
  const changed: DbRow[] = [];
  const map = new Map<string, Tracked>();

  for (const p of snap.preps) {
    const prev = known.get(p.key);
    const mentors = mentorsOf(p, roster).map((u) => u.email).sort();
    // A row whose key is new but whose entry date is older than yesterday was edited (phone or round
    // fixed), not just entered: it doesn't start a fresh 45-minute clock.
    const baseline = prev ? prev.baseline : firstSync || (p.entryDay !== null && p.entryDay < addDays(today, -1));
    const firstSeenAt = prev?.first_seen_at ?? now;
    const sla = slaFor(p, firstSeenAt, baseline);
    const mentorsChanged = !prev || prev.mentor_emails.join(",") !== mentors.join(",");
    // Assigned "now" when the mentors change; rows already assigned when tracking began have no time.
    const assignedAt = !mentors.length ? null : mentorsChanged ? (prev || !baseline ? now : null) : (prev?.assigned_at ?? null);
    // "Given at" is only known when we saw it change from not given to given.
    const doneAt = p.prepStatus !== "done" ? null : prev?.done_at ?? (prev && prev.prep_status !== "done" ? now : null);
    const next: DbRow = {
      key: p.key,
      first_seen_at: firstSeenAt,
      baseline,
      sheet_row: p.row,
      company: p.company.slice(0, 200),
      interview_day: p.interviewDay,
      due_at: sla.dueAt,
      mentor_emails: mentors,
      assigned_at: assignedAt,
      prep_status: p.prepStatus,
      done_at: doneAt,
    };
    if (
      !prev ||
      mentorsChanged ||
      prev.sheet_row !== next.sheet_row ||
      prev.company !== next.company ||
      prev.interview_day !== next.interview_day ||
      (prev.due_at?.getTime() ?? null) !== (next.due_at?.getTime() ?? null) ||
      prev.prep_status !== next.prep_status ||
      (prev.done_at?.getTime() ?? null) !== (next.done_at?.getTime() ?? null)
    ) {
      changed.push(next);
    }
    map.set(p.key, {
      firstSeenAt: next.first_seen_at,
      baseline: next.baseline,
      mentorEmails: next.mentor_emails,
      assignedAt: next.assigned_at,
      doneAt: next.done_at,
      dueAt: next.due_at,
    });
  }

  // Upsert in chunks (unnest keeps it one statement per chunk), all in one transaction: a sync that
  // fails half-way leaves nothing behind, so the next run is still the baseline (no alert burst).
  await transaction(async (tx) => {
    for (let i = 0; i < changed.length; i += 500) {
      const c = changed.slice(i, i + 500);
      await tx.query(
        `insert into app.prep_rows (key, first_seen_at, baseline, sheet_row, company, interview_day, due_at, mentor_emails, assigned_at, prep_status, done_at, last_seen_at, updated_at)
         select k, f, b, r, c, d::date, du, coalesce(string_to_array(nullif(m, ''), ','), '{}'::text[]), a, st, dn, now(), now()
           from unnest($1::text[], $2::timestamptz[], $3::boolean[], $4::int[], $5::text[], $6::text[], $7::timestamptz[], $8::text[], $9::timestamptz[], $10::timestamptz[], $11::text[])
             as t(k, f, b, r, c, d, du, m, a, dn, st)
         on conflict (key) do update set sheet_row = excluded.sheet_row, company = excluded.company, interview_day = excluded.interview_day,
           due_at = excluded.due_at, mentor_emails = excluded.mentor_emails, assigned_at = excluded.assigned_at,
           prep_status = excluded.prep_status, done_at = excluded.done_at, last_seen_at = now(), updated_at = now()`,
        [
          c.map((x) => x.key),
          c.map((x) => x.first_seen_at),
          c.map((x) => x.baseline),
          c.map((x) => x.sheet_row),
          c.map((x) => x.company),
          c.map((x) => x.interview_day),
          c.map((x) => x.due_at),
          c.map((x) => x.mentor_emails.join(",")),
          c.map((x) => x.assigned_at),
          c.map((x) => x.done_at),
          c.map((x) => x.prep_status),
        ],
      );
    }
  });

  g.__prepTracked = { readAt: snap.readAt.getTime(), map };
  return map;
}

/** After an app action: remember it at once (the next sheet read confirms it). */
export async function rememberAction(key: string, patch: { doneAt?: Date | null; mentorEmails?: string[] }): Promise<void> {
  const t = g.__prepTracked?.map.get(key);
  if (patch.doneAt !== undefined) {
    await query("update app.prep_rows set done_at = $2, prep_status = case when $2::timestamptz is null then 'pending' else 'done' end, updated_at = now() where key = $1", [key, patch.doneAt]);
    if (t) t.doneAt = patch.doneAt;
  }
  if (patch.mentorEmails) {
    const emails = [...patch.mentorEmails].sort();
    await query("update app.prep_rows set mentor_emails = $2::text[], assigned_at = now(), updated_at = now() where key = $1", [key, emails]);
    if (t) {
      t.mentorEmails = [...patch.mentorEmails].sort();
      t.assignedAt = new Date();
    }
  }
}

export function forgetTracked(): void {
  g.__prepTracked = undefined;
}
