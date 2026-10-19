import "server-only";
import { SchemaType, type Schema } from "@google/generative-ai";
import { BUCKETS, DOMAIN_KEYS, type DomainKey } from "@/lib/bucketing/config";
import { callAgent, fence, num, producerChain, str } from "@/lib/bucketing/llm";
import { DOMAIN_GUIDE, RUBRIC, evidenceItems, traceEntry } from "@/lib/bucketing/nodes/shared";
import type { DomainAnalysis, DomainScore, Extraction } from "@/lib/bucketing/types";
import type { State, Update } from "@/lib/bucketing/state";

/**
 * Agent 1 — domain analyst. Scores EVERY domain the candidate fits (the five
 * buckets always, other domains when shown) from projects, internships / jobs
 * and open-source work only. The skills list and summary never reach it, so a
 * domain the resume merely names can't score.
 */

const SYSTEM = `You are a senior technical recruiter for software placements. Score how well ONE candidate fits each domain, using ONLY the evidence items given — projects, internships / jobs and open-source contributions, already extracted and verified from the resume. Skills lists, summaries and certifications were removed on purpose: a domain the evidence items don't show scores low however often the resume names it.

${DOMAIN_GUIDE}

${RUBRIC}

For each domain return: domain, score, evidence (the ids of the items that show it, each with a short "why"), rationale (one sentence). "primary" is the single domain with the strongest evidence ("NONE" when nothing scores above 0). Be strict and calibrated — don't cluster scores.`;

const SHAPE = `Return ONLY a JSON object:
{"domains":[{"domain":${DOMAIN_KEYS.map((d) => `"${d}"`).join("|")},"score":number,"evidence":[{"itemId":string,"why":string}],"rationale":string}],"primary":string}`;

export const DOMAINS_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    domains: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          domain: { type: SchemaType.STRING, format: "enum", enum: [...DOMAIN_KEYS] },
          score: { type: SchemaType.NUMBER },
          evidence: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: { itemId: { type: SchemaType.STRING }, why: { type: SchemaType.STRING } },
              required: ["itemId", "why"],
            },
          },
          rationale: { type: SchemaType.STRING },
        },
        required: ["domain", "score", "evidence", "rationale"],
      },
    },
    primary: { type: SchemaType.STRING },
  },
  required: ["domains", "primary"],
};

/** Every item id with its verified quote. */
export function itemQuotes(x: Extraction): Map<string, string> {
  return new Map<string, string>([
    ...x.projects.map((p) => [p.id, p.quote] as [string, string]),
    ...x.experience.map((e) => [e.id, e.quote] as [string, string]),
    ...x.openSource.map((o) => [o.id, o.quote] as [string, string]),
  ]);
}

/** Model JSON → domain scores over known domains and known item ids (all five buckets present). */
export function readDomains(json: unknown, x: Extraction): { domains: DomainScore[]; primary: DomainKey | null } {
  const quotes = itemQuotes(x);
  const o = (json ?? {}) as { domains?: unknown; primary?: unknown };
  const byKey = new Map<DomainKey, DomainScore>();
  for (const d of (Array.isArray(o.domains) ? o.domains : []) as Record<string, unknown>[]) {
    const key = str(d.domain, 40).toUpperCase() as DomainKey;
    if (!DOMAIN_KEYS.includes(key) || byKey.has(key)) continue;
    const evidence = (Array.isArray(d.evidence) ? d.evidence : [])
      .map((e) => e as Record<string, unknown>)
      .map((e) => ({ itemId: str(e.itemId, 8).toUpperCase(), why: str(e.why, 200) }))
      .filter((e) => quotes.has(e.itemId))
      .map((e) => ({ ...e, quote: quotes.get(e.itemId) ?? "" }));
    byKey.set(key, { domain: key, score: num(d.score), evidence, rationale: str(d.rationale, 300) });
  }
  for (const b of BUCKETS) if (!byKey.has(b)) byKey.set(b, { domain: b, score: 0, evidence: [], rationale: "" });
  const domains = [...byKey.values()].sort((a, b) => b.score - a.score);
  const p = str(o.primary, 40).toUpperCase() as DomainKey;
  const primary = DOMAIN_KEYS.includes(p) && (byKey.get(p)?.score ?? 0) > 0 ? p : domains[0]?.score > 0 ? domains[0].domain : null;
  return { domains, primary };
}

export async function domainAnalystNode(s: State): Promise<Update> {
  const t0 = Date.now();
  const x = s.extraction!;
  const attempt = (s.attempts.domain_analyst ?? 0) + 1;
  const prior = s.domainReview && s.domainReview.verdict === "revise" && s.domainAnalysis ? s.domainAnalysis : null;
  const feedback = prior
    ? `\n\nA reviewer checked your previous scores against the same evidence and raised these issues. Fix what is right; keep any score you can defend from the evidence.\nPrevious scores: ${prior.domains
        .filter((d) => d.score > 0)
        .map((d) => `${d.domain} ${d.score}`)
        .join(", ")}\nIssues:\n- ${s.domainReview!.issues.join("\n- ")}`
    : "";
  const prompt = `Score this candidate's domains.\n\n${fence("evidence items", evidenceItems(x))}${feedback}`;

  const res = await callAgent<unknown>({
    label: `bucketing:${s.input.mobile}:domain`,
    chain: producerChain(),
    system: SYSTEM,
    schema: DOMAINS_SCHEMA,
    shapeHint: SHAPE,
    prompt,
    accept: (j) => Array.isArray((j as { domains?: unknown }).domains),
  });
  if (!res.ok) {
    const analysis: DomainAnalysis = { domains: [], primary: null, model: "", attempt, error: res.error };
    return { domainAnalysis: analysis, attempts: { domain_analyst: attempt }, ...traceEntry("domain_analyst", t0, `failed — ${res.error.slice(0, 120)}`) };
  }
  const { domains, primary } = readDomains(res.json, x);
  const analysis: DomainAnalysis = { domains, primary, model: res.model, attempt, error: "" };
  const top = domains
    .filter((d) => d.score > 0)
    .slice(0, 4)
    .map((d) => `${d.domain} ${d.score}`)
    .join(", ");
  return {
    domainAnalysis: analysis,
    attempts: { domain_analyst: attempt },
    models: [res.model],
    ...traceEntry("domain_analyst", t0, `${attempt > 1 ? "revised: " : ""}primary ${primary ?? "none"} (${top || "nothing scored"})`, res.model),
  };
}
