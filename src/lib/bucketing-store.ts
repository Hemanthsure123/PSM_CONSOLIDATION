"use client";

import { BUCKETS, type Bucket } from "@/lib/bucketing/config";
import type { BucketingResult, BucketingRunMeta, BucketingRunStats } from "@/lib/bucketing/types";

/**
 * IndexedDB store for Candidate Bucketing runs (same design as qa-store.ts): the
 * run's metadata + candidate list is one record and every candidate's result is
 * its own record, written the moment it arrives — a refresh mid-run loses
 * nothing and the run resumes where it stopped.
 */

const DB_NAME = "nxtwave-candidate-bucketing";
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
      reject(req.error ?? new Error("Could not open the bucketing database."));
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

type StoredResult = BucketingResult & { runId: string };

export function runStats(results: BucketingResult[]): BucketingRunStats {
  const byBucket = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
  let bucketed = 0;
  let notBucketed = 0;
  let retry = 0;
  let needsReview = 0;
  for (const r of results) {
    if (r.status === "bucketed" && r.bucket) {
      bucketed += 1;
      byBucket[r.bucket] += 1;
    } else if (r.status === "retry_needed") retry += 1;
    else notBucketed += 1;
    if (r.trust.needsReview) needsReview += 1;
  }
  return { evaluated: results.length, bucketed, notBucketed, retry, needsReview, byBucket };
}

export async function listBucketingRuns(): Promise<BucketingRunMeta[]> {
  try {
    const db = await openDb();
    const runs = await request(db.transaction(RUNS, "readonly").objectStore(RUNS).getAll() as IDBRequest<BucketingRunMeta[]>);
    return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch (err) {
    console.warn("[bucketing-store] list failed:", err);
    return [];
  }
}

export async function getBucketingRun(id: string): Promise<{ meta: BucketingRunMeta; results: Record<string, BucketingResult> } | null> {
  const db = await openDb();
  const tx = db.transaction([RUNS, RESULTS], "readonly");
  const meta = await request(tx.objectStore(RUNS).get(id) as IDBRequest<BucketingRunMeta | undefined>);
  if (!meta) return null;
  const rows = await request(tx.objectStore(RESULTS).index("runId").getAll(id) as IDBRequest<StoredResult[]>);
  const results: Record<string, BucketingResult> = {};
  for (const { runId: _runId, ...r } of rows) results[r.id] = r;
  return { meta, results };
}

/** False when the browser refused the write (storage full / private mode). */
export async function saveBucketingRunMeta(meta: BucketingRunMeta): Promise<boolean> {
  try {
    const db = await openDb();
    const tx = db.transaction(RUNS, "readwrite");
    tx.objectStore(RUNS).put(meta);
    await done(tx);
    return true;
  } catch (err) {
    console.warn("[bucketing-store] failed to save run:", err);
    return false;
  }
}

export async function saveBucketingResults(runId: string, results: BucketingResult[]): Promise<boolean> {
  if (!results.length) return true;
  try {
    const db = await openDb();
    const tx = db.transaction(RESULTS, "readwrite");
    const store = tx.objectStore(RESULTS);
    for (const r of results) store.put({ ...r, runId } satisfies StoredResult);
    await done(tx);
    return true;
  } catch (err) {
    console.warn("[bucketing-store] failed to save results:", err);
    return false;
  }
}

export async function deleteBucketingRun(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([RUNS, RESULTS], "readwrite");
  tx.objectStore(RUNS).delete(id);
  const cursorReq = tx.objectStore(RESULTS).index("runId").openKeyCursor(IDBKeyRange.only(id));
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) return;
    tx.objectStore(RESULTS).delete(cursor.primaryKey);
    cursor.continue();
  };
  await done(tx);
}

export function newBucketingRunId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `bk_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
