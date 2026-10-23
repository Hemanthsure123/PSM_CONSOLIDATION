"use client";

import type { AcDataset, AcEvaluation, AcRunMeta } from "@/lib/academy/types";

/**
 * IndexedDB store for Academy bucketing runs: the run's settings (small, saved
 * often), the sheets as read (large, saved when loaded), and every candidate's
 * resume / GitHub / DSA reading as its own record, written the moment it
 * arrives — a refresh mid-run loses nothing.
 */

const DB_NAME = "nxtwave-academy-bucketing";
const RUNS = "runs";
const DATASETS = "datasets";
const RESULTS = "results";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is not available in this browser."));
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RUNS)) db.createObjectStore(RUNS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(DATASETS)) db.createObjectStore(DATASETS, { keyPath: "runId" });
      if (!db.objectStoreNames.contains(RESULTS)) {
        const s = db.createObjectStore(RESULTS, { keyPath: ["runId", "id"] });
        s.createIndex("runId", "runId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error("Could not open the Academy bucketing database."));
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

type StoredResult = AcEvaluation & { runId: string };

export async function listAcRuns(): Promise<AcRunMeta[]> {
  try {
    const db = await openDb();
    const runs = await request(db.transaction(RUNS, "readonly").objectStore(RUNS).getAll() as IDBRequest<AcRunMeta[]>);
    return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch (err) {
    console.warn("[academy-store] list failed:", err);
    return [];
  }
}

export async function getAcRun(
  id: string,
): Promise<{ meta: AcRunMeta; dataset: AcDataset | null; results: Record<string, AcEvaluation> } | null> {
  const db = await openDb();
  const tx = db.transaction([RUNS, DATASETS, RESULTS], "readonly");
  const meta = await request(tx.objectStore(RUNS).get(id) as IDBRequest<AcRunMeta | undefined>);
  if (!meta) return null;
  const ds = await request(tx.objectStore(DATASETS).get(id) as IDBRequest<{ runId: string; dataset: AcDataset } | undefined>);
  const rows = await request(tx.objectStore(RESULTS).index("runId").getAll(id) as IDBRequest<StoredResult[]>);
  const results: Record<string, AcEvaluation> = {};
  for (const { runId: _runId, ...r } of rows) results[r.id] = r;
  return { meta, dataset: ds?.dataset ?? null, results };
}

/** False when the browser refused the write (storage full / private mode). */
export async function saveAcRunMeta(meta: AcRunMeta): Promise<boolean> {
  try {
    const db = await openDb();
    const tx = db.transaction(RUNS, "readwrite");
    tx.objectStore(RUNS).put(meta);
    await done(tx);
    return true;
  } catch (err) {
    console.warn("[academy-store] failed to save run:", err);
    return false;
  }
}

export async function saveAcDataset(runId: string, dataset: AcDataset): Promise<boolean> {
  try {
    const db = await openDb();
    const tx = db.transaction(DATASETS, "readwrite");
    tx.objectStore(DATASETS).put({ runId, dataset });
    await done(tx);
    return true;
  } catch (err) {
    console.warn("[academy-store] failed to save the sheets:", err);
    return false;
  }
}

export async function saveAcResult(runId: string, result: AcEvaluation): Promise<boolean> {
  try {
    const db = await openDb();
    const tx = db.transaction(RESULTS, "readwrite");
    tx.objectStore(RESULTS).put({ ...result, runId } satisfies StoredResult);
    await done(tx);
    return true;
  } catch (err) {
    console.warn("[academy-store] failed to save result:", err);
    return false;
  }
}

export async function deleteAcRun(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([RUNS, DATASETS, RESULTS], "readwrite");
  tx.objectStore(RUNS).delete(id);
  tx.objectStore(DATASETS).delete(id);
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

export function newAcRunId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `ac_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

const LAST_LINKS = "nxtwave-academy-last-links";

/** The three sheet links used last (a per-browser convenience). */
export function lastAcLinks(): { s1: string; s2: string; s3: string } | null {
  try {
    const raw = localStorage.getItem(LAST_LINKS);
    return raw ? (JSON.parse(raw) as { s1: string; s2: string; s3: string }) : null;
  } catch {
    return null;
  }
}

export function rememberAcLinks(links: { s1: string; s2: string; s3: string }): void {
  try {
    localStorage.setItem(LAST_LINKS, JSON.stringify(links));
  } catch {
    // Private mode / storage blocked — the links just aren't remembered.
  }
}
