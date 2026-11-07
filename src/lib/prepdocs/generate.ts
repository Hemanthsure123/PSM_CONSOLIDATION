import "server-only";
import { env } from "@/lib/env";
import { runLlmChain } from "@/lib/llm-router";
import { normalizePrepDoc, PREP_DOC_SCHEMA, PREP_DOC_SHAPE_HINT, type PrepDoc } from "@/lib/prepdocs/model";
import { PREP_DOC_SYSTEM } from "@/lib/prepdocs/prompt";
import type { SourceText } from "@/lib/prepdocs/sources";

/**
 * Writes a prep document from the evidence with the team's prompt, through the shared model
 * chain (PREP_LLM_CHAIN overrides it). Optional public research uses Gemini with Google Search
 * grounding; when no key can do that, the document says research wasn't available instead.
 */

const DEFAULT_CHAIN =
  "gemini:gemini-3.5-flash,gemini:gemini-2.5-flash,openai:gpt-5.5,openai:gpt-5.4-mini,mistral:codestral-latest,mistral:ministral-14b-latest";

export interface GenerateInput {
  company: string;
  role: string;
  round: string;
  process: string[];
  websiteUrl: string | null;
  linkedinUrl: string | null;
  sources: SourceText[];
  research: string | null;
  existingText: string | null;
}

/** Public research notes (company facts, typical round content) with Google Search grounding. Null when unavailable. */
export async function research(company: string, role: string, round: string, website: string | null): Promise<string | null> {
  const keys = env.gemini.apiKeys;
  if (!keys.length) return null;
  const prompt =
    `Research the company "${company}"${website ? ` (website ${website})` : ""} for a candidate preparing for the "${round}" round of a "${role}" interview.\n` +
    "Return short factual notes with sources: what they build, products, customers, scale, founded, location, founders, funding; " +
    "and any PUBLIC interview reports for this company and role (Glassdoor, LeetCode Discuss, blogs). " +
    "If you find no interview reports for this exact company, write exactly: NO PUBLIC INTERVIEW REPORTS FOUND. Never use another company's questions.";
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
        const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim();
        if (text) return text.slice(0, 12_000);
      } catch {
        // next key / model
      }
    }
  }
  return null;
}

function evidence(input: GenerateInput, budget: number): string {
  const parts: string[] = [
    `COMPANY: ${input.company}`,
    `ROLE: ${input.role || "not stated"}`,
    `ROUND: ${input.round || "not stated"}`,
    input.process.length ? `INTERVIEW PROCESS: ${input.process.join(" > ")}` : "",
    input.websiteUrl ? `WEBSITE: ${input.websiteUrl}` : "",
    input.linkedinUrl ? `LINKEDIN: ${input.linkedinUrl} (reference link only; its content was not read)` : "",
    "",
  ];
  const usable = input.sources.filter((s) => s.text.trim());
  const unreadable = input.sources.filter((s) => !s.text.trim());
  if (unreadable.length) parts.push(`SOURCES THAT COULD NOT BE READ: ${unreadable.map((s) => `${s.kind} ${s.url} (${s.error ?? "empty"})`).join("; ")}`);
  if (input.existingText) parts.push("=== EXISTING DOCUMENT (update it) ===", input.existingText.slice(0, 40_000), "");
  if (input.research) parts.push("=== PUBLIC RESEARCH NOTES (lower priority than the team's material) ===", input.research, "");
  else parts.push("=== PUBLIC RESEARCH NOTES ===", "Online research was not available for this run. Use only the supplied material and say so in unverified.", "");
  // Share the remaining budget across the sources, drill-downs and transcripts first.
  const fixed = parts.join("\n").length;
  const left = Math.max(10_000, budget - fixed);
  const per = Math.floor(left / Math.max(1, usable.length));
  for (const s of usable) {
    const label = s.kind === "drilldown" ? "DRILL-DOWN (hiring intelligence)" : s.kind === "transcript" ? "INTERVIEW TRANSCRIPT" : "COMPANY WEBSITE TEXT";
    parts.push(`=== ${label}: ${s.title || s.url}${s.modifiedAt ? ` (updated ${s.modifiedAt.slice(0, 10)})` : ""} ===`, s.text.slice(0, per), "");
  }
  return parts.filter((p) => p !== undefined).join("\n");
}

export async function generatePrepDoc(input: GenerateInput): Promise<{ doc: PrepDoc; model: string } | { error: string }> {
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
    accept: (json) => normalizePrepDoc(json) !== null,
  });
  if (!res.ok) return { error: res.error };
  const doc = normalizePrepDoc(res.json);
  if (!doc) return { error: "The model's document was incomplete." };
  return { doc, model: `${res.provider}/${res.model}` };
}
