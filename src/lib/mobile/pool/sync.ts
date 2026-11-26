import "server-only";
import { createHash } from "node:crypto";
import { query, transaction } from "@/lib/db/client";
import { poolSource } from "@/lib/pool/sources";
import { readTab } from "@/lib/pool/sync";
import { type AssignedChange, notifyAssigned } from "@/lib/mobile/pool/notify";
import { parsePoolRows, type PoolSheetRow } from "@/lib/mobile/pool/parse";
import { academySchemaReady } from "@/lib/mobile/pool/schema";

/**
 * Copies the Academy sheet's assessed rows into app.pool_candidates (only the agreed columns, see
 * parse.ts): since 1.10.0 every row with a UID, assigned or not (mentor_name "" = unassigned); before
 * migration 020 only the mentored rows. The app reads the database, never the sheet, so the pool
 * opens instantly.
 *  - Change-aware: a row is rewritten only when its content hash changed.
 *  - Nothing mentors added is touched (pool_state / pool_resumes / pool_events are theirs).
 *  - A row that left the tab is marked removed (kept); re-added, it comes back.
 *  - A MENTOR newly set to a roster mentor pushes pool_assigned to them (after the write; the first
 *    sync after migration 020 is a baseline, see notify.ts).
 *  - One write at a time (transaction-level advisory lock: the app's pooler is transaction mode);
 *    each run is logged in app.pool_syncs.
 *  - Safety: a read that returns no rows at all while the table has many, or no mentored rows while
 *    many were mentored, is treated as a broken read (renamed column, emptied tab) and changes nothing.
 */

/** The same Academy sheet and tab as the eligible pool (POOL_ACADEMY_SHEET / POOL_ACADEMY_TAB override both). */
export const POOL_SHEET = poolSource("academy");

const LOCK = 74_210_015;
/** The ticker syncs when the last successful sync is older than this. */
export const SYNC_EVERY_MS = 10 * 60_000;
/** A person's "Refresh" re-reads the sheet at most this often. */
export const MANUAL_SYNC_MIN_MS = 60_000;

export interface PoolSyncResult {
  status: "succeeded" | "failed" | "skipped";
  rowsRead: number;
  active: number;
  added: number;
  updated: number;
  removed: number;
  issues: { row: number; message: string }[];
  error?: string;
  syncedAt: string | null;
}

const hashOf = (r: PoolSheetRow) =>
  createHash("sha1")
    .update(JSON.stringify([r.name, r.email, r.phone, r.yog, r.location, r.college, r.course, r.specialization, r.techStack, r.track, r.mentor, r.sheetRow]))
    .digest("hex");

/** When the pool was last synced successfully (null: never). */
export async function lastPoolSync(): Promise<Date | null> {
  const rows = await query<{ at: Date }>("select max(finished_at) at from app.pool_syncs where status = 'succeeded'");
  return rows[0]?.at ?? null;
}

/** Syncs when the last good sync is older than [maxAgeMs]. Cheap to call often (one indexed read). */
export async function syncPoolIfStale(maxAgeMs: number, by: string): Promise<PoolSyncResult | null> {
  const rows = await query<{ ok: Date | null; tried: Date | null }>(
    "select max(finished_at) filter (where status = 'succeeded') ok, max(started_at) tried from app.pool_syncs",
  );
  const ok = rows[0]?.ok;
  const tried = rows[0]?.tried;
  if (ok && Date.now() - ok.getTime() < maxAgeMs) return null;
  // After a failed read, wait 2 minutes before trying again (Sheets outages, quota).
  if (tried && Date.now() - tried.getTime() < RETRY_AFTER_FAILURE_MS) return null;
  return syncPool(by);
}

const RETRY_AFTER_FAILURE_MS = 2 * 60_000;

/** [table]: the tab's cells already read (tests); otherwise the sheet is read. */
export async function syncPool(by: string, table?: string[][]): Promise<PoolSyncResult> {
  const empty = { rowsRead: 0, active: 0, added: 0, updated: 0, removed: 0, issues: [] as PoolSyncResult["issues"] };
  const startedAt = new Date();
  const log = (status: "succeeded" | "failed", r: Omit<PoolSyncResult, "status" | "syncedAt">) =>
    query(
      `insert into app.pool_syncs (started_at, finished_at, status, rows_read, active, added, updated, removed, issues, error, triggered_by)
       values ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [startedAt, status, r.rowsRead, r.active, r.added, r.updated, r.removed, JSON.stringify(r.issues.slice(0, 200)), r.error ?? null, by.slice(0, 120)],
    );
  try {
    // The sheet is read outside the transaction, so the write transaction stays a few milliseconds.
    table ??= await readTab(POOL_SHEET.spreadsheetId, POOL_SHEET.tab);
    // Before migration 020 the table can't hold unassigned rows (mentor_name must be filled).
    const allRows = await academySchemaReady().catch(() => false);
    const parsed = parsePoolRows(table, { assignedOnly: !allRows });
    const assigned: AssignedChange[] = [];
    const result = await transaction(async (tx) => {
      // Another sync is writing right now: it has the same sheet, so this one steps aside.
      const lock = await tx.query<{ ok: boolean }>("select pg_try_advisory_xact_lock($1) ok", [LOCK]);
      if (!lock.rows[0]?.ok) return null;
      const existing = await tx.query<{ uid: string; row_hash: string; removed_at: Date | null; mentor_name: string }>(
        "select uid, row_hash, removed_at, mentor_name from app.pool_candidates",
      );
      const known = new Map(existing.rows.map((r) => [r.uid, r]));
      const activeBefore = existing.rows.filter((r) => !r.removed_at).length;
      const mentoredBefore = existing.rows.filter((r) => !r.removed_at && r.mentor_name.trim()).length;
      if (!parsed.rows.length && activeBefore >= 10) {
        throw new Error("The pool tab returned no rows; nothing was changed (check the UID and MENTOR columns).");
      }
      if (mentoredBefore >= 10 && !parsed.rows.some((r) => r.mentor)) {
        throw new Error("The pool tab returned no mentored rows; nothing was changed (check the MENTOR column).");
      }
      let added = 0;
      let updated = 0;
      const changed: PoolSheetRow[] = [];
      for (const r of parsed.rows) {
        const k = known.get(r.uid);
        const before = k && !k.removed_at ? k.mentor_name : "";
        if (r.mentor && r.mentor.trim().toLowerCase() !== before.trim().toLowerCase()) {
          assigned.push({ uid: r.uid, name: r.name, track: r.track, mentor: r.mentor, prevMentor: k ? k.mentor_name : "" });
        }
        if (!k) added++;
        else if (k.row_hash !== hashOf(r) || k.removed_at) updated++;
        else continue;
        changed.push(r);
      }
      if (changed.length) {
        await tx.query(
          `insert into app.pool_candidates (uid, name, email, phone, yog, location, college, course, specialization, sheet_tech_stack, sheet_track, mentor_name, sheet_row, row_hash)
           select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::smallint[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::int[], $14::text[])
           on conflict (uid) do update set name = excluded.name, email = excluded.email, phone = excluded.phone, yog = excluded.yog,
             location = excluded.location, college = excluded.college, course = excluded.course, specialization = excluded.specialization,
             sheet_tech_stack = excluded.sheet_tech_stack, sheet_track = excluded.sheet_track, mentor_name = excluded.mentor_name,
             sheet_row = excluded.sheet_row, row_hash = excluded.row_hash, removed_at = null, last_seen_at = now(), updated_at = now()`,
          [
            changed.map((r) => r.uid),
            changed.map((r) => r.name),
            changed.map((r) => r.email),
            changed.map((r) => r.phone),
            changed.map((r) => r.yog),
            changed.map((r) => r.location),
            changed.map((r) => r.college),
            changed.map((r) => r.course),
            changed.map((r) => r.specialization),
            changed.map((r) => r.techStack),
            changed.map((r) => r.track),
            changed.map((r) => r.mentor),
            changed.map((r) => r.sheetRow),
            changed.map(hashOf),
          ],
        );
      }
      const present = parsed.rows.map((r) => r.uid);
      await tx.query("update app.pool_candidates set last_seen_at = now() where uid = any($1::text[]) and removed_at is null", [present]);
      const gone = await tx.query("update app.pool_candidates set removed_at = now(), updated_at = now() where removed_at is null and not (uid = any($1::text[]))", [present]);
      return { added, updated, removed: gone.rowCount ?? 0, active: parsed.rows.length };
    });
    if (!result) return { status: "skipped", ...empty, syncedAt: (await lastPoolSync())?.toISOString() ?? null };
    const counts = { rowsRead: parsed.read, ...result, issues: parsed.issues };
    await log("succeeded", counts);
    // After the write: a failed push never undoes the copy.
    const pushed = await notifyAssigned(assigned, startedAt.toISOString()).catch((err) => {
      console.warn("[pool] assignment pushes failed:", err instanceof Error ? err.message.slice(0, 160) : err);
      return 0;
    });
    if (pushed) console.log(`[pool] ${pushed} pool_assigned pushes`);
    if (result.added || result.updated || result.removed) {
      console.log(`[pool] synced: ${result.active} active, +${result.added} ~${result.updated} -${result.removed}, ${parsed.issues.length} row issues`);
    }
    return { status: "succeeded", ...counts, syncedAt: new Date().toISOString() };
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : String(err);
    await log("failed", { ...empty, error: message }).catch(() => undefined);
    console.warn("[pool] sync failed:", message);
    return { status: "failed", ...empty, error: message, syncedAt: (await lastPoolSync().catch(() => null))?.toISOString() ?? null };
  }
}
