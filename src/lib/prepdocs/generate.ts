import "server-only";
import { ensureAdminKeys } from "@/lib/admin/api-keys";
import { env } from "@/lib/env";
import { runLlmChain } from "@/lib/llm-router";
import { Evidence, fitToBudget, normalizePrepDoc, PAGE_BUDGET, PREP_DOC_SCHEMA, PREP_DOC_SHAPE_HINT, richness, type PrepDoc } from "@/lib/prepdocs/model";
import { PREP_DOC_SYSTEM } from "@/lib/prepdocs/prompt";
import type { SourceText } from "@/lib/prepdocs/sources";

/**
 * Writes a prep document from the evidence with the team's master prompt, through the shared
 * model chain (PREP_LLM_CHAIN overrides it). Company research is a toggle: when on (and the
 * mentor confirmed the plan in the app), Gemini searches with Google Search grounding using the
 * plan's queries; only questions from sources that name the company count, and the sources line
 * lists only pages the search actually returned.
 */

const DEFAULT_CHAIN =
  "gemini:gemini-3.5-flash,gemini:gemini-2.5-flash,openai:gpt-5.5,openai:gpt-5.4-mini,mistral:codestral-latest,mistral:ministral-14b-latest";

export interface ResearchPlan {
  company: string;
  role: string;
  round: string;
  queries: string[];
  suppliedLinks: string[];
}

/** The research plan shown in the app before anything is searched (§3.2). */
export function researchPlan(company: string, role: string, round: string, links: string[]): ResearchPlan {
  const r = role || "interview";
  return {
    company,
    role,
    round,
    queries: [`${company} ${r} interview questions`, `${company} interview experience ${round || ""}`.trim(), `${company} ${r} interview process rounds`],
    suppliedLinks: links.filter((l) => /^https?:\/\//i.test(l)),
  };
}

export interface ResearchNotes {
  notes: string;
  /** Pages the search returned, resolved to their real address. */
  sources: { title: string; url: string }[];
  /** Searches that returned nothing usable. */
  empty: string[];
}

/** A grounding redirect → the page's real address (only pages Google actually returned). */
async function resolve(uri: string): Promise<string | null> {
  try {
    let res = await fetch(uri, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(6_000) });
    if (!res.headers.get("location") && (res.status === 405 || res.status === 400)) res = await fetch(uri, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(6_000) });
    const loc = res.headers.get("location");
    if (loc && /^https?:\/\//i.test(loc)) return loc;
    return res.ok && !/vertexaisearch|grounding-api-redirect/i.test(uri) ? uri : null;
  } catch {
    return null;
  }
}

/** Public research with the confirmed plan. Null when no key can search. */
export async function research(plan: ResearchPlan): Promise<ResearchNotes | null> {
  await ensureAdminKeys();
  const keys = env.gemini.apiKeys;
  if (!keys.length) return null;
  const prompt =
    `Research the company "${plan.company}" for a candidate preparing for the "${plan.round}" round of a "${plan.role || "interview"}" interview.\n` +
    `Run these searches: ${plan.queries.map((q) => `"${q}"`).join("; ")}.${plan.suppliedLinks.length ? ` Also use these pages: ${plan.suppliedLinks.join(", ")}.` : ""}\n` +
    "Return short notes in two parts:\n" +
    "COMPANY FACTS — what they do, products, scale; each fact followed by (source: <site name>). Only facts a named source states.\n" +
    `INTERVIEW REPORTS — questions and round details ONLY from sources that explicitly name ${plan.company} AND describe an interview, assessment or round (not SEO listicles, vendor blogs or banks that mention the company in passing); each item followed by (source: <site name>).\n` +
    `If no source names ${plan.company} for interviews, write exactly: NO PUBLIC INTERVIEW REPORTS FOUND. Never use another company's questions.`;
  for (const model of ["gemini-2.5-flash", "gemini-3.5-flash"]) {
    for (const key of keys.slice(0, 4)) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.2 } }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) continue;
        const json = (await res.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] }; groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[]; webSearchQueries?: string[] } }[];
        };
        const c = json.candidates?.[0];
        const text = c?.content?.parts?.map((p) => p.text ?? "").join("").trim();
        if (!text) continue;
        const chunks = (c?.groundingMetadata?.groundingChunks ?? []).map((g) => g.web).filter((w): w is { uri: string; title?: string } => Boolean(w?.uri)).slice(0, 10);
        const resolved = await Promise.all(chunks.map(async (w) => ({ title: (w.title ?? "").trim(), url: await resolve(w.uri) })));
        const sources = resolved.filter((s): s is { title: string; url: string } => Boolean(s.url && s.title));
        const used = (c?.groundingMetadata?.webSearchQueries ?? []).map((q) => q.toLowerCase());
        return { notes: text.slice(0, 12_000), sources: dedupe(sources).slice(0, 8), empty: sources.length ? [] : plan.queries.filter((q) => !used.includes(q.toLowerCase())) };
      } catch {
        // next key / model
      }
    }
  }
  return null;
}

const dedupe = (list: { title: string; url: string }[]) => {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = s.url.replace(/[#?].*$/, "").replace(/\/+$/, "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

export interface GenerateInput {
  company: string;
  role: string;
  round: string;
  process: string[];
  websiteUrl: string | null;
  linkedinUrl: string | null;
  sources: SourceText[];
  /** Null when research was off (or unavailable). */
  research: ResearchNotes | null;
  researchRequested: boolean;
  existingText: string | null;
}

const LABEL: Record<SourceText["kind"], string> = {
  drilldown: "HIRING INTELLIGENCE — DRILL-DOWN",
  transcript: "HIRING INTELLIGENCE — INTERVIEW TRANSCRIPT",
  rsa: "HIRING INTELLIGENCE — RSA (an earlier candidate's round, from a call with them)",
  website: "COMPANY WEBSITE TEXT (supplied)",
};

function evidence(input: GenerateInput, budget: number): string {
  const parts: string[] = [
    `COMPANY: ${input.company}`,
    `ROLE: ${input.role || "not stated"}`,
    `ROUND: ${input.round || "not stated"}`,
    input.process.length ? `INTERVIEW PROCESS (from our sheet): ${input.process.join(" > ")}` : "",
    input.websiteUrl ? `COMPANY WEBSITE (supplied): ${input.websiteUrl}` : "",
    input.linkedinUrl ? `COMPANY LINKEDIN (supplied, reference link only; its content was not read): ${input.linkedinUrl}` : "",
    "",
  ];
  const usable = input.sources.filter((s) => s.text.trim());
  if (input.existingText) parts.push("=== EXISTING DOCUMENT (update it) ===", input.existingText.slice(0, 40_000), "");
  if (input.research) {
    parts.push("=== RESEARCH NOTES (named public sources; lower priority than hiring intelligence) ===", input.research.notes);
    if (input.research.sources.length) parts.push("RESEARCH SOURCES ACTUALLY READ (the only research links you may list):", ...input.research.sources.map((s) => `- ${s.title}: ${s.url}`));
    parts.push("");
  } else if (input.researchRequested) {
    parts.push("=== RESEARCH NOTES ===", "Research was requested but the search was unavailable. Build only from the supplied material and add that to unverified.", "");
  } else {
    parts.push("=== NO RESEARCH ===", "Build only from the supplied material. Do not mention research. aboutCompany only from supplied company details.", "");
  }
  // Share the remaining budget across the sources, hiring intelligence first.
  const fixed = parts.join("\n").length;
  const left = Math.max(10_000, budget - fixed);
  const per = Math.floor(left / Math.max(1, usable.length));
  for (const s of usable) {
    parts.push(`=== ${LABEL[s.kind]}: ${s.title || s.url}${s.modifiedAt ? ` (updated ${s.modifiedAt.slice(0, 10)})` : ""} ===`, s.text.slice(0, per), "");
  }
  return parts.join("\n");
}

export async function generatePrepDoc(input: GenerateInput): Promise<{ doc: PrepDoc; model: string; budget: number; cuts: string[]; moved: number } | { error: string }> {
  const material = input.sources.filter((s) => s.text.trim());
  const ev = new Evidence(
    [...material.map((s) => s.text), input.research?.notes ?? "", input.existingText ?? ""],
    [...(input.research?.sources.map((s) => s.url) ?? []), input.websiteUrl ?? "", input.linkedinUrl ?? ""].filter(Boolean),
  );
  const companyDetailsAllowed = material.some((s) => s.kind === "website") || Boolean(input.research?.sources.length) || Boolean(input.existingText);
  const opts = { evidence: ev, companyDetailsAllowed };
  const res = await runLlmChain({
    system: PREP_DOC_SYSTEM,
    schema: PREP_DOC_SCHEMA,
    shapeHint: PREP_DOC_SHAPE_HINT,
    temperature: 0.2,
    chain: process.env.PREP_LLM_CHAIN?.trim() || DEFAULT_CHAIN,
    maxOutputTokens: 16_000,
    timeoutMs: 180_000,
    label: "prep-doc",
    build: (_tier, budget) => {
      const text = evidence(input, budget);
      return { geminiParts: text, text };
    },
    accept: (json) => normalizePrepDoc(json, opts) !== null,
  });
  if (!res.ok) return { error: res.error };
  const raw = normalizePrepDoc(res.json);
  const doc = normalizePrepDoc(res.json, opts);
  if (!doc || !raw) return { error: "The model's document was incomplete." };
  // Without research there is nothing to say about public reports (§3.1: never mention skipped research).
  if (!input.research) {
    doc.startHere = doc.startHere.map((p) => p.replace(/[^.]*\bno public interview reports\b[^.]*\.\s*(So this guide is built from[^.]*\.)?\s*/i, "").trim()).filter(Boolean);
    doc.noInterviewReports = false;
  }
  const moved = raw.sections.reduce((n, s) => n + s.asked.length, 0) - doc.sections.reduce((n, s) => n + s.asked.length, 0);
  // The page budget from the real intelligence (§5); never more than 7 pages.
  const real = doc.sections.reduce((n, s) => n + s.asked.length, 0);
  const budget = PAGE_BUDGET[richness(real, material.filter((s) => s.kind !== "website").reduce((n, s) => n + s.text.length, 0))];
  const fitted = fitToBudget(doc, budget);
  if (moved > 0) fitted.doc.unverified = [...fitted.doc.unverified, `${moved} question${moved === 1 ? "" : "s"} not found in the material moved to "Questions to practise"`].slice(0, 20);
  return { doc: fitted.doc, model: `${res.provider}/${res.model}`, budget, cuts: fitted.cuts, moved };
}
