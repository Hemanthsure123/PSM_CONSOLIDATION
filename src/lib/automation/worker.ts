import "server-only";
import { randomUUID } from "node:crypto";
import { databaseConfigured } from "@/lib/db/client";
import { runJob } from "@/lib/automation/orchestrator";
import { claimJob, pruneOldCheckpoints } from "@/lib/automation/store";

/**
 * The background worker, inside the web server process (one instance). It takes jobs from the
 * database one at a time — the job record and its checkpoints are the source of truth, so a
 * restart loses nothing: on boot, and every 30 s, it claims the oldest waiting job or one whose
 * worker went silent (lease expired) and continues it.
 *
 * Render's free instance sleeps after 15 minutes without incoming requests. While a job runs,
 * the worker calls the app's own public /api/health every 4 minutes (RENDER_EXTERNAL_URL) so the
 * instance stays awake until the job ends; the sheet's Apps Script check-ins also wake it.
 *
 * On only where AUTOMATION_WORKER=on (the deployment), so a developer's local server never
 * competes for jobs.
 */

const g = globalThis as unknown as {
  __automationWorker?: { owner: string; busy: boolean; timer: ReturnType<typeof setInterval> | null; keepAwake: ReturnType<typeof setInterval> | null };
};

export const workerEnabled = () => process.env.AUTOMATION_WORKER === "on" && databaseConfigured();

const TICK_MS = 30_000;
const KEEP_AWAKE_MS = 4 * 60_000;

function keepAwake(on: boolean) {
  const w = g.__automationWorker!;
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!on || !url) {
    if (w.keepAwake) clearInterval(w.keepAwake);
    w.keepAwake = null;
    return;
  }
  if (w.keepAwake) return;
  w.keepAwake = setInterval(() => {
    fetch(`${url.replace(/\/$/, "")}/api/health`, { cache: "no-store" }).catch(() => undefined);
  }, KEEP_AWAKE_MS);
}

async function tick(): Promise<void> {
  const w = g.__automationWorker;
  if (!w || w.busy) return;
  w.busy = true;
  try {
    for (;;) {
      const job = await claimJob(w.owner);
      if (!job) break;
      keepAwake(true);
      console.log(`[automation] job ${job.id}: claimed (attempt ${job.attempts}, step ${job.step}).`);
      await runJob(job, w.owner);
    }
  } catch (err) {
    console.warn("[automation] worker tick failed:", err instanceof Error ? err.message : err);
  } finally {
    keepAwake(false);
    w.busy = false;
  }
}

/** Start the worker once per process (instrumentation.ts). */
export function startWorker(): void {
  if (!workerEnabled() || g.__automationWorker) return;
  g.__automationWorker = { owner: `${process.env.RENDER_INSTANCE_ID ?? "local"}:${process.pid}:${randomUUID().slice(0, 8)}`, busy: false, timer: null, keepAwake: null };
  g.__automationWorker.timer = setInterval(() => void tick(), TICK_MS);
  console.log(`[automation] worker started (${g.__automationWorker.owner}).`);
  void pruneOldCheckpoints();
  setTimeout(() => void tick(), 3_000);
}

/** Look for work now (a new job was just queued, or someone checked on one). */
export function kickWorker(): void {
  if (!workerEnabled()) return;
  if (!g.__automationWorker) startWorker();
  setTimeout(() => void tick(), 0);
}
