import { monitorEventLoopDelay } from "node:perf_hooks";

/**
 * Back-pressure for the free plan (512 MB, 0.1 CPU): how many units of work to run at once.
 * Read on every pick, so the width follows the process as the run goes:
 *  - memory: halved above AUTOMATION_MEMORY_SOFT_MB (380), one at a time above _HARD_MB (450);
 *  - CPU: halved while the event loop lags (p99 > 300 ms), one at a time above 1 s. On 0.1 CPU,
 *    parsing several resumes at once starves the event loop, and then even /api/health misses
 *    the host's 5-second health check and the instance is restarted mid-job.
 */

const MB = 1024 * 1024;
const SOFT_MB = Number(process.env.AUTOMATION_MEMORY_SOFT_MB) || 380;
const HARD_MB = Number(process.env.AUTOMATION_MEMORY_HARD_MB) || 450;
const LAG_SOFT_MS = 300;
const LAG_HARD_MS = 1_000;

const g = globalThis as unknown as { __loopLag?: { ms: number } };

/** The event loop's recent p99 delay (ms), sampled every 3 s. */
function loopLagMs(): number {
  if (!g.__loopLag) {
    const state = { ms: 0 };
    g.__loopLag = state;
    const h = monitorEventLoopDelay({ resolution: 20 });
    h.enable();
    setInterval(() => {
      state.ms = h.percentile(99) / 1e6;
      h.reset();
    }, 3_000).unref();
  }
  return g.__loopLag.ms;
}

export function adaptiveConcurrency(base: number, max: number, rss: number = process.memoryUsage().rss, lagMs: number = loopLagMs()): number {
  const width = Math.min(max, Math.max(1, Math.floor(base)));
  if (rss >= HARD_MB * MB || lagMs >= LAG_HARD_MS) return 1;
  if (rss >= SOFT_MB * MB || lagMs >= LAG_SOFT_MS) return Math.max(1, Math.floor(width / 2));
  return width;
}
