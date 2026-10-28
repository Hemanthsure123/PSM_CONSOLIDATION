import "server-only";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getSheets } from "@/lib/sheets";
import { query, transaction } from "@/lib/db/client";
import { parsePool, parseResumeReference, type Table } from "@/lib/pool/parse";
import { poolSource } from "@/lib/pool/sources";
import { RULES_VERSION, bestTr2, standingOf } from "@/lib/pool/standing";
import type { AcademyRecord, Edge1Record, Edge2Record, ParseIssue, PoolRecord, Product, Standing, SyncResult } from "@/lib/pool/types";

/**
 * Sync one product's eligible pool into Postgres — from its Google Sheet, or from an
 * uploaded CSV of the same sheet. Idempotent and change-aware:
 *  - people are matched by phone, then by user id (new people are added);
 *  - a record is written only when its content changed (row_hash), so re-syncing an
 *    unchanged sheet writes nothing but a "seen" timestamp;
 *  - rows missing from the source are kept (a CSV may hold only new rows);
 *  - everything for one product runs in one transaction, under a lock, so two syncs
 *    never interleave; the standings view is refreshed after the commit;
 *  - each run is logged in placement.sync_runs with its counts and row issues.
 * Bulk statements (unnest of arrays) keep it to a handful of round trips per sync.
 */

const SYNC_LOCK = 74_210_002;
const MAX_LOGGED_ISSUES = 200;

export type SyncInput = { mode: "sheet" } | { mode: "csv"; fileName: string; table: Table };

async function readTab(spreadsheetId: string, tab: string): Promise<Table> {
  const res = await getSheets().spreadsheets.values.get({
    spreadsheetId,
    range: `'${tab.replace(/'/g, "''")}'`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return (res.data.values ?? []).map((r) => r.map((c) => String(c ?? "")));
}

const hashOf = (r: PoolRecord) => createHash("sha1").update(JSON.stringify({ v: RULES_VERSION, r })).digest("hex");

interface Prepared {
  record: PoolRecord;
  standing: Standing;
  hash: string;
  candidateId: number;
}

/** Find or create each record's person; fill a missing phone / user id / name on the way. */
async function resolveCandidates(tx: PoolClient, records: PoolRecord[], issues: ParseIssue[]): Promise<number[]> {
  const phones = [...new Set(records.map((r) => r.phone).filter((v): v is string => Boolean(v)))];
  const users = [...new Set(records.map((r) => r.userId).filter((v): v is string => Boolean(v)))];
  const existing = (
    await tx.query<{ id: string; phone: string | null; user_id: string | null; name: string | null }>(
      "select id, phone, user_id, name from placement.candidates where phone = any($1::text[]) or user_id = any($2::text[])",
      [phones, users],
    )
  ).rows.map((r) => ({ ...r, id: Number(r.id) }));
  const byPhone = new Map(existing.filter((c) => c.phone).map((c) => [c.phone!, c]));
  const byUser = new Map(existing.filter((c) => c.user_id).map((c) => [c.user_id!, c]));

  const ids: (number | null)[] = [];
  const fresh: { idx: number; phone: string | null; userId: string | null; name: string }[] = [];
  const fills: { id: number; phone: string | null; userId: string | null; name: string }[] = [];
  records.forEach((r, idx) => {
    const p = r.phone ? byPhone.get(r.phone) : undefined;
    const u = r.userId ? byUser.get(r.userId) : undefined;
    if (p && u && p.id !== u.id) {
      issues.push({ row: 0, problem: `${r.name || r.phone}: phone and user id belong to two different people in the database — matched by phone` });
    }
    const found = p ?? u;
    if (!found) {
      ids.push(null);
      fresh.push({ idx, phone: r.phone, userId: r.userId, name: r.name });
      return;
    }
    ids.push(found.id);
    const phone = !found.phone && r.phone && !byPhone.has(r.phone) ? r.phone : null;
    const userId = !found.user_id && r.userId && !byUser.has(r.userId) ? r.userId : null;
    if (phone || userId || (r.name && r.name !== found.name)) fills.push({ id: found.id, phone, userId, name: r.name });
  });

  if (fresh.length) {
    const inserted = await tx.query<{ id: string; phone: string | null; user_id: string | null }>(
      `insert into placement.candidates (phone, user_id, name)
       select * from unnest($1::text[], $2::text[], $3::text[])
       returning id, phone, user_id`,
      [fresh.map((f) => f.phone), fresh.map((f) => f.userId), fresh.map((f) => f.name || null)],
    );
    // RETURNING keeps no input order guarantee: map back by phone / user id.
    const back = new Map<string, number>();
    for (const row of inserted.rows) {
      if (row.phone) back.set(`p:${row.phone}`, Number(row.id));
      if (row.user_id) back.set(`u:${row.user_id}`, Number(row.id));
    }
    for (const f of fresh) ids[f.idx] = back.get(f.phone ? `p:${f.phone}` : `u:${f.userId}`) ?? null;
  }
  if (fills.length) {
    await tx.query(
      `update placement.candidates c
          set phone = coalesce(c.phone, u.phone),
              user_id = coalesce(c.user_id, u.user_id),
              name = coalesce(nullif(u.name, ''), c.name),
              updated_at = now()
         from unnest($1::bigint[], $2::text[], $3::text[], $4::text[]) as u(id, phone, user_id, name)
        where c.id = u.id`,
      [fills.map((f) => f.id), fills.map((f) => f.phone), fills.map((f) => f.userId), fills.map((f) => f.name)],
    );
  }
  if (ids.some((x) => x === null)) throw new Error("Could not resolve every candidate id — nothing was written.");
  return ids as number[];
}

interface Column {
  name: string;
  /** Postgres array type of the parameter, e.g. "text[]". */
  type: string;
  /** Cast applied in the SELECT (enums). */
  cast?: string;
  values: unknown[];
}

/** Bulk upsert keyed by candidate_id; only rows whose row_hash changed are written. */
async function upsert(tx: PoolClient, table: string, cols: Column[], keepIfNull: string[] = []): Promise<{ id: number; inserted: boolean }[]> {
  const names = cols.map((c) => c.name);
  const select = cols.map((c, i) => `${c.cast ? `t.c${i}::${c.cast}` : `t.c${i}`}`).join(", ");
  const sets = names
    .filter((n) => n !== "candidate_id")
    .map((n) => (keepIfNull.includes(n) ? `${n} = coalesce(excluded.${n}, ${table}.${n})` : `${n} = excluded.${n}`))
    .join(", ");
  const sql = `
    insert into ${table} (${names.join(", ")})
    select ${select} from unnest(${cols.map((c, i) => `$${i + 1}::${c.type}`).join(", ")}) as t(${cols.map((_, i) => `c${i}`).join(", ")})
    on conflict (candidate_id) do update set ${sets}, updated_at = now(), last_seen_at = now()
    where ${table}.row_hash is distinct from excluded.row_hash
    returning candidate_id, (xmax = 0) as inserted`;
  const res = await tx.query<{ candidate_id: string; inserted: boolean }>(sql, cols.map((c) => c.values));
  return res.rows.map((r) => ({ id: Number(r.candidate_id), inserted: r.inserted }));
}

function commonColumns(prepared: Prepared[], mode: "sheet" | "csv", idColumn = "user_id"): Column[] {
  return [
    { name: "candidate_id", type: "bigint[]", values: prepared.map((p) => p.candidateId) },
    { name: idColumn, type: "text[]", values: prepared.map((p) => p.record.userId) },
    { name: "phone", type: "text[]", values: prepared.map((p) => p.record.phone) },
    { name: "name", type: "text[]", values: prepared.map((p) => p.record.name || null) },
    { name: "reference_resume_url", type: "text[]", values: prepared.map((p) => p.record.referenceResumeUrl) },
    { name: "tier", type: "smallint[]", values: prepared.map((p) => p.standing.tier) },
    { name: "stage_label", type: "text[]", values: prepared.map((p) => p.standing.label) },
    { name: "internal_score", type: "smallint[]", values: prepared.map((p) => p.standing.internalScore) },
    { name: "eligible", type: "boolean[]", values: prepared.map((p) => p.standing.eligible) },
    { name: "row_hash", type: "text[]", values: prepared.map((p) => p.hash) },
    { name: "source", type: "text[]", cast: "placement.sync_mode", values: prepared.map(() => mode) },
  ];
}

async function writeEdge1(tx: PoolClient, prepared: Prepared[], mode: "sheet" | "csv") {
  const r = (p: Prepared) => p.record as Edge1Record;
  return upsert(
    tx,
    "placement.edge1_records",
    [
      ...commonColumns(prepared, mode),
      { name: "assessment_status", type: "text[]", values: prepared.map((p) => r(p).assessmentStatus || null) },
      { name: "tr1_status", type: "text[]", values: prepared.map((p) => r(p).tr1Status || null) },
      { name: "tr2_status", type: "text[]", values: prepared.map((p) => r(p).tr2Status || null) },
    ],
    ["reference_resume_url"],
  );
}

async function writeEdge2(tx: PoolClient, prepared: Prepared[], mode: "sheet" | "csv") {
  const r = (p: Prepared) => p.record as Edge2Record;
  const n = (f: (x: Edge2Record) => number | null): Column["values"] => prepared.map((p) => f(r(p)));
  const changed = await upsert(
    tx,
    "placement.edge2_records",
    [
      ...commonColumns(prepared, mode),
      { name: "candidate_stage", type: "text[]", values: prepared.map((p) => r(p).candidateStage) },
      { name: "offline_overall_score", type: "numeric[]", values: n((x) => x.offlineOverallScore) },
      { name: "dsa_coding_score", type: "numeric[]", values: n((x) => x.dsaCodingScore) },
      { name: "cs_fundamentals_score", type: "numeric[]", values: n((x) => x.csFundamentalsScore) },
      { name: "sql_mcq_score", type: "numeric[]", values: n((x) => x.sqlMcqScore) },
      { name: "sql_coding_score", type: "numeric[]", values: n((x) => x.sqlCodingScore) },
      { name: "tr1_self_intro", type: "numeric[]", values: n((x) => x.tr1.selfIntro) },
      { name: "tr1_dsa_overall", type: "numeric[]", values: n((x) => x.tr1.dsaOverall) },
      { name: "tr1_problem_solving", type: "numeric[]", values: n((x) => x.tr1.problemSolving) },
      { name: "tr1_coding", type: "numeric[]", values: n((x) => x.tr1.coding) },
      { name: "tr1_communication", type: "numeric[]", values: n((x) => x.tr1.communication) },
      { name: "tr1_debugging", type: "numeric[]", values: n((x) => x.tr1.debugging) },
      { name: "tr1_overall_technical", type: "numeric[]", values: n((x) => x.tr1.overallTechnical) },
      { name: "tr2_best_verdict", type: "text[]", cast: "placement.verdict", values: prepared.map((p) => bestTr2(r(p).tr2)?.verdict ?? null) },
      { name: "tr2_best_track", type: "text[]", cast: "placement.tr2_track", values: prepared.map((p) => bestTr2(r(p).tr2)?.track ?? null) },
    ],
    ["reference_resume_url"],
  );
  const ids = changed.map((c) => c.id);
  if (ids.length) {
    await tx.query("delete from placement.edge2_tr2_verdicts where candidate_id = any($1::bigint[])", [ids]);
    const set = new Set(ids);
    const rows = prepared.filter((p) => set.has(p.candidateId)).flatMap((p) => r(p).tr2.map((v) => ({ id: p.candidateId, ...v })));
    if (rows.length) {
      await tx.query(
        `insert into placement.edge2_tr2_verdicts (candidate_id, track, verdict)
         select t.id, t.track::placement.tr2_track, t.verdict::placement.verdict
           from unnest($1::bigint[], $2::text[], $3::text[]) as t(id, track, verdict)`,
        [rows.map((x) => x.id), rows.map((x) => x.track), rows.map((x) => x.verdict)],
      );
    }
  }
  return changed;
}

async function writeAcademy(tx: PoolClient, prepared: Prepared[], mode: "sheet" | "csv") {
  const r = (p: Prepared) => p.record as AcademyRecord;
  const changed = await upsert(
    tx,
    "placement.academy_records",
    [
      ...commonColumns(prepared, mode, "uid"),
      { name: "yog", type: "smallint[]", values: prepared.map((p) => r(p).yog) },
      { name: "old_bucket", type: "text[]", cast: "placement.academy_bucket", values: prepared.map((p) => r(p).oldBucket) },
      { name: "dsa_offline_status", type: "text[]", values: prepared.map((p) => r(p).dsaOfflineStatus || null) },
      { name: "dsa_offline_cleared", type: "boolean[]", values: prepared.map((p) => r(p).dsaOfflineCleared) },
      { name: "previous_placement", type: "text[]", values: prepared.map((p) => r(p).previousPlacement || null) },
      { name: "student_preference", type: "text[]", values: prepared.map((p) => r(p).studentPreference || null) },
      { name: "active_pool", type: "boolean[]", values: prepared.map((p) => r(p).activePool) },
    ],
    ["reference_resume_url"],
  );
  const ids = changed.map((c) => c.id);
  if (ids.length) {
    const set = new Set(ids);
    const mine = prepared.filter((p) => set.has(p.candidateId));
    await tx.query("delete from placement.academy_rounds where candidate_id = any($1::bigint[])", [ids]);
    await tx.query("delete from placement.academy_competency where candidate_id = any($1::bigint[])", [ids]);
    const rounds = mine.flatMap((p) => r(p).rounds.map((x) => ({ id: p.candidateId, ...x })));
    if (rounds.length) {
      await tx.query(
        `insert into placement.academy_rounds (candidate_id, bucket, round, score, status, cleared)
         select t.id, t.bucket::placement.academy_bucket, t.round, t.score, t.status, t.cleared
           from unnest($1::bigint[], $2::text[], $3::smallint[], $4::numeric[], $5::text[], $6::boolean[]) as t(id, bucket, round, score, status, cleared)`,
        [rounds.map((x) => x.id), rounds.map((x) => x.bucket), rounds.map((x) => x.round), rounds.map((x) => x.score), rounds.map((x) => x.status || null), rounds.map((x) => x.cleared)],
      );
    }
    const comp = mine.flatMap((p) => r(p).competency.map((x) => ({ id: p.candidateId, ...x })));
    if (comp.length) {
      await tx.query(
        `insert into placement.academy_competency (candidate_id, subject, overall_score, verdict_band, clearance_status, cleared, level, level_label)
         select t.id, t.subject::placement.competency_subject, t.score, t.band, t.clearance, t.cleared, t.level, t.label
           from unnest($1::bigint[], $2::text[], $3::numeric[], $4::text[], $5::text[], $6::boolean[], $7::smallint[], $8::text[])
             as t(id, subject, score, band, clearance, cleared, level, label)`,
        [
          comp.map((x) => x.id),
          comp.map((x) => x.subject),
          comp.map((x) => x.overallScore),
          comp.map((x) => x.verdictBand || null),
          comp.map((x) => x.clearanceStatus || null),
          comp.map((x) => x.cleared),
          comp.map((x) => x.level),
          comp.map((x) => x.levelLabel || null),
        ],
      );
    }
  }
  return changed;
}

const TABLE: Record<Product, string> = {
  edge1: "placement.edge1_records",
  edge2: "placement.edge2_records",
  academy: "placement.academy_records",
};

/** Sync one product. Never throws: a failure comes back as ok=false and is logged in sync_runs. */
export async function syncPool(product: Product, input: SyncInput, triggeredBy = "dashboard"): Promise<SyncResult> {
  const t0 = Date.now();
  const source = poolSource(product);
  const sourceRef = input.mode === "sheet" ? `${source.spreadsheetId} › ${source.tab}` : input.fileName;
  const base: SyncResult = { product, mode: input.mode, ok: false, runId: null, rowsRead: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0, issues: [], error: "", ms: 0 };
  let runId: number | null = null;
  try {
    runId = Number(
      (
        await query<{ id: string }>(
          "insert into placement.sync_runs (product, mode, source_ref, triggered_by) values ($1::placement.product, $2::placement.sync_mode, $3, $4) returning id",
          [product, input.mode, sourceRef.slice(0, 300), triggeredBy.slice(0, 120)],
        )
      )[0].id,
    );

    const table = input.mode === "sheet" ? await readTab(source.spreadsheetId, source.tab) : input.table;
    // Edge 2.0's reference resume links live in the PII tab (by phone, then user id).
    let reference: ReturnType<typeof parseResumeReference> | undefined;
    if (product === "edge2" && source.referenceTab) {
      reference = await readTab(source.spreadsheetId, source.referenceTab)
        .then(parseResumeReference)
        .catch(() => undefined);
    }
    const parsed = parsePool(product, table, reference);
    if (parsed.missingColumns.length) throw new Error(`Missing column${parsed.missingColumns.length > 1 ? "s" : ""}: ${parsed.missingColumns.join(", ")}`);
    if (!parsed.records.length) throw new Error("No candidate rows found.");
    const issues = [...parsed.issues];

    const result = await transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock($1)", [SYNC_LOCK]);
      const ids = await resolveCandidates(tx, parsed.records, issues);
      const prepared: Prepared[] = parsed.records.map((record, i) => ({ record, standing: standingOf(record), hash: hashOf(record), candidateId: ids[i] }));
      const changed =
        product === "edge1" ? await writeEdge1(tx, prepared, input.mode) : product === "edge2" ? await writeEdge2(tx, prepared, input.mode) : await writeAcademy(tx, prepared, input.mode);
      // Rows written above already have last_seen_at = now(); stamp the unchanged ones too.
      await tx.query(`update ${TABLE[product]} set last_seen_at = now() where candidate_id = any($1::bigint[]) and last_seen_at < now()`, [ids]);
      return { changed, total: prepared.length };
    });
    await query("refresh materialized view concurrently placement.candidate_standing");

    const inserted = result.changed.filter((c) => c.inserted).length;
    const updated = result.changed.length - inserted;
    const out: SyncResult = {
      ...base,
      ok: true,
      runId,
      rowsRead: parsed.rowsRead,
      inserted,
      updated,
      unchanged: result.total - result.changed.length,
      skipped: parsed.rowsRead - result.total,
      issues,
      ms: Date.now() - t0,
    };
    await query(
      `update placement.sync_runs set status = 'succeeded', finished_at = now(), rows_read = $2, inserted = $3, updated = $4, unchanged = $5, skipped = $6, issues = $7::jsonb where id = $1`,
      [runId, out.rowsRead, out.inserted, out.updated, out.unchanged, out.skipped, JSON.stringify(issues.slice(0, MAX_LOGGED_ISSUES))],
    );
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : "Sync failed.";
    console.error(`[pool] ${product} sync failed:`, message);
    if (runId) {
      await query("update placement.sync_runs set status = 'failed', finished_at = now(), error = $2 where id = $1", [runId, message]).catch(() => {});
    }
    return { ...base, runId, error: message, ms: Date.now() - t0 };
  }
}
