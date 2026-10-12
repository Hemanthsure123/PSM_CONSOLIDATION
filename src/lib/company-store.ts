"use client";

import type { CompanySummary } from "@/lib/types";

/**
 * Tiny localStorage-backed store for completed consolidations, so the home
 * dashboard can list every company across sessions. This is a single-user,
 * run-locally internal tool — localStorage keeps it dependency-free; swap for a
 * server store/DB if it ever needs to be shared.
 */
const KEY = "nxtwave.companies.v1";

function read(): CompanySummary[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as CompanySummary[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list: CompanySummary[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch (err) {
    console.warn("[company-store] failed to persist:", err);
  }
}

/** All saved companies, newest first. */
export function listCompanies(): CompanySummary[] {
  return read().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Insert or replace a company snapshot (by id). */
export function saveCompany(summary: CompanySummary): void {
  const list = read().filter((c) => c.id !== summary.id);
  list.push(summary);
  write(list);
}

export function deleteCompany(id: string): void {
  write(read().filter((c) => c.id !== id));
}

export function newCompanyId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `c_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
