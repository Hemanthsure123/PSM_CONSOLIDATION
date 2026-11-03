import "server-only";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { query, transaction } from "@/lib/db/client";
import type { Table } from "@/lib/pool/parse";
import type { ParseIssue } from "@/lib/pool/types";
import { SYNC_LOCK, readTab } from "@/lib/pool/sync";
import { ASSESSMENTS, type ScoreImportResult } from "@/lib/pool/scores/catalogue";
import { parseScores, type ParsedScores } from "@/lib/pool/scores/parse";
import { MARKS_NOT_SET_UP, marksTablesMissing } from "@/lib/pool/scores/queries";
import { scoreSheets } from "@/lib/pool/scores/sources";

/**
 * Import one assessment export into Postgres — a CSV, or a Google Sheets tab. Idempotent:
 *  - everyone assessed keeps their marks. People are matched by user id; an assessed person who
 *    isn't in the database yet is added (only for a real score), with their phone and name when
 *    the sheet has them. Whether they are eligible for job opportunities is not stored — it is
 *    derived from the eligible pool (see placement.assessed_people), and counted per import;
 *  - the export replaces exactly its own scores (source_key): new and changed rows are written,
 *    unchanged ones untouched (row_hash), rows no longer in it removed;
 *  - an export that would remove more than a fifth of what is stored for it stops and asks first
 *    (allowShrink), so a partial download never wipes good data;
 *  - profiles (year of graduation, college …) are merged by source rank: the roster overwrites,
 *    exam and interview exports only fill gaps;
 *  - everything runs in one transaction under the same lock as the product syncs;
 *  - each import is logged in placement.score_imports with its counts and row issues.
 */

const MAX_LOGGED_ISSUES = 200;
/** Removing more than this share of a source's stored scores needs allowShrink. */
const SHRINK_GUARD = 0.2;

export interface ScoreImportInput {
  mode: "sheet" | "csv";
  /** CSV file name or "sheet id › tab" (for the log). */
  sourceRef: string;
  /** The file name or the tab — an offline exam's date is read from it. */
  fileName: string;
  table: Table;
  /** YYYY-MM-DD, when an offline exam's file doesn't carry its date. */
  examDate?: string;
  allowShrink?: boolean;
}

class ShrinkError extends Error {
  constructor(
    readonly existing: number,
    readonly incoming: number,
    readonly removing: number,
  ) {
    super(`This export would remove ${removing} of the ${existing} scores stored for it (it has ${incoming}). Import it again with "Replace anyway" if that is intended.`);
  }
}

const hashOf = (assessment: string, r: ParsedScores["rows"][number]) =>
  createHash("sha1").update(JSON.stringify([assessment, r.score, r.maxScore, r.takenOn, r.result, r.passed, r.recordingUrl])).digest("hex");

/** Keep the app's catalogue in the database, so SQL readers know what each key means. */
async function upsertCatalogue(tx: PoolClient) {
  await tx.query(
    `insert into placement.assessments (key, label, product, max_score)
     select t.key, t.label, t.product::placement.product, t.max from unnest($1::text[], $2::text[], $3::text[], $4::numeric[]) as t(key, label, product, max)
     on conflict (key) do update set label = excluded.label, product = excluded.product, max_score = excluded.max_score, updated_at = now()
     where (assessments.label, assessments.product, assessments.max_score) is distinct from (excluded.label, excluded.product, excluded.max_score)`,
    [ASSESSMENTS.map((a) => a.key), ASSESSMENTS.map((a) => a.label), ASSESSMENTS.map((a) => a.product), ASSESSMENTS.map((a) => a.max)],
  );
}

/**
 * Candidate ids by user id: everyone the export mentions who is already in the database, and a
 * new person for each user id with a score who isn't. A phone already used by someone else (or
 * twice in the export) is left out, never moved.
 */
async function resolvePeople(tx: PoolClient, parsed: ParsedScores, issues: ParseIssue[]): Promise<{ ids: Map<string, number>; added: number }> {
  const scored = new Set(parsed.rows.map((r) => r.userId));
  const mentioned = [...new Set([...scored, ...parsed.profiles.map((p) => p.userId)])];
  const existing = await tx.query<{ id: string; user_id: string; phone: string | null; name: string | null }>(
    "select id, user_id, phone, name from placement.candidates where user_id = any($1::text[])",
    [mentioned],
  );
  const ids = new Map(existing.rows.map((r) => [r.user_id, Number(r.id)]));
  const person = new Map(parsed.people.map((p) => [p.userId, p]));

  const phones = [...new Set(parsed.people.map((p) => p.phone).filter((v): v is string => Boolean(v)))];
  const taken = new Map(
    (await tx.query<{ phone: string; user_id: string | null }>("select phone, user_id from placement.candidates where phone = any($1::text[])", [phones])).rows.map((r) => [
      r.phone,
      r.user_id,
    ]),
  );
  const usable = (userId: string, phone: string | null) => {
    if (!phone) return null;
    const owner = taken.get(phone);
    if (owner !== undefined && owner !== userId) {
      issues.push({ row: 0, problem: `${userId}: phone ${phone} belongs to another person in the database — not added` });
      return null;
    }
    taken.set(phone, userId);
    return phone;
  };

  // New people (assessed: they have a score here).
  const fresh = [...scored].filter((u) => !ids.has(u));
  if (fresh.length) {
    const rows = fresh.map((u) => ({ u, phone: usable(u, person.get(u)?.phone ?? null), name: person.get(u)?.name || null }));
    const inserted = await tx.query<{ id: string; user_id: string }>(
      `insert into placement.candidates (user_id, phone, name)
       select * from unnest($1::text[], $2::text[], $3::text[])
       returning id, user_id`,
      [rows.map((r) => r.u), rows.map((r) => r.phone), rows.map((r) => r.name)],
    );
    for (const r of inserted.rows) ids.set(r.user_id, Number(r.id));
  }

  // Known people: fill a missing phone or name (the product sheets stay the authority for both).
  const fills = existing.rows
    .map((r) => {
      const p = person.get(r.user_id);
      const phone = !r.phone && p?.phone ? usable(r.user_id, p.phone) : null;
      const name = !r.name && p?.name ? p.name : null;
      return phone || name ? { id: Number(r.id), phone, name } : null;
    })
    .filter((x): x is { id: number; phone: string | null; name: string | null } => Boolean(x));
  if (fills.length) {
    await tx.query(
      `update placement.candidates c set phone = coalesce(c.phone, f.phone), name = coalesce(c.name, f.name), updated_at = now()
         from unnest($1::bigint[], $2::text[], $3::text[]) as f(id, phone, name) where c.id = f.id`,
      [fills.map((f) => f.id), fills.map((f) => f.phone), fills.map((f) => f.name)],
    );
  }
  return { ids, added: fresh.length };
}

/** Profiles merged by source rank: a stronger (lower) rank overwrites a field it has, a weaker one only fills gaps. */
async function writeProfiles(tx: PoolClient, parsed: ParsedScores, ids: Map<string, number>): Promise<number> {
  const incoming = parsed.profiles.filter((p) => ids.has(p.userId));
  if (!incoming.length) return 0;
  const rank = parsed.profileRank;
  const current = new Map(
    (
      await tx.query<{ candidate_id: string; yog: number | null; college: string | null; degree: string | null; department: string | null; source_rank: number }>(
        "select candidate_id, yog, college, degree, department, source_rank from placement.candidate_profiles where candidate_id = any($1::bigint[])",
        [incoming.map((p) => ids.get(p.userId)!)],
      )
    ).rows.map((r) => [Number(r.candidate_id), r]),
  );
  const pick = <T>(mine: T | null, theirs: T | null, stronger: boolean) => (stronger ? (mine ?? theirs) : (theirs ?? mine));
  const changed = incoming
    .map((p) => {
      const id = ids.get(p.userId)!;
      const c = current.get(id);
      const stronger = !c || rank <= c.source_rank;
      const next = {
        id,
        yog: pick(p.yog, c?.yog ?? null, stronger),
        college: pick(p.college || null, c?.college ?? null, stronger),
        degree: pick(p.degree || null, c?.degree ?? null, stronger),
        department: pick(p.department || null, c?.department ?? null, stronger),
        rank: c ? Math.min(rank, c.source_rank) : rank,
      };
      const same = c && c.yog === next.yog && c.college === next.college && c.degree === next.degree && c.department === next.department && c.source_rank === next.rank;
      return same ? null : next;
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
  if (!changed.length) return 0;
  await tx.query(
    `insert into placement.candidate_profiles (candidate_id, yog, college, degree, department, source_rank)
     select * from unnest($1::bigint[], $2::smallint[], $3::text[], $4::text[], $5::text[], $6::smallint[])
     on conflict (candidate_id) do update set yog = excluded.yog, college = excluded.college, degree = excluded.degree,
       department = excluded.department, source_rank = excluded.source_rank, updated_at = now()`,
    [changed.map((c) => c.id), changed.map((c) => c.yog), changed.map((c) => c.college), changed.map((c) => c.degree), changed.map((c) => c.department), changed.map((c) => c.rank)],
  );
  return changed.length;
}

const emptyResult = (label: string, mode: "sheet" | "csv", error: string): ScoreImportResult => ({
  ok: false,
  importId: null,
  label,
  assessment: null,
  sourceKey: "",
  mode,
  rowsRead: 0,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  removed: 0,
  skipped: [],
  people: 0,
  eligiblePeople: 0,
  peopleAdded: 0,
  profiles: 0,
  issues: [],
  error,
  ms: 0,
});

/** Import one export. Never throws: a failure comes back as ok=false and is logged. */
export async function importScores(input: ScoreImportInput, triggeredBy = "dashboard"): Promise<ScoreImportResult> {
  const t0 = Date.now();
  const parsed = parseScores(input.table, { fileName: input.fileName, examDate: input.examDate });
  const base: ScoreImportResult = {
    ...emptyResult(parsed.label || parsed.sourceLabel || input.fileName, input.mode, ""),
    assessment: parsed.assessment,
    sourceKey: parsed.sourceKey,
    rowsRead: parsed.rowsRead,
    skipped: parsed.skipped,
    issues: parsed.issues,
  };
  if (parsed.error || !parsed.assessment) return { ...base, error: parsed.error || "Nothing to import.", ms: Date.now() - t0 };
  const assessment = parsed.assessment;

  let importId: number | null = null;
  try {
    importId = Number(
      (
        await query<{ id: string }>(
          `insert into placement.score_imports (source_key, assessment, mode, source_ref, triggered_by)
           values ($1, $2, $3::placement.sync_mode, $4, $5) returning id`,
          [parsed.sourceKey, assessment, input.mode, input.sourceRef.slice(0, 300), triggeredBy.slice(0, 120)],
        )
      )[0].id,
    );
    const issues = [...parsed.issues];
    const out = await transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock($1)", [SYNC_LOCK]);
      await upsertCatalogue(tx);
      const { ids, added } = await resolvePeople(tx, parsed, issues);

      const rows = parsed.rows.map((r) => ({ ...r, id: ids.get(r.userId)!, hash: hashOf(assessment, r) }));
      const stored = (
        await tx.query<{ candidate_id: string; attempt: string }>("select candidate_id, attempt from placement.assessment_scores where source_key = $1", [parsed.sourceKey])
      ).rows;
      const keep = new Set(rows.map((r) => `${r.id}|${r.attempt}`));
      const gone = stored.filter((s) => !keep.has(`${s.candidate_id}|${s.attempt}`));
      if (!input.allowShrink && stored.length >= 10 && gone.length > stored.length * SHRINK_GUARD) throw new ShrinkError(stored.length, rows.length, gone.length);

      const written = rows.length
        ? await tx.query<{ inserted: boolean }>(
            `insert into placement.assessment_scores (candidate_id, source_key, attempt, assessment, score, max_score, taken_on, result, passed, recording_url, row_hash)
             select t.id, $1, t.attempt, $2, t.score, t.max, t.taken_on, t.result, t.passed, t.recording, t.hash
               from unnest($3::bigint[], $4::text[], $5::numeric[], $6::numeric[], $7::date[], $8::text[], $9::boolean[], $10::text[], $11::text[])
                 as t(id, attempt, score, max, taken_on, result, passed, recording, hash)
             on conflict (candidate_id, source_key, attempt) do update set assessment = excluded.assessment, score = excluded.score,
               max_score = excluded.max_score, taken_on = excluded.taken_on, result = excluded.result, passed = excluded.passed,
               recording_url = excluded.recording_url, row_hash = excluded.row_hash, updated_at = now()
             where assessment_scores.row_hash is distinct from excluded.row_hash
             returning (xmax = 0) as inserted`,
            [
              parsed.sourceKey,
              assessment,
              rows.map((r) => r.id),
              rows.map((r) => r.attempt),
              rows.map((r) => r.score),
              rows.map((r) => r.maxScore),
              rows.map((r) => r.takenOn),
              rows.map((r) => r.result || null),
              rows.map((r) => r.passed),
              rows.map((r) => r.recordingUrl),
              rows.map((r) => r.hash),
            ],
          )
        : { rows: [] as { inserted: boolean }[] };
      if (gone.length) {
        await tx.query(
          `delete from placement.assessment_scores s using unnest($2::bigint[], $3::text[]) as d(id, attempt)
            where s.source_key = $1 and s.candidate_id = d.id and s.attempt = d.attempt`,
          [parsed.sourceKey, gone.map((g) => Number(g.candidate_id)), gone.map((g) => g.attempt)],
        );
      }
      const profiles = await writeProfiles(tx, parsed, ids);
      // How many of the people with a score here are eligible for job opportunities (same rule as placement.assessed_people).
      const people = [...new Set(rows.map((r) => r.id))];
      const [{ eligible }] = (
        await tx.query<{ eligible: number }>(
          "select count(*)::int eligible from placement.candidate_standing where candidate_id = any($1::bigint[]) and eligible and best_tier <= 3",
          [people],
        )
      ).rows;
      const inserted = written.rows.filter((r) => r.inserted).length;
      return {
        inserted,
        updated: written.rows.length - inserted,
        unchanged: rows.length - written.rows.length,
        removed: gone.length,
        people: people.length,
        eligiblePeople: eligible,
        peopleAdded: added,
        profiles,
      };
    });

    const result: ScoreImportResult = { ...base, ok: true, importId, ...out, issues, ms: Date.now() - t0 };
    await query(
      `update placement.score_imports set status = 'succeeded', finished_at = now(), rows_read = $2, inserted = $3, updated = $4, unchanged = $5,
         removed = $6, skipped = $7, people_added = $8, issues = $9::jsonb where id = $1`,
      [
        importId,
        result.rowsRead,
        result.inserted,
        result.updated,
        result.unchanged,
        result.removed,
        result.skipped.reduce((s, x) => s + x.count, 0),
        result.peopleAdded,
        JSON.stringify(issues.slice(0, MAX_LOGGED_ISSUES)),
      ],
    );
    return result;
  } catch (err) {
    const message = marksTablesMissing(err) ? MARKS_NOT_SET_UP : err instanceof Error ? err.message.slice(0, 500) : "Import failed.";
    if (!(err instanceof ShrinkError)) console.error(`[scores] import of ${parsed.sourceKey} failed:`, message);
    if (importId) {
      await query("update placement.score_imports set status = 'failed', finished_at = now(), error = $2 where id = $1", [importId, message]).catch(() => {});
    }
    return {
      ...base,
      importId,
      error: message,
      ...(err instanceof ShrinkError ? { needsConfirm: { existing: err.existing, incoming: err.incoming } } : {}),
      ms: Date.now() - t0,
    };
  }
}

/** Refetch one of the readable Google Sheets tabs (see sources.ts). */
export async function syncScoreSheet(id: string, opts: { allowShrink?: boolean; triggeredBy?: string } = {}): Promise<ScoreImportResult> {
  const sheet = scoreSheets().find((s) => s.id === id);
  if (!sheet) throw new Error(`Unknown score sheet "${id}".`);
  let table: Table;
  try {
    table = await readTab(sheet.spreadsheetId, sheet.tab);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return emptyResult(sheet.label, "sheet", `Couldn't read "${sheet.tab}": ${message.slice(0, 200)}`);
  }
  return importScores({ mode: "sheet", sourceRef: `${sheet.spreadsheetId} › ${sheet.tab}`, fileName: sheet.tab, table, allowShrink: opts.allowShrink }, opts.triggeredBy ?? "dashboard");
}
