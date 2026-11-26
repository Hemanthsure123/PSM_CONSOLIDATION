import "server-only";
import { query } from "@/lib/db/client";

/**
 * Whether migration 021 (PSM 1.11.0) is applied: app.assignments' done / auto-assigned columns and
 * app.devices' notification-health columns. Code deployed before the migration keeps the 1.10
 * behaviour: no "Shortlisting done", no ISE auto-assignment, no device health (the rest of 1.11's
 * task pushes need no new column and run anyway). Checked at most every 5 minutes; once present it
 * stays present. A failed check counts as "not yet" and is retried at the next call.
 */

export const DONE_COLUMNS = ["done_at", "done_by", "auto_assigned", "auto_assigned_at"] as const;
export const HEALTH_COLUMNS = ["notifications_enabled", "task_channel_enabled", "battery_optimized", "background_restricted", "manufacturer", "health_at"] as const;

interface Ready {
  at: number;
  done: boolean;
  health: boolean;
}

const g = globalThis as unknown as { __schema021?: Ready };
const RECHECK_MS = 5 * 60_000;

async function check(): Promise<Ready> {
  const hit = g.__schema021;
  if (hit && ((hit.done && hit.health) || Date.now() - hit.at < RECHECK_MS)) return hit;
  try {
    const rows = await query<{ done: number; health: number }>(
      `select count(*) filter (where table_name = 'assignments' and column_name = any($1::text[]))::int as done,
              count(*) filter (where table_name = 'devices' and column_name = any($2::text[]))::int as health
         from information_schema.columns
        where table_schema = 'app' and table_name in ('assignments', 'devices')`,
      [DONE_COLUMNS, HEALTH_COLUMNS],
    );
    const ready: Ready = {
      at: Date.now(),
      done: Number(rows[0]?.done ?? 0) === DONE_COLUMNS.length,
      health: Number(rows[0]?.health ?? 0) === HEALTH_COLUMNS.length,
    };
    g.__schema021 = ready;
    return ready;
  } catch {
    // The database is unreachable: everything else fails too; don't remember the answer.
    return { at: Date.now(), done: false, health: false };
  }
}

/** done_at / done_by / auto_assigned / auto_assigned_at exist on app.assignments. */
export async function taskDoneReady(): Promise<boolean> {
  return (await check()).done;
}

/** The notification-health columns exist on app.devices. */
export async function deviceHealthReady(): Promise<boolean> {
  return (await check()).health;
}
