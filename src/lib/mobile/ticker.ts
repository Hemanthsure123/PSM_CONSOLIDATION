import "server-only";
import { databaseConfigured } from "@/lib/db/client";
import { syncAssignments } from "@/lib/mobile/assignments";
import { syncPrepNotifications } from "@/lib/mobile/preps/notify";

/**
 * Once a minute: new Mentor assignments, reminders, escalations and job news become pushes, and
 * the drill-down tab's preps and interviews are synced (the SLA clock starts when a row first
 * appears) and pushed (preps/notify.ts).
 * Runs where the automation worker runs (AUTOMATION_WORKER=on: Render), or with MOBILE_TICKER=on.
 * A sleeping free Render instance doesn't tick; POST /api/automation/tick (the sheet's 5-minute
 * sweep or any cron) wakes it and runs one pass.
 */
const g = globalThis as unknown as { __mobileTicker?: NodeJS.Timeout };
const EVERY_MS = 60_000;

const short = (err: unknown) => (err instanceof Error ? err.message.slice(0, 200) : String(err));

/** One pass of both syncs; a failure of one never stops the other. */
export async function mobileTick(): Promise<{ tasks: { checked: number; pushed: number } | null; preps: { checked: number; pushed: number } | null }> {
  const [tasks, preps] = await Promise.allSettled([syncAssignments(), syncPrepNotifications()]);
  if (tasks.status === "rejected") console.warn("[mobile] task tick failed:", short(tasks.reason));
  if (preps.status === "rejected") console.warn("[mobile] prep tick failed:", short(preps.reason));
  return { tasks: tasks.status === "fulfilled" ? tasks.value : null, preps: preps.status === "fulfilled" ? preps.value : null };
}

export function startMobileTicker(): void {
  const on = process.env.MOBILE_TICKER === "on" || (process.env.AUTOMATION_WORKER === "on" && process.env.MOBILE_TICKER !== "off");
  if (!on || g.__mobileTicker || !databaseConfigured()) return;
  const tick = () => {
    mobileTick()
      .then((r) => {
        const pushed = (r.tasks?.pushed ?? 0) + (r.preps?.pushed ?? 0);
        if (pushed) console.log(`[mobile] tick: ${r.tasks?.pushed ?? 0} task pushes, ${r.preps?.pushed ?? 0} prep pushes`);
      })
      .catch((err) => console.warn("[mobile] tick failed:", short(err)));
  };
  g.__mobileTicker = setInterval(tick, EVERY_MS);
  g.__mobileTicker.unref?.();
  setTimeout(tick, 15_000).unref?.();
  console.log("[mobile] ticker on (every 60 s): tasks + preps");
}
