"use client";

import type { AssignmentRun } from "@/lib/assignment-types";

/**
 * localStorage-backed store for Assignment Evaluation runs — same shape and
 * rationale as the other stores. A run is saved after every evaluated batch, so
 * a refresh (or a closed tab) mid-run loses at most one batch; reopening the
 * run from the dashboard resumes from where it stopped.
 */
const KEY = "nxtwave.assignments.v1";

function read(): AssignmentRun[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as AssignmentRun[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Returns false when the browser refused the write (storage quota). */
function write(list: AssignmentRun[]): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch (err) {
    console.warn("[assignment-store] failed to persist:", err);
    return false;
  }
}

export function listAssignmentRuns(): AssignmentRun[] {
  return read().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getAssignmentRun(id: string): AssignmentRun | null {
  return read().find((r) => r.id === id) ?? null;
}

/** Save (insert or replace). False = browser storage is full. */
export function saveAssignmentRun(run: AssignmentRun): boolean {
  const list = read().filter((r) => r.id !== run.id);
  list.push(run);
  return write(list);
}

export function deleteAssignmentRun(id: string): void {
  write(read().filter((r) => r.id !== id));
}

export function newAssignmentRunId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `as_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
