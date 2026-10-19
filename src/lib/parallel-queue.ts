/**
 * A rolling window of parallel jobs for the browser: up to `concurrency()` jobs run
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run every item; resolves when all are done or a Stop drained the running ones. */
export async function runQueue<T, R>(o: QueueOptions<T, R>): Promise<{ done: number; unstarted: T[] }> {
  const queue: Job<T>[] = o.items.map((item) => ({ item, attempt: 0, notBefore: 0 }));
  let running = 0;
  let waiting = 0;
  let done = 0;
  const report = () => o.onActivity?.(running, waiting);

  const worker = async (): Promise<void> => {
    while (!o.stopped()) {
      if (!queue.length) return;
      const now = Date.now();
      const idx = queue.findIndex((j) => j.notBefore <= now);
      if (idx < 0) {
        // Only back-off jobs left: wait for the earliest instead of spinning.
        await sleep(Math.min(1_000, Math.max(50, Math.min(...queue.map((j) => j.notBefore)) - now)));
        continue;
      }
      const job = queue.splice(idx, 1)[0];
      if (job.attempt > 0) waiting--;
      running++;
      report();
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
        continue;
      }
      done++;
      o.onDone(job.item, result);
      report();
    }
  };

  // Workers exit when the queue is empty; jobs re-queued for a retry keep at least one alive.
  while (queue.length && !o.stopped()) {
    const width = Math.max(1, Math.min(o.concurrency(), queue.length));
    await Promise.all(Array.from({ length: width }, worker));
  }
  report();
  return { done, unstarted: queue.map((j) => j.item) };
}
