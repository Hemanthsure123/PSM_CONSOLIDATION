/**
 * A rolling window of parallel jobs (browser and server): up to `concurrency()` jobs run
 * at once, a job that failed for a passing reason goes back in the queue after a
 * pause, and `onDone` sees every item exactly once with its final result. Pure (no
 * React, no I/O of its own) so it can be tested on its own.
 */

export interface QueueOptions<T, R> {
  items: T[];
  /** Read on every pick, so the width can change while the queue runs. */
  concurrency: () => number;
  run: (item: T) => Promise<R>;
  /** Milliseconds to wait before retrying `result` (attempt is 1-based), or null when the result is final. */
  retryAfter: (result: R, attempt: number) => number | null;
  /** True once the user pressed Stop — no new job starts; running ones finish. */
  stopped: () => boolean;
  /** Every item's final result, exactly once (not called for items a Stop left unstarted). */
  onDone: (item: T, result: R) => void;
  /** Jobs running now / waiting to retry — for the progress line. */
  onActivity?: (running: number, waiting: number) => void;
}

interface Job<T> {
  item: T;
  attempt: number;
  notBefore: number;
}

/** A pause that can be cancelled (so finished waits don't leave timers behind). */
function pause(ms: number): { done: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { done, cancel: () => clearTimeout(timer) };
}

/** How often the scheduler re-reads `concurrency()` while jobs run (and checks back-offs). */
const RECHECK_MS = 1_000;

/**
 * Run every item; resolves when all are done or a Stop drained the running ones.
 *
 * The width is honoured CONTINUOUSLY: a job starts whenever fewer than `concurrency()` are
 * running, so a width that grows (memory freed, load gone) is used within a second, and one that
 * shrinks lets running jobs finish before more start. If `run` or `onDone` throws, no new job
 * starts, the running ones finish, and the first error is rethrown.
 */
export async function runQueue<T, R>(o: QueueOptions<T, R>): Promise<{ done: number; unstarted: T[] }> {
  const queue: Job<T>[] = o.items.map((item) => ({ item, attempt: 0, notBefore: 0 }));
  const active = new Set<Promise<void>>();
  let running = 0;
  let waiting = 0;
  let done = 0;
  let failure: { error: unknown } | null = null;
  const report = () => o.onActivity?.(running, waiting);

  const start = (job: Job<T>) => {
    running++;
    report();
    const task = (async () => {
      let result: R;
      try {
        result = await o.run(job.item);
      } finally {
        running--;
      }
      const wait = o.stopped() ? null : o.retryAfter(result, job.attempt + 1);
      if (wait !== null) {
        queue.push({ item: job.item, attempt: job.attempt + 1, notBefore: Date.now() + wait });
        waiting++;
        report();
        return;
      }
      done++;
      o.onDone(job.item, result);
      report();
    })().catch((error: unknown) => {
      failure ??= { error };
    });
    active.add(task);
    void task.finally(() => active.delete(task));
  };

  for (;;) {
    // Start as many ready jobs as the current width allows.
    while (!failure && !o.stopped() && running < Math.max(1, o.concurrency())) {
      const now = Date.now();
      const idx = queue.findIndex((j) => j.notBefore <= now);
      if (idx < 0) break;
      const job = queue.splice(idx, 1)[0];
      if (job.attempt > 0) waiting--;
      start(job);
    }
    if (!active.size && (failure || o.stopped() || !queue.length)) break;
    // Wait for a job to finish, a back-off to expire, or the next width check.
    const now = Date.now();
    const nextReady = queue.length ? Math.min(...queue.map((j) => j.notBefore)) - now : RECHECK_MS;
    const timer = pause(Math.min(RECHECK_MS, Math.max(50, nextReady)));
    await Promise.race([timer.done, ...active]);
    timer.cancel();
  }
  report();
  if (failure) throw (failure as { error: unknown }).error;
  return { done, unstarted: queue.map((j) => j.item) };
}
