import "server-only";

/**
 * Rate-limiting primitives for the DSA-consolidation platform fetches.
 *
 * LeetCode / Codeforces / CodeChef are keyless and rate-limited by IP, so the safe strategy
 * is a per-host **token bucket** (steady request rate) plus a bounded
 * **concurrency pool** across candidates. State lives on `globalThis` so the
 * buckets persist across separate server-action invocations in the same process
 * (a batch of candidates spans several calls).
 */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly ratePerSec: number, private readonly burst: number) {
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
    this.lastRefill = now;
  }

  /** Resolve once a token is available (blocks by sleeping, never rejects). */
  async take(): Promise<void> {
    // Guard against pathological waits; a single request should never wait long.
    for (let guard = 0; guard < 1000; guard++) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
      await sleep(Math.min(Math.max(waitMs, 50), 2000));
    }
  }
}

/** Per-host request rates (requests/second, burst). Conservative on purpose. */
const HOST_RATES: Record<string, { rate: number; burst: number }> = {
  "codeforces.com": { rate: 0.5, burst: 1 }, // Codeforces asks for ≤ 1 req / 2s
  "leetcode.com": { rate: 2, burst: 3 },
  // CodeChef profile pages 429 at ~1 req / 3 s; 1 req / 5 s stays clean (measured).
  "codechef.com": { rate: 0.2, burst: 2 },
};
const DEFAULT_RATE = { rate: 3, burst: 4 };

const globalForRate = globalThis as unknown as { __rateBuckets?: Map<string, TokenBucket> };

function buckets(): Map<string, TokenBucket> {
  if (!globalForRate.__rateBuckets) globalForRate.__rateBuckets = new Map();
  return globalForRate.__rateBuckets;
}

/** Wait for permission to make one request to `host` (per-host token bucket). */
export async function acquireHost(host: string): Promise<void> {
  const map = buckets();
  let bucket = map.get(host);
  if (!bucket) {
    const cfg = HOST_RATES[host] ?? DEFAULT_RATE;
    bucket = new TokenBucket(cfg.rate, cfg.burst);
    map.set(host, bucket);
  }
  await bucket.take();
}

/**
 * A minimal concurrency limiter: `run(fn)` starts `fn` immediately if fewer than
 * `concurrency` tasks are in flight, otherwise queues it. Resolves/rejects with
 * `fn`'s result.
 */
export function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];

  const next = () => {
    active--;
    const run = queue.shift();
    if (run) run();
  };

  return function limited<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(next);
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };
}

/** Map all candidate items through `worker` with bounded concurrency. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = pLimit(concurrency);
  return Promise.all(items.map((item, i) => limit(() => worker(item, i))));
}
