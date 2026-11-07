import "server-only";
import { databaseConfigured } from "@/lib/db/client";
import { syncAssignments } from "@/lib/mobile/assignments";

/**
 * Once a minute: new Mentor assignments, reminders, escalations and job news become pushes.
 * Runs where the automation worker runs (AUTOMATION_WORKER=on: Render), or with MOBILE_TICKER=on.
 * A sleeping free Render instance doesn't tick; POST /api/automation/tick (the sheet's 5-minute
 * sweep or any cron) wakes it and runs one pass.
 */
const g = globalThis as unknown as { __mobileTicker?: NodeJS.Timeout };
const EVERY_MS = 60_000;

export function startMobileTicker(): void {
  const on = process.env.MOBILE_TICKER === "on" || (process.env.AUTOMATION_WORKER === "on" && process.env.MOBILE_TICKER !== "off");
  if (!on || g.__mobileTicker || !databaseConfigured()) return;
  const tick = () => {
    syncAssignments()
      .then((r) => r.pushed && console.log(`[mobile] tick: ${r.checked} assigned rows, ${r.pushed} pushes`))
      .catch((err) => console.warn("[mobile] tick failed:", err instanceof Error ? err.message.slice(0, 200) : err));
  };
  g.__mobileTicker = setInterval(tick, EVERY_MS);
  g.__mobileTicker.unref?.();
  setTimeout(tick, 15_000).unref?.();
  console.log("[mobile] assignment ticker on (every 60 s)");
}
