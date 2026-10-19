import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { env } from "@/lib/env";

/**
 * Short-lived cache for Domain Shortlisting's deep GitHub inspection.
 *
 * Inspecting one candidate costs ~20-40 GitHub REST calls and several seconds; re-running a
 * sheet, retrying a stopped run, or screening the same candidate for another domain with the
 * same technologies would otherwise pay that again. Results are reused for
 * `GITHUB_CACHE_TTL_HOURS` (default 24; 0 turns the cache off).
 *
 *  - The caller builds the key (`inspectionCacheKey`) from everything the answer depends on —
 *    the GitHub user, the resume's repo links, the technologies looked for and the analyzer
 *    version — so a changed domain or a new analyzer never reuses an old answer.
 *  - Only the caller decides what is worth storing; Domain Shortlisting stores complete answers
 *    only (never a failure, a rate-limited or partial inspection).
 *  - Two layers: a bounded in-process map, and one JSON file per entry on disk so a server
 *    restart or hot reload keeps the cache. Writes are atomic (temp file + rename); an
 *    unreadable, expired or foreign entry is a miss and is removed.
 *  - Concurrent requests for one key share a single inspection (`coalesce`).
 *  - The disk is best-effort: a read-only or full disk degrades to memory-only, never to an error.
 */

/** On-disk entry format. Bump if `CacheEntry` changes shape. */
const ENTRY_FORMAT = 1;
/** In-process entries kept (oldest dropped first). */
const MEMORY_MAX = 1_000;
/** Disk entries kept; the oldest beyond this are removed by the sweep. */
const DISK_MAX = 20_000;
/** Sweep the cache folder for expired entries at most this often. */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

interface CacheEntry<T> {
  format: number;
  key: string;
  savedAt: string;
  expiresAt: number;
  value: T;
}

interface CacheState {
  memory: Map<string, CacheEntry<unknown>>;
  inflight: Map<string, Promise<unknown>>;
  lastSweep: number;
  sweeping: boolean;
}

// Kept on globalThis so a dev-server hot reload of this module doesn't drop the cache.
const holder = globalThis as typeof globalThis & { __githubInspectCache?: CacheState };
const state: CacheState = (holder.__githubInspectCache ??= { memory: new Map(), inflight: new Map(), lastSweep: 0, sweeping: false });

function ttlMs(): number {
  return Math.max(0, env.github.cacheTtlHours) * 60 * 60 * 1000;
}

/** Whether caching is on at all (GITHUB_CACHE_TTL_HOURS > 0). */
export function inspectionCacheEnabled(): boolean {
  return ttlMs() > 0;
}

function cacheDir(): string {
  const configured = env.github.cacheDir.trim();
  if (!configured) return join(process.cwd(), ".cache", "github-inspect");
  return isAbsolute(configured) ? configured : join(process.cwd(), configured);
}

const fileFor = (key: string): string => join(cacheDir(), `${key}.json`);

/** Stable key: SHA-256 of the parts as canonical JSON (object keys sorted, arrays as given). */
export function inspectionCacheKey(parts: Record<string, unknown>): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canonical(parts))).digest("hex");
}

function remember<T>(entry: CacheEntry<T>): void {
  state.memory.delete(entry.key);
  state.memory.set(entry.key, entry);
  while (state.memory.size > MEMORY_MAX) {
    const oldest = state.memory.keys().next().value;
    if (oldest === undefined) break;
    state.memory.delete(oldest);
  }
}

function valid<T>(entry: unknown, key: string): entry is CacheEntry<T> {
  const e = entry as Partial<CacheEntry<T>> | null;
  return Boolean(e) && e!.format === ENTRY_FORMAT && e!.key === key && typeof e!.expiresAt === "number" && e!.expiresAt > Date.now() && "value" in e!;
}

/** A cached value and when it was stored, or null (missing, expired, unreadable, or caching off). */
export async function readInspectionCache<T>(key: string): Promise<{ value: T; savedAt: string } | null> {
  if (!inspectionCacheEnabled()) return null;
  const mem = state.memory.get(key);
  if (mem) {
    if (valid<T>(mem, key)) return { value: mem.value, savedAt: mem.savedAt };
    state.memory.delete(key);
  }
  try {
    const parsed = JSON.parse(await readFile(fileFor(key), "utf8")) as unknown;
    if (!valid<T>(parsed, key)) {
      await unlink(fileFor(key)).catch(() => undefined);
      return null;
    }
    remember(parsed);
    return { value: parsed.value, savedAt: parsed.savedAt };
  } catch {
    return null; // not cached (ENOENT) or unreadable — either way a miss
  }
}

/** Store a value for the configured TTL. Never throws; a disk problem leaves it memory-only. */
export async function writeInspectionCache<T>(key: string, value: T): Promise<void> {
  const ttl = ttlMs();
  if (ttl <= 0) return;
  const entry: CacheEntry<T> = { format: ENTRY_FORMAT, key, savedAt: new Date().toISOString(), expiresAt: Date.now() + ttl, value };
  remember(entry);
  try {
    const dir = cacheDir();
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${key}.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(entry), "utf8");
    await rename(tmp, fileFor(key));
  } catch (err) {
    console.warn("[github-cache] disk write failed (memory only):", err instanceof Error ? err.message : err);
    return;
  }
  if (Date.now() - state.lastSweep > SWEEP_INTERVAL_MS) {
    state.lastSweep = Date.now();
    void sweep();
  }
}

/** Remove expired entries and leftover temp files, and the oldest beyond DISK_MAX. Best-effort. */
async function sweep(): Promise<void> {
  if (state.sweeping) return;
  state.sweeping = true;
  try {
    const dir = cacheDir();
    const names = await readdir(dir);
    const ttl = ttlMs();
    const now = Date.now();
    const live: { name: string; mtime: number }[] = [];
    for (const name of names) {
      const temp = name.endsWith(".tmp");
      if (!temp && !name.endsWith(".json")) continue; // not ours
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (!info) continue;
      // An entry past its TTL, or a temp file a crashed write left behind.
      if (now - info.mtimeMs > (temp ? 60 * 60 * 1000 : ttl)) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      if (!temp) live.push({ name, mtime: info.mtimeMs });
    }
    if (live.length > DISK_MAX) {
      live.sort((a, b) => a.mtime - b.mtime);
      for (const { name } of live.slice(0, live.length - DISK_MAX)) await unlink(join(dir, name)).catch(() => undefined);
    }
  } catch {
    // Nothing to sweep (no folder yet) or the disk is unavailable — fine.
  } finally {
    state.sweeping = false;
  }
}

/**
 * Run `work` once per key at a time: a caller arriving while the same key is in flight
 * shares that promise instead of starting a duplicate inspection.
 */
export function coalesce<T>(key: string, work: () => Promise<T>): Promise<T> {
  const running = state.inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const started = work().finally(() => state.inflight.delete(key));
  state.inflight.set(key, started);
  return started;
}

/** Tests only: forget the in-process layer (the disk is left alone). */
export function resetInspectionCacheMemory(): void {
  state.memory.clear();
  state.inflight.clear();
  state.lastSweep = 0;
}
