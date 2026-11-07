import "server-only";
import { createHash } from "node:crypto";
import { databaseConfigured, query } from "@/lib/db/client";

/**
 * Content caches for screening (migration 008). Everything here is an optimisation: a cache
 * miss, a database that isn't configured or a failing query only means the work is done
 * again, never a different answer and never an error for the caller.
 *
 *  - resume cache: what a resume FILE contains (PDF text + links, or a scan's transcription),
 *    keyed by the SHA-256 of its bytes, so the same file is never parsed or transcribed twice;
 *  - judgement cache: one model judgement keyed by a hash of every input it depends on.
 */

export const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

/** Bump when what the PDF reader extracts changes (old rows are then simply not found). */
export const PDF_READER_VERSION = 1;
/** Bump when the scan transcription prompt / schema changes. */
export const OCR_READER_VERSION = 1;

/** Rows unused this long are deleted by the worker's housekeeping. */
const RETENTION_DAYS = 90;

const enabled = () => {
  try {
    return databaseConfigured();
  } catch {
    return false;
  }
};

const warnOnce = new Set<string>();
function quiet(where: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  // A missing table (migration not applied yet) or an outage: say so once, then stay silent.
  if (warnOnce.has(where)) return;
  warnOnce.add(where);
  console.warn(`[resume-cache] ${where} unavailable (${msg.slice(0, 160)}) — working without the cache.`);
}

export async function readResumeCache<T>(hash: string, kind: "pdf" | "ocr", version: number): Promise<T | null> {
  if (!enabled()) return null;
  try {
    const rows = await query<{ data: T }>(
      `update automation.resume_cache set used_at = now()
        where content_hash = $1 and kind = $2 and version = $3 returning data`,
      [hash, kind, version],
    );
    return rows[0]?.data ?? null;
  } catch (err) {
    quiet("resume cache read", err);
    return null;
  }
}

export async function writeResumeCache(hash: string, kind: "pdf" | "ocr", version: number, data: unknown, bytes: number): Promise<void> {
  if (!enabled()) return;
  try {
    await query(
      `insert into automation.resume_cache (content_hash, kind, version, data, bytes) values ($1, $2, $3, $4::jsonb, $5)
       on conflict (content_hash, kind, version) do update set data = excluded.data, used_at = now()`,
      [hash, kind, version, JSON.stringify(data), bytes],
    );
  } catch (err) {
    quiet("resume cache write", err);
  }
}

export async function readJudgement<T>(key: string): Promise<{ data: T; scoredBy: string } | null> {
  if (!enabled()) return null;
  try {
    const rows = await query<{ data: T; scored_by: string }>(
      "update automation.judgement_cache set used_at = now() where key = $1 returning data, scored_by",
      [key],
    );
    return rows[0] ? { data: rows[0].data, scoredBy: rows[0].scored_by } : null;
  } catch (err) {
    quiet("judgement cache read", err);
    return null;
  }
}

export async function writeJudgement(key: string, scoredBy: string, data: unknown): Promise<void> {
  if (!enabled()) return;
  try {
    await query(
      `insert into automation.judgement_cache (key, scored_by, data) values ($1, $2, $3::jsonb)
       on conflict (key) do update set scored_by = excluded.scored_by, data = excluded.data, used_at = now()`,
      [key, scoredBy, JSON.stringify(data)],
    );
  } catch (err) {
    quiet("judgement cache write", err);
  }
}

/** Housekeeping: drop cache rows nobody used for RETENTION_DAYS (resume content isn't kept forever). */
export async function pruneContentCaches(): Promise<void> {
  if (!enabled()) return;
  for (const table of ["automation.resume_cache", "automation.judgement_cache"]) {
    await query(`delete from ${table} where used_at < now() - make_interval(days => $1)`, [RETENTION_DAYS]).catch((err) => quiet(`${table} prune`, err));
  }
}
