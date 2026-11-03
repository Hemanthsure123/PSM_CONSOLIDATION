import type { LookupInclude } from "@/lib/pool/lookup";
import type { AssessmentKey, AssessmentScore, CandidateProfile, EligibilityFilter, PersonRef, ScoreImportResult, ScoresSummary } from "@/lib/pool/scores/catalogue";
import type { CandidateStanding, PersonRecords, PoolSummary, Product, SyncResult } from "@/lib/pool/types";

/** Browser-side calls to /api/pool/*. Each one resolves to data or a readable error — never throws. */

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(url: string, init: RequestInit | undefined, pick: (body: Record<string, unknown>) => T | undefined): Promise<Reply<T>> {
  try {
    const res = await fetch(url, { cache: "no-store", ...init });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const data = pick(body);
    if (data !== undefined) return { ok: true, data };
    return { ok: false, error: typeof body.error === "string" ? body.error : `The server answered HTTP ${res.status}.` };
  } catch {
    return { ok: false, error: "Can't reach the app's server — check that it's running." };
  }
}

export const fetchPoolSummary = () => call<PoolSummary>("/api/pool/summary", undefined, (b) => b.summary as PoolSummary | undefined);

/** Refetch one product from its Google Sheet. A failed sync still returns its result (ok=false, error). */
export const syncPoolProduct = (product: Product) =>
  call<SyncResult>(
    "/api/pool/sync",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product }) },
    (b) => b.result as SyncResult | undefined,
  );

/** Upload a CSV export of one product's sheet ("auto" = detect the product from its headers). */
export function uploadPoolCsv(file: File, product: Product | "auto") {
  const form = new FormData();
  form.set("file", file);
  form.set("product", product);
  return call<SyncResult>("/api/pool/upload", { method: "POST", body: form }, (b) => b.result as SyncResult | undefined);
}

export interface StandingLookup {
  /** False when the database isn't set up — everyone is treated as external. */
  configured: boolean;
  standings: Record<string, CandidateStanding>;
  /** People with marks who aren't in the eligible pool ("p:<phone>" / "u:<userId>"): assessed, not eligible. */
  assessed: Record<string, PersonRef>;
  /** The assessment records per candidate id, for the products asked for ({} when none). */
  records: Record<string, PersonRecords>;
  /** Final scores / profiles per candidate id (asked with "scores" / "profile"). */
  scores?: Record<string, AssessmentScore[]>;
  profiles?: Record<string, CandidateProfile>;
}

const obj = <T>(v: unknown): T | undefined => (v && typeof v === "object" ? (v as T) : undefined);

/**
 * Internal standings for a batch of people, by phone first and user id second. `include` adds
 * those products' assessment records, their marks and their profile
 * (Standing lookup's Requirements).
 */
export const lookupPoolStandings = (people: { phone?: string; userId?: string }[], include: LookupInclude[] = []) =>
  call<StandingLookup>(
    "/api/pool/lookup",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(include.length ? { people, include } : { people }) },
    (b) =>
      b.standings && typeof b.standings === "object"
        ? {
            configured: b.configured !== false,
            standings: b.standings as Record<string, CandidateStanding>,
            assessed: obj<Record<string, PersonRef>>(b.assessed) ?? {},
            records: obj<Record<string, PersonRecords>>(b.records) ?? {},
            scores: obj(b.scores),
            profiles: obj(b.profiles),
          }
        : undefined,
  );

export const fetchScoresSummary = () => call<ScoresSummary>("/api/pool/scores", undefined, (b) => b.summary as ScoresSummary | undefined);

/**
 * Import one assessment CSV. A refused import still returns its result (ok=false, error,
 * needsConfirm when it would remove many stored scores — resend with allowShrink).
 */
export function uploadScoresCsv(file: File, opts: { examDate?: string; allowShrink?: boolean } = {}) {
  const form = new FormData();
  form.set("file", file);
  if (opts.examDate) form.set("examDate", opts.examDate);
  if (opts.allowShrink) form.set("allowShrink", "1");
  return call<ScoreImportResult>("/api/pool/scores/upload", { method: "POST", body: form }, (b) => b.result as ScoreImportResult | undefined);
}

/** Refetch one readable assessment tab from Google Sheets. */
export const syncScoresSheet = (sheet: string, allowShrink = false) =>
  call<ScoreImportResult>(
    "/api/pool/scores/sync",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sheet, allowShrink }) },
    (b) => b.result as ScoreImportResult | undefined,
  );

/** Everyone assessed by college / year of graduation / minimum marks / job eligibility (the lookup's Find mode). */
export const findPoolPeople = (filter: { colleges?: string[]; yogs?: number[]; assessment?: AssessmentKey; minScore?: number; eligibility?: EligibilityFilter }) =>
  call<{ people: PersonRef[]; total: number; truncated: boolean }>(
    "/api/pool/find",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(filter) },
    (b) => (Array.isArray(b.people) ? { people: b.people as PersonRef[], total: Number(b.total ?? 0), truncated: b.truncated === true } : undefined),
  );
