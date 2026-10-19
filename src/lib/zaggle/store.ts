"use client";

import type { ZgEvaluation, ZgRunMeta } from "@/lib/zaggle/types";

/**
 * IndexedDB store for Zaggle SDE 1 screening runs. localStorage (≈5 MB) can't hold
 * thousands of candidates, so a run's metadata + candidate list is one record
 * and every candidate's result is its own record, written the moment it
 * arrives — a refresh mid-batch loses nothing.
 */

const DB_NAME = "nxtwave-zaggle-sde1";
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
      reject(req.error ?? new Error("Could not open the Zaggle screening database."));
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

type StoredResult = ZgEvaluation & { runId: string };

export async function listZgRuns(): Promise<ZgRunMeta[]> {
  try {
    const db = await openDb();
    const runs = await request(db.transaction(RUNS, "readonly").objectStore(RUNS).getAll() as IDBRequest<ZgRunMeta[]>);
    return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch (err) {
    console.warn("[zaggle-store] list failed:", err);
    return [];
  }
}

export async function getZgRun(id: string): Promise<{ meta: ZgRunMeta; results: Record<string, ZgEvaluation> } | null> {
  const db = await openDb();
  const tx = db.transaction([RUNS, RESULTS], "readonly");
  const meta = await request(tx.objectStore(RUNS).get(id) as IDBRequest<ZgRunMeta | undefined>);
  if (!meta) return null;
  const rows = await request(tx.objectStore(RESULTS).index("runId").getAll(id) as IDBRequest<StoredResult[]>);
  const results: Record<string, ZgEvaluation> = {};
  for (const { runId: _runId, ...r } of rows) results[r.id] = r;
  return { meta, results };
}

/** False when the browser refused the write (storage full / private mode). */
export async function saveZgRunMeta(meta: ZgRunMeta): Promise<boolean> {
  try {
    const db = await openDb();
    const tx = db.transaction(RUNS, "readwrite");
    tx.objectStore(RUNS).put(meta);
    await done(tx);
    return true;
  } catch (err) {
    console.warn("[zaggle-store] failed to save run:", err);
    return false;
  }
}

export async function saveZgResult(runId: string, result: ZgEvaluation): Promise<boolean> {
  try {
    const db = await openDb();
    const tx = db.transaction(RESULTS, "readwrite");
    tx.objectStore(RESULTS).put({ ...result, runId } satisfies StoredResult);
    await done(tx);
    return true;
  } catch (err) {
    console.warn("[zaggle-store] failed to save result:", err);
    return false;
  }
}

export async function deleteZgRun(id: string): Promise<void> {
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

export function newZgRunId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `zg_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
