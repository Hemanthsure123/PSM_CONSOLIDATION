"use client";

import type { DsaAnalysis } from "@/lib/dsa-types";

/**
 * localStorage-backed store for saved DSA consolidation runs, so the home
 * dashboard can list them across sessions. Same rationale as the other stores —
 * single-user, run-locally internal tool.
 */
const KEY = "nxtwave.dsa.v1";

function read(): DsaAnalysis[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as DsaAnalysis[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list: DsaAnalysis[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch (err) {
    console.warn("[dsa-store] failed to persist:", err);
  }
}

export function listDsaRuns(): DsaAnalysis[] {
  return read().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function saveDsaRun(run: DsaAnalysis): void {
  const list = read().filter((r) => r.id !== run.id);
  list.push(run);
  write(list);
}

export function deleteDsaRun(id: string): void {
  write(read().filter((r) => r.id !== id));
}

export function newDsaId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `d_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
