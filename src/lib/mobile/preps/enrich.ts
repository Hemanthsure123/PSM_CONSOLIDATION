import "server-only";
import { normalisePhone } from "@/lib/pool/parse";
import { lookupStandings, poolRecords } from "@/lib/pool/queries";
import type { AssessmentScore } from "@/lib/pool/scores/catalogue";
import { assessedOutsidePool, scoresFor } from "@/lib/pool/scores/queries";
import { PRODUCT_LABEL, type CandidateStanding, type PersonRecords, type Product, type Tier } from "@/lib/pool/types";
import { markTags, recordTags, type Tag, toneOf } from "@/lib/mobile/preps/tags";
import { type Category, type EdgeVersion, categoryFromSheet } from "@/lib/mobile/preps/parse";

/**
 * Who a candidate is to us — Academy, Edge (1.0 / 2.0) or External — and what they cleared in our
 * own assessments, from the eligible pool (Supabase, matched by phone). The pool wins over the
 * sheet's "Product" cell, which is often blank; the cell is the fallback. Never a resume.
 * Lookups are batched and cached (30 min), so a calendar refresh costs one query at most.
 */

export type { Tag } from "@/lib/mobile/preps/tags";

export interface CandidateClass {
  category: Category;
  edgeVersion: EdgeVersion | null;
  /** Where the category came from. */
  source: "pool" | "assessed" | "sheet" | "none";
  /** One line: "TR-2 cleared", "TR-1 cleared", "Assessment cleared", "Assessed · not in pool". */
  stage: string;
  /** A few short tags for list rows. */
  tags: Tag[];
  candidateId: number | null;
}

const TIER_STAGE: Record<Tier, string> = { 1: "TR-2 cleared", 2: "TR-1 cleared", 3: "Assessment cleared", 4: "Not eligible" };
const SUMMARY_TTL = 30 * 60_000;
const DETAIL_TTL = 10 * 60_000;

const g = globalThis as unknown as {
  __prepClass?: Map<string, { at: number; v: { standing: CandidateStanding | null; assessed: number | null } }>;
  __prepDetailTags?: Map<string, { at: number; v: Tag[] }>;
};
const classCache = (g.__prepClass ??= new Map());
const detailCache = (g.__prepDetailTags ??= new Map());

/** The pool's view of a batch of phones (cached). Phones not in the pool map to null. */
async function poolView(phones: string[]): Promise<Map<string, { standing: CandidateStanding | null; assessed: number | null }>> {
  const now = Date.now();
  const out = new Map<string, { standing: CandidateStanding | null; assessed: number | null }>();
  const missing: string[] = [];
  for (const p of new Set(phones.filter(Boolean))) {
    const hit = classCache.get(p);
    if (hit && now - hit.at < SUMMARY_TTL) out.set(p, hit.v);
    else missing.push(p);
  }
  if (missing.length) {
    try {
      const people = missing.map((phone) => ({ phone }));
      const [standings, outside] = await Promise.all([lookupStandings(people), assessedOutsidePool(people).catch(() => ({}) as Record<string, { candidateId: number }>)]);
      for (const p of missing) {
        const key = `p:${normalisePhone(p) ?? p}`;
        const v = { standing: standings[key] ?? null, assessed: outside[key]?.candidateId ?? null };
        classCache.set(p, { at: now, v });
        out.set(p, v);
      }
    } catch (err) {
      // The pool is a bonus: without it every candidate falls back to the sheet's Product cell.
      console.warn("[preps] pool lookup failed:", err instanceof Error ? err.message.slice(0, 160) : err);
    }
    if (classCache.size > 20_000) classCache.clear();
  }
  return out;
}

function classify(sheetProduct: string, view: { standing: CandidateStanding | null; assessed: number | null } | undefined): CandidateClass {
  const s = view?.standing;
  if (s) {
    const has = (p: Product) => s.standings.find((x) => x.product === p);
    const academy = has("academy");
    const edge2 = has("edge2");
    const edge1 = has("edge1");
    const main = academy ?? edge2 ?? edge1 ?? s.standings[0];
    const category: Category = academy ? "academy" : "edge";
    const edgeVersion: EdgeVersion | null = academy ? null : edge2 ? "2.0" : edge1 ? "1.0" : null;
    const tags: Tag[] = [];
    for (const st of [academy, edge2, edge1].filter(Boolean) as NonNullable<typeof academy>[]) {
      // "Edge 2.0 · MERN TR-2 · Strong hire" → the parts after the product.
      const rest = st.label.split(" · ").slice(1).join(" · ");
      if (rest) tags.push({ label: rest, tone: st.eligible ? (toneOf(rest) === "fail" ? "fail" : "pass") : "fail", group: PRODUCT_LABEL[st.product] });
    }
    return {
      category,
      edgeVersion,
      source: "pool",
      stage: TIER_STAGE[main.tier as Tier] ?? "",
      tags: tags.slice(0, 4),
      candidateId: s.candidateId,
    };
  }
  if (view?.assessed) {
    return { category: "academy", edgeVersion: null, source: "assessed", stage: "Assessed · not in pool", tags: [], candidateId: view.assessed };
  }
  const sheet = categoryFromSheet(sheetProduct);
  return {
    category: sheet.category,
    edgeVersion: sheet.edgeVersion,
    source: sheetProduct.trim() ? "sheet" : "none",
    stage: "",
    tags: sheet.note ? [{ label: sheet.note, tone: "neutral", group: "Sheet" }] : [],
    candidateId: null,
  };
}

/** Category + short tags for many candidates at once. */
export async function classifyMany(people: { phone: string; product: string }[]): Promise<Map<string, CandidateClass>> {
  const view = await poolView(people.map((p) => p.phone));
  const out = new Map<string, CandidateClass>();
  for (const p of people) out.set(`${p.phone}|${p.product}`, classify(p.product, p.phone ? view.get(p.phone) : undefined));
  return out;
}

export const classKey = (phone: string, product: string) => `${phone}|${product}`;

// ── Full tags for one candidate (the prep page) ─────────────────────────────

/** Every tag we have for one candidate: product records (rounds, levels, verdicts) and final marks. */
export async function detailTags(phone: string, cls: CandidateClass): Promise<Tag[]> {
  if (!cls.candidateId) return cls.tags;
  const hit = detailCache.get(phone);
  if (hit && Date.now() - hit.at < DETAIL_TTL) return hit.v;
  try {
    const id = cls.candidateId;
    const [records, scores] = await Promise.all([
      cls.source === "pool" ? poolRecords([id], ["academy", "edge2", "edge1"]) : Promise.resolve({} as Record<number, PersonRecords>),
      scoresFor([id]).catch(() => ({}) as Record<number, AssessmentScore[]>),
    ]);
    const rec = records[id] ?? {};
    const tags = [...recordTags(rec), ...markTags(scores[id] ?? [], Boolean(rec.academy?.rounds.length))];
    const v = tags.length ? tags : cls.tags;
    detailCache.set(phone, { at: Date.now(), v });
    if (detailCache.size > 2_000) detailCache.clear();
    return v;
  } catch (err) {
    console.warn("[preps] detail tags failed:", err instanceof Error ? err.message.slice(0, 160) : err);
    return cls.tags;
  }
}
