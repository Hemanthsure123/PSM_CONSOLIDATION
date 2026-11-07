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

/**
 * Width for work that mostly WAITS (model calls, downloads): limited by memory only. CPU-heavy
 * steps inside that work go through `cpuGate`, so many model calls can be in flight while the
 * processor parses one file at a time — the waits overlap the parsing instead of queueing behind
 * it. (Throttling the whole unit on event-loop lag left a 0.1-CPU instance screening one resume
 * at a time.)
 */
export function ioConcurrency(base: number, max: number, rss: number = process.memoryUsage().rss): number {
  const width = Math.min(max, Math.max(1, Math.floor(base)));
  if (rss >= HARD_MB * MB) return Math.min(width, 2);
  if (rss >= SOFT_MB * MB) return Math.max(1, Math.floor(width / 2));
  return width;
}

/** A counting semaphore whose width is read on every acquire (so it can follow the load). */
export class Gate {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly width: () => number) {}

  get running() {
    return this.active;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    while (this.active >= Math.max(1, this.width())) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

/**
 * CPU-heavy steps (opening PDFs) run through this gate: AUTOMATION_CPU_PARALLEL at once
 * (default 1 — the free instance has 0.1 CPU, so parsing two files at once only makes both
 * slower and starves the event loop that answers health checks); one at a time when the event
 * loop is already lagging hard.
 */
export const cpuGate = new Gate(() => {
  const base = Math.min(4, Math.max(1, Number(process.env.AUTOMATION_CPU_PARALLEL) || 1));
  return loopLagMs() >= LAG_HARD_MS ? 1 : base;
});
