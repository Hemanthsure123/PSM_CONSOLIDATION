"use client";

import type { SpDataset, SpRecord, SpRunMeta } from "@/lib/showcase/types";

/**
 * IndexedDB store for Sample profiles runs: the run's settings (small, saved often), the sheet as
 * read (saved when loaded), and one record per candidate that every stage fills in the moment its
 * result arrives — a refresh in the middle of a 2,500-row run loses nothing.
 */

const DB_NAME = "nxtwave-sample-profiles";
const RUNS = "runs";
const DATASETS = "datasets";
const RECORDS = "records";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is not available in this browser."));
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RUNS)) db.createObjectStore(RUNS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(DATASETS)) db.createObjectStore(DATASETS, { keyPath: "runId" });
      if (!db.objectStoreNames.contains(RECORDS)) {
        const s = db.createObjectStore(RECORDS, { keyPath: ["runId", "id"] });
        s.createIndex("runId", "runId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error("Could not open the Sample profiles database."));
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

type Stored = SpRecord & { runId: string };

export async function listSpRuns(): Promise<SpRunMeta[]> {
  try {
    const db = await openDb();
    const runs = await request(db.transaction(RUNS, "readonly").objectStore(RUNS).getAll() as IDBRequest<SpRunMeta[]>);
    return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch (err) {
    console.warn("[showcase-store] list failed:", err);
    return [];
  }
}

export async function getSpRun(id: string): Promise<{ meta: SpRunMeta; dataset: SpDataset | null; records: Record<string, SpRecord> } | null> {
  const db = await openDb();
  const tx = db.transaction([RUNS, DATASETS, RECORDS], "readonly");
  const meta = await request(tx.objectStore(RUNS).get(id) as IDBRequest<SpRunMeta | undefined>);
  if (!meta) return null;
  const ds = await request(tx.objectStore(DATASETS).get(id) as IDBRequest<{ runId: string; dataset: SpDataset } | undefined>);
  const rows = await request(tx.objectStore(RECORDS).index("runId").getAll(id) as IDBRequest<Stored[]>);
  const records: Record<string, SpRecord> = {};
  for (const { runId: _runId, ...r } of rows) records[r.id] = r;
  return { meta, dataset: ds?.dataset ?? null, records };
}

/** False when the browser refused the write (storage full / private mode). */
export async function saveSpRunMeta(meta: SpRunMeta): Promise<boolean> {
  try {
    const db = await openDb();
    const tx = db.transaction(RUNS, "readwrite");
    tx.objectStore(RUNS).put(meta);
    await done(tx);
    return true;
  } catch (err) {
    console.warn("[showcase-store] failed to save run:", err);
    return false;
  }
}

export async function saveSpDataset(runId: string, dataset: SpDataset): Promise<boolean> {
  try {
    const db = await openDb();
    const tx = db.transaction(DATASETS, "readwrite");
    tx.objectStore(DATASETS).put({ runId, dataset });
    await done(tx);
    return true;
  } catch (err) {
    console.warn("[showcase-store] failed to save the sheet:", err);
    return false;
  }
}

/** Several candidates' records in one transaction (a Codeforces batch is 50 at once). */
export async function saveSpRecords(runId: string, records: SpRecord[]): Promise<boolean> {
  if (!records.length) return true;
  try {
    const db = await openDb();
    const tx = db.transaction(RECORDS, "readwrite");
    const store = tx.objectStore(RECORDS);
    for (const r of records) store.put({ ...r, runId } satisfies Stored);
    await done(tx);
    return true;
  } catch (err) {
    console.warn("[showcase-store] failed to save records:", err);
    return false;
  }
}

export async function deleteSpRun(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([RUNS, DATASETS, RECORDS], "readwrite");
  tx.objectStore(RUNS).delete(id);
  tx.objectStore(DATASETS).delete(id);
  const cursorReq = tx.objectStore(RECORDS).index("runId").openKeyCursor(IDBKeyRange.only(id));
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) return;
    tx.objectStore(RECORDS).delete(cursor.primaryKey);
    cursor.continue();
  };
  await done(tx);
}

export function newSpRunId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `sp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

const LAST_LINK = "nxtwave-sample-profiles-last-link";

/** The sheet link used last (a per-browser convenience). */
export function lastSpLink(): string {
  try {
    return localStorage.getItem(LAST_LINK) ?? "";
  } catch {
    return "";
  }
}

export function rememberSpLink(link: string): void {
  try {
    localStorage.setItem(LAST_LINK, link);
  } catch {
    // Private mode / storage blocked — the link just isn't remembered.
  }
}
