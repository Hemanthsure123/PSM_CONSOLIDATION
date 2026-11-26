import "server-only";
import { databaseConfigured } from "@/lib/db/client";
import { syncAssignments } from "@/lib/mobile/assignments";
import { sendAcademyDigest, syncPoolInterviews } from "@/lib/mobile/pool/notify";
import { isMissingSchema } from "@/lib/mobile/pool/schema";
import { sharesTickIfDue } from "@/lib/mobile/pool/shares-sync";
import { SYNC_EVERY_MS, syncPoolIfStale } from "@/lib/mobile/pool/sync";
import { syncPrepNotifications } from "@/lib/mobile/preps/notify";
import { syncMeetings } from "@/lib/team/meetings";
import { resumeRecordings } from "@/lib/team/recordings";

/**
 * Once a minute: new Mentor assignments, reminders, escalations and job news become pushes (1.11.0:
 * blank Mentor cells are first filled from the ISE mapping, and the 09:15 / 18:00 IST task digests
 * go out; all inside syncAssignments, each step wrapped so it never stops the others), and
 * the drill-down tab's preps and interviews are synced (the SLA clock starts when a row first
 * appears) and pushed (preps/notify.ts). The Academy pool: its sheet copy every 10 minutes, the
 * company-sheet shares every hour (pool/shares-sync.ts, in the background), and the interview and
 * daily digest pushes for Academy candidates (pool/notify.ts).
 * Runs where the automation worker runs (AUTOMATION_WORKER=on: Render), or with MOBILE_TICKER=on.
 * A sleeping free Render instance doesn't tick; POST /api/automation/tick (the sheet's 5-minute
 * sweep or any cron) wakes it and runs one pass.
 */
const g = globalThis as unknown as { __mobileTicker?: NodeJS.Timeout };
const EVERY_MS = 60_000;

const short = (err: unknown) => (err instanceof Error ? err.message.slice(0, 200) : String(err));

/** One pass of both syncs; a failure of one never stops the other. */
export async function mobileTick(): Promise<{ tasks: { checked: number; pushed: number } | null; preps: { checked: number; pushed: number } | null }> {
  const [tasks, preps, kit, pool, shares, academy] = await Promise.allSettled([
    syncAssignments(),
    syncPrepNotifications(),
    prepWorkTick(),
    poolTick(),
    sharesTick(),
    academyTick(),
  ]);
  if (tasks.status === "rejected") console.warn("[mobile] task tick failed:", short(tasks.reason));
  if (pool.status === "rejected") console.warn("[mobile] pool tick failed:", short(pool.reason));
  if (shares.status === "rejected") console.warn("[mobile] company shares tick failed:", short(shares.reason));
  if (academy.status === "rejected") console.warn("[mobile] Academy interview / digest tick failed:", short(academy.reason));
  if (preps.status === "rejected") console.warn("[mobile] prep tick failed:", short(preps.reason));
  if (kit.status === "rejected") console.warn("[mobile] prep documents, meetings and calls tick failed:", short(kit.reason));
  return { tasks: tasks.status === "fulfilled" ? tasks.value : null, preps: preps.status === "fulfilled" ? preps.value : null };
}

/** The Academy priority pool's copy of the sheet, every 10 minutes. Skipped until migration 015 exists. */
async function poolTick(): Promise<void> {
  try {
    await syncPoolIfStale(SYNC_EVERY_MS, "ticker");
  } catch (err) {
    if (/relation "app.pool_\w+" does not exist/.test(short(err))) return;
    throw err;
  }
}

/**
 * The Academy candidates' company shares, hourly and single-flight (the run itself goes on in the
 * background; shares-sync.ts). Skipped until migration 020 exists; never throws into the other ticks.
 */
async function sharesTick(): Promise<void> {
  try {
    await sharesTickIfDue();
  } catch (err) {
    if (isMissingSchema(err)) return;
    console.warn("[mobile] company shares tick:", short(err));
  }
}

/** pool_interview pushes (every minute) and the 08:30 IST academy_digest. Skipped until migration 020 exists. */
async function academyTick(): Promise<void> {
  try {
    await syncPoolInterviews();
  } catch (err) {
    if (!isMissingSchema(err)) console.warn("[mobile] Academy interview pushes:", short(err));
  }
  try {
    await sendAcademyDigest();
  } catch (err) {
    if (!isMissingSchema(err)) console.warn("[mobile] Academy digest:", short(err));
  }
}

/** Meetings (due emails, reminders, Meet recordings) and interrupted call recordings. Skipped until migration 010 exists. */
async function prepWorkTick(): Promise<void> {
  try {
    await syncMeetings();
    await resumeRecordings();
  } catch (err) {
    if (/relation "app.(meetings|call_recordings)" does not exist/.test(short(err))) return;
    throw err;
  }
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
  console.log("[mobile] ticker on (every 60 s): tasks, preps, Academy pool (hourly company shares)");
}
