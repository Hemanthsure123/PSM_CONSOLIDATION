import "server-only";
import { normalisePhone } from "@/lib/pool/parse";
import { lookupStandings, poolRecords } from "@/lib/pool/queries";
import { edge2Stage } from "@/lib/pool/standing";
import { ASSESSMENTS, type AssessmentScore } from "@/lib/pool/scores/catalogue";
import { assessedOutsidePool, scoresFor } from "@/lib/pool/scores/queries";
import { COMPETENCY_LABEL, PRODUCT_LABEL, TR2_TRACK_LABEL, VERDICT_LABEL, type CandidateStanding, type PersonRecords, type Product, type Tier } from "@/lib/pool/types";
import { type Category, type EdgeVersion, categoryFromSheet } from "@/lib/mobile/preps/parse";

/**
 * Who a candidate is to us — Academy, Edge (1.0 / 2.0) or External — and what they cleared in our
 * own assessments, from the eligible pool (Supabase, matched by phone). The pool wins over the
 * sheet's "Product" cell, which is often blank; the cell is the fallback. Never a resume.
 * Lookups are batched and cached (30 min), so a calendar refresh costs one query at most.
 */

export interface Tag {
  label: string;
  tone: "pass" | "fail" | "neutral";
  /** "Academy", "Edge 2.0", "Edge 1.0", "Marks", "Sheet". */
  group: string;
}

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
      if (rest) tags.push({ label: rest, tone: st.eligible ? "pass" : "fail", group: PRODUCT_LABEL[st.product] });
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

const pass = (label: string, group: string): Tag => ({ label, tone: "pass", group });
const fail = (label: string, group: string): Tag => ({ label, tone: "fail", group });
const info = (label: string, group: string): Tag => ({ label, tone: "neutral", group });
const fmt = (n: number | null) => (n === null ? "" : Number.isInteger(n) ? String(n) : n.toFixed(1));

function recordTags(rec: PersonRecords): Tag[] {
  const tags: Tag[] = [];
  const a = rec.academy;
  if (a) {
    const G = "Academy";
    if (a.oldBucket) tags.push(info(`Bucket ${a.oldBucket}`, G));
    if (a.dsaOfflineStatus) tags.push(a.dsaOfflineCleared ? pass("DSA offline cleared", G) : fail(`DSA offline · ${a.dsaOfflineStatus}`, G));
    for (const r of a.rounds) {
      const label = `Bucket ${r.bucket} TR-${r.round}${r.score !== null ? ` · ${fmt(r.score)}` : ""}`;
      if (r.cleared) tags.push(pass(`${label} · cleared`, G));
      else if (r.status) tags.push(fail(`${label} · ${r.status}`, G));
    }
    for (const c of a.competency) {
      const level = c.levelLabel || (c.level !== null ? `L${c.level}` : "");
      const label = `${COMPETENCY_LABEL[c.subject]}${level ? ` ${level}` : ""}`;
      if (c.cleared) tags.push(pass(`${label} · cleared`, G));
      else if (c.clearanceStatus || c.verdictBand) tags.push(fail(`${label} · ${c.clearanceStatus || c.verdictBand}`, G));
    }
    if (a.yog) tags.push(info(`YOG ${a.yog}`, G));
  }
  const e2 = rec.edge2;
  if (e2) {
    const G = "Edge 2.0";
    const stage = edge2Stage(e2.candidateStage);
    if (stage) tags.push(pass(stage === "tr2" ? "TR-2 cleared" : stage === "tr1" ? "TR-1 cleared" : "Assessment cleared", G));
    if (e2.offlineOverallScore !== null) tags.push(info(`Offline assessment ${fmt(e2.offlineOverallScore)}/160`, G));
    if (e2.tr1.overallTechnical !== null) tags.push(info(`TR-1 technical ${fmt(e2.tr1.overallTechnical)}`, G));
    for (const v of e2.tr2) {
      const label = `${TR2_TRACK_LABEL[v.track]} TR-2 · ${VERDICT_LABEL[v.verdict]}`;
      tags.push(v.verdict === "strong_hire" || v.verdict === "medium_hire" ? pass(label, G) : fail(label, G));
    }
  }
  const e1 = rec.edge1;
  if (e1) {
    const G = "Edge 1.0";
    const one = (name: string, status: string) => {
      if (!status.trim()) return;
      const bad = /not|reject|fail|low/i.test(status);
      tags.push(bad ? fail(`${name} · ${status}`, G) : pass(`${name} · ${status}`, G));
    };
    one("Assessment", e1.assessmentStatus);
    one("TR-1", e1.tr1Status);
    one("TR-2", e1.tr2Status);
  }
  return tags;
}

/** The best attempt of each assessment, as "DSA offline exam · 92/130 · Qualified". */
function markTags(scores: AssessmentScore[], skipBucketRounds: boolean): Tag[] {
  const best = new Map<string, AssessmentScore>();
  for (const s of scores) {
    const prev = best.get(s.assessment);
    if (!prev || s.score / (s.maxScore || 1) > prev.score / (prev.maxScore || 1)) best.set(s.assessment, s);
  }
  // Bucket TR rounds are already shown from the Academy record (with its own score and verdict).
  return ASSESSMENTS.filter((a) => best.has(a.key) && !(skipBucketRounds && a.key.startsWith("bucket_"))).map((a) => {
    const s = best.get(a.key)!;
    const label = `${a.label} · ${fmt(s.score)}/${fmt(s.maxScore || a.max)}${s.result ? ` · ${s.result}` : ""}`;
    return s.passed === true ? pass(label, "Marks") : s.passed === false ? fail(label, "Marks") : info(label, "Marks");
  });
}

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
