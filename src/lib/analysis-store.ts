"use client";

import type { SheetAnalysis } from "@/lib/company-sheet";

/**
 * localStorage-backed store for saved company-sheet analyses, so the home
 * dashboard can list every analysed funnel across sessions. Same rationale as
 * `company-store` — single-user, run-locally internal tool.
 */
const KEY = "nxtwave.analyses.v1";

function read(): SheetAnalysis[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as SheetAnalysis[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list: SheetAnalysis[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch (err) {
    console.warn("[analysis-store] failed to persist:", err);
  }
}

/** All saved analyses, newest first. */
export function listAnalyses(): SheetAnalysis[] {
  return read().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Insert or replace an analysis snapshot (by id). */
export function saveAnalysis(analysis: SheetAnalysis): void {
  const list = read().filter((a) => a.id !== analysis.id);
  list.push(analysis);
  write(list);
}

export function deleteAnalysis(id: string): void {
  write(read().filter((a) => a.id !== id));
}

export function newAnalysisId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `a_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
