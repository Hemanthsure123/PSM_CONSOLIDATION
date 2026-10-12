"use client";

import type { ExperienceRun } from "@/lib/experience-types";

/**
 * localStorage-backed store for Experience Analysis runs — same pattern as the
 * other stores. A run is saved after every candidate, so a refresh mid-run
 * loses nothing and the run can be resumed from the dashboard.
 */
const KEY = "nxtwave.experience.v1";

function read(): ExperienceRun[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as ExperienceRun[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** False when the browser refused the write (storage quota). */
function write(list: ExperienceRun[]): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch (err) {
    console.warn("[experience-store] failed to persist:", err);
    return false;
  }
}

export function listExperienceRuns(): ExperienceRun[] {
  return read().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getExperienceRun(id: string): ExperienceRun | null {
  return read().find((r) => r.id === id) ?? null;
}

export function saveExperienceRun(run: ExperienceRun): boolean {
  const list = read().filter((r) => r.id !== run.id);
  list.push(run);
  return write(list);
}

export function deleteExperienceRun(id: string): void {
  write(read().filter((r) => r.id !== id));
}

export function newExperienceRunId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `ex_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
