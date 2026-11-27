import "server-only";
import { query } from "@/lib/db/client";

/**
 * Whether migration 020 (Academy shares, all assessed rows, 1.10.0 notifications) is applied. Code
 * deployed before the migration keeps the 1.9 behaviour: the pool keeps only mentored rows, and the
 * shares sync, interview pushes and digest stay off. Checked at most every 5 minutes; once present
 * it stays present.
 */

const g = globalThis as unknown as { __academySchema?: { at: number; ok: boolean } };
const RECHECK_MS = 5 * 60_000;

export async function academySchemaReady(): Promise<boolean> {
  const hit = g.__academySchema;
  if (hit && (hit.ok || Date.now() - hit.at < RECHECK_MS)) return hit.ok;
  const rows = await query<{ ok: boolean }>(
    "select (to_regclass('app.company_shares') is not null and to_regclass('app.sync_marks') is not null and to_regclass('app.pool_interview_marks') is not null) as ok",
  );
  const ok = Boolean(rows[0]?.ok);
  g.__academySchema = { at: Date.now(), ok };
  return ok;
}

const gc = globalThis as unknown as { __companiesSchema?: { at: number; ok: boolean } };

/**
 * Whether migration 022 (requirements, HubSpot deals, tentative starts, company_shares.status) is
 * applied. Until it is, Companies answers 503 not_ready and the sync keeps the 1.11 behaviour.
 */
export async function companiesSchemaReady(): Promise<boolean> {
  const hit = gc.__companiesSchema;
  if (hit && (hit.ok || Date.now() - hit.at < RECHECK_MS)) return hit.ok;
  const rows = await query<{ ok: boolean }>(
    `select (to_regclass('app.crp_requirements') is not null and to_regclass('app.hubspot_deals') is not null
             and to_regclass('app.requirement_starts') is not null
             and exists (select 1 from information_schema.columns where table_schema = 'app' and table_name = 'company_shares' and column_name = 'status')) as ok`,
  );
  const ok = Boolean(rows[0]?.ok);
  gc.__companiesSchema = { at: Date.now(), ok };
  return ok;
}

/** "relation app.company_shares does not exist" and the like: the migration isn't applied (yet). */
export const isMissingSchema = (err: unknown) => /relation "app\.(company_\w+|sync_marks|pool_interview_marks)" does not exist/.test(err instanceof Error ? err.message : String(err));

/** Whether [name] has run before (its first run is a baseline: it records, it doesn't notify). */
export async function hasRunBefore(name: string): Promise<boolean> {
  if (ran.has(name)) return true;
  const yes = (await query("select 1 from app.sync_marks where name = $1", [name])).length > 0;
  if (yes) ran.add(name);
  return yes;
}

/** Records that [name] has completed its first (baseline) run. */
export async function markRun(name: string): Promise<void> {
  await query("insert into app.sync_marks (name) values ($1) on conflict (name) do nothing", [name]);
  ran.add(name);
}

const gm = globalThis as unknown as { __syncMarks?: Set<string> };
const ran = (gm.__syncMarks ??= new Set<string>());
