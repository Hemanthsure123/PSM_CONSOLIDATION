import "server-only";
import { databaseConfigured, query } from "@/lib/db/client";
import { TRACK_LABEL, isPoolTrack } from "@/lib/mobile/pool/parse";
import { listRoster, matchMentor, type RosterUser } from "@/lib/mobile/roster";
import { buildMentorLabels, emailKey, phoneKey, uidKey, type MentorLabels, type MentorRef, type PoolMentorRow } from "@/lib/pool/mentor-label";

/**
 * Mentor labels for a batch of people, from the Academy assessed pool (app.pool_candidates with
 * the mentor's chosen track from app.pool_state). One query for the pool rows and, only when one
 * of them has a mentor, one for the roster: no query per person.
 *
 * Never throws and never slows a screening down with an error: without a database, before the
 * pool tables exist, or when the database is unreachable, every label is blank ({}).
 * The rules (matching order, the label's wording) are pure: src/lib/pool/mentor-label.ts.
 */

/** Removed rows (left the tab) are ignored; a blank mentor_name is "no mentor". */
const SQL = `
  select p.uid, p.phone::text as phone, p.email, p.mentor_name, p.sheet_tech_stack, s.track, p.updated_at
    from app.pool_candidates p
    left join app.pool_state s on s.uid = p.uid
   where p.removed_at is null
     and (p.phone::text = any($1::text[]) or lower(p.uid) = any($2::text[]) or lower(p.email) = any($3::text[]))`;

export interface PoolMentorDbRow {
  uid: string;
  phone: string | null;
  email: string | null;
  mentor_name: string | null;
  sheet_tech_stack: string | null;
  track: string | null;
  updated_at: Date | string | null;
}

/** The pool tables (or a column) aren't there yet: a missing schema, table or column. */
const notSetUp = (err: unknown) => ["42P01", "42703", "3F000"].includes((err as { code?: string } | null)?.code ?? "");

const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))];

/** The tech stack a label shows: the sheet's TechStack, else the track the mentor chose. */
export function techStackOf(sheetTechStack: string | null, track: string | null): string | null {
  const sheet = (sheetTechStack ?? "").trim();
  if (sheet) return sheet;
  return isPoolTrack(track) ? TRACK_LABEL[track] : null;
}

/**
 * Where the rows come from: the app's pool by default. A read-only check passes its own (a
 * `set transaction read only` transaction), so the very same lookup runs against production safely.
 */
export interface MentorLookupSource {
  poolRows: (sql: string, values: unknown[]) => Promise<PoolMentorDbRow[]>;
  roster: () => Promise<RosterUser[]>;
}
const APP_SOURCE: MentorLookupSource = { poolRows: (sql, values) => query<PoolMentorDbRow>(sql, values), roster: listRoster };

/** Labels keyed "p:<phone>" / "u:<uid>" / "e:<email>" for the pool rows these people match. */
export async function mentorLabelsFor(people: MentorRef[], source: MentorLookupSource = APP_SOURCE): Promise<MentorLabels> {
  if (!databaseConfigured() || !people.length) return {};
  const phones = uniq(people.map((p) => phoneKey(p.phone)));
  const uids = uniq(people.map((p) => uidKey(p.userId)));
  const emails = uniq(people.map((p) => emailKey(p.email)));
  if (!phones.length && !uids.length && !emails.length) return {};
  try {
    const rows = (await source.poolRows(SQL, [phones, uids, emails])).map(
      (r): PoolMentorRow => ({
        uid: r.uid,
        phone: r.phone,
        email: r.email,
        mentorName: r.mentor_name ?? "",
        techStack: techStackOf(r.sheet_tech_stack, r.track),
        updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : 0,
      }),
    );
    if (!rows.length) return {};
    // The roster's display name for a sheet name; without the roster (not set up), the sheet's.
    const roster: RosterUser[] = rows.some((r) => (r.mentorName ?? "").trim())
      ? await source.roster().catch((err) => {
          console.warn("[pool] mentor names: roster unavailable, using the sheet's names:", (err as { code?: string })?.code ?? (err instanceof Error ? err.message : err));
          return [];
        })
      : [];
    return buildMentorLabels(rows, (name) => matchMentor(name, roster)?.name ?? null);
  } catch (err) {
    console.warn(
      "[pool] mentor labels unavailable (left blank):",
      notSetUp(err) ? "the Academy pool tables aren't set up" : err instanceof Error ? err.message : String(err),
    );
    return {};
  }
}
