"use client";

import type { BenchmarkResult, BenchmarkRunMeta } from "@/lib/benchmark-types";

/**
 * IndexedDB store for Benchmark Projects runs — same layout as the QA store: a
 * run's metadata + candidate list is one record and every resume's result is
 * its own record, written the moment it arrives, so a refresh mid-batch loses
 * nothing and a run can be reopened from the dashboard.
 */

const DB_NAME = "nxtwave-benchmark-projects";
const RUNS = "runs";
const RESULTS = "results";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is not available in this browser."));
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RUNS)) db.createObjectStore(RUNS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(RESULTS)) {
        const s = db.createObjectStore(RESULTS, { keyPath: ["runId", "id"] });
        s.createIndex("runId", "runId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error("Could not open the benchmark projects database."));
    };
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed."));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted (storage full?)."));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

type StoredResult = BenchmarkResult & { runId: string };

export async function listBenchmarkRuns(): Promise<BenchmarkRunMeta[]> {
  try {
    const db = await openDb();
    const runs = await request(db.transaction(RUNS, "readonly").objectStore(RUNS).getAll() as IDBRequest<BenchmarkRunMeta[]>);
    return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch (err) {
    console.warn("[benchmark-store] list failed:", err);
    return [];
  }
}

export async function getBenchmarkRun(
  id: string,
): Promise<{ meta: BenchmarkRunMeta; results: Record<string, BenchmarkResult> } | null> {
  const db = await openDb();
  const tx = db.transaction([RUNS, RESULTS], "readonly");
  const meta = await request(tx.objectStore(RUNS).get(id) as IDBRequest<BenchmarkRunMeta | undefined>);
  if (!meta) return null;
  const rows = await request(tx.objectStore(RESULTS).index("runId").getAll(id) as IDBRequest<StoredResult[]>);
  const results: Record<string, BenchmarkResult> = {};
  for (const { runId: _runId, ...r } of rows) results[r.id] = r;
  return { meta, results };
}

/** False when the browser refused the write (storage full / private mode). */
export async function saveBenchmarkRunMeta(meta: BenchmarkRunMeta): Promise<boolean> {
  try {
    const db = await openDb();
    const tx = db.transaction(RUNS, "readwrite");
    tx.objectStore(RUNS).put(meta);
    await done(tx);
    return true;
  } catch (err) {
    console.warn("[benchmark-store] failed to save run:", err);
    return false;
  }
}

export async function saveBenchmarkResult(runId: string, result: BenchmarkResult): Promise<boolean> {
  try {
    const db = await openDb();
    const tx = db.transaction(RESULTS, "readwrite");
    tx.objectStore(RESULTS).put({ ...result, runId } satisfies StoredResult);
    await done(tx);
    return true;
  } catch (err) {
    console.warn("[benchmark-store] failed to save result:", err);
    return false;
  }
}

export async function deleteBenchmarkRun(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([RUNS, RESULTS], "readwrite");
  tx.objectStore(RUNS).delete(id);
  const index = tx.objectStore(RESULTS).index("runId");
  const cursorReq = index.openKeyCursor(IDBKeyRange.only(id));
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) return;
    tx.objectStore(RESULTS).delete(cursor.primaryKey);
    cursor.continue();
  };
  await done(tx);
}

export function newBenchmarkRunId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `bench_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
