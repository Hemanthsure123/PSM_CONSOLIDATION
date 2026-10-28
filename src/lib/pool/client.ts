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
  /** The assessment records per candidate id, for the products asked for ({} when none). */
  records: Record<string, PersonRecords>;
}

/**
 * Internal standings for a batch of people, by phone first and user id second. `include` adds
 * those products' assessment records (Standing lookup's Requirements).
 */
export const lookupPoolStandings = (people: { phone?: string; userId?: string }[], include: Product[] = []) =>
  call<StandingLookup>(
    "/api/pool/lookup",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(include.length ? { people, include } : { people }) },
    (b) =>
      b.standings && typeof b.standings === "object"
        ? {
            configured: b.configured !== false,
            standings: b.standings as Record<string, CandidateStanding>,
            records: b.records && typeof b.records === "object" ? (b.records as Record<string, PersonRecords>) : {},
          }
        : undefined,
  );
