"use server";

import { SchemaType, type Part, type Schema } from "@google/generative-ai";
import { pdfBufferToText } from "@/lib/pdf-text";
import { runLlmChain } from "@/lib/llm-router";
import { bandLabel } from "@/lib/assignment-scoring";
import {
  CRITERION_CATEGORIES,
  type AssignmentCriterion,
  type AssignmentSpec,
  type CriterionCategory,
  type CriterionType,
  type CtcBand,
  type QuoteCheck,
} from "@/lib/assignment-types";
import type { ActionResult } from "@/lib/types";

// ═══════════════════════════════════════════════════════════════════════════
// 1. Assignment document → rubric
// ═══════════════════════════════════════════════════════════════════════════

const MAX_DOC_CHARS = 400_000;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const CRITERIA_SYSTEM = (band: string) => `You convert a take-home ASSIGNMENT document into the evaluation rubric used to screen candidates' GitHub submissions for a ${band} (CTC, India) role. The rubric must be restricted to exactly what the document asks.

RULES
1. Requirement criteria (type "mandatory" or "good") come ONLY from the document. Never add a requirement the document does not state, never generalise ("use best practices") unless the document says so.
2. Every requirement criterion MUST include "sourceQuote": an exact, verbatim excerpt (8-200 characters) copied from the document that states it. Copy characters exactly - do not paraphrase, fix typos or merge sentences.
3. type "mandatory" = the document requires it (must, should, required, implement, build, create, core/main features, submission requirements). type "good" = optional, bonus, nice-to-have, brownie points, extra credit, "if time permits".
4. Split compound requirements into atomic, independently verifiable criteria - one feature, API, screen, validation rule, constraint, tech requirement or deliverable each. Cover EVERY one the document asks for; do not skip minor ones, do not merge.
5. "requiredStack": technologies/frameworks/languages the document mandates. "restrictions": explicit prohibitions or limits (e.g. "do not use any UI library", "no ORM", "only vanilla JS", time/size limits) worded close to the document. "deliverables": what must be submitted (repo, README, setup steps, deployed link, demo video, tests...). Every deliverable that can be checked in the repository (README / setup instructions, tests, deployed link, env example, screenshots) must ALSO be a requirement criterion (category documentation / deployment / testing) with its own sourceQuote.
6. After the requirement criteria, add 5-8 criteria of type "excellence" (sourceQuote ""): what separates an outstanding submission from an average one FOR THIS SPECIFIC ASSIGNMENT AND STACK at this CTC band - e.g. clean architecture/separation of concerns, error handling and input validation, security basics, meaningful tests, readable typed code, sensible state/data management, incremental commit history, README/setup quality, performance where relevant. Make them concrete to the stack (name the layers, patterns or libraries a reviewer should look for). Never duplicate a requirement criterion.
7. weight 1-10: core mandatory features 8-10, minor mandatory items 5-7, good-to-have 3-5, excellence 3-6.
8. "howToVerify": what a reviewer should look for in the code (files, routes, components, functions, packages, config).
9. "category": one of ${CRITERION_CATEGORIES.join(", ")}.
10. "title": short (max 8 words). "summary": 3-4 sentences describing what the candidate must build.`;

const CRITERIA_SHAPE = `Return ONLY a JSON object of this exact shape:
{"title":string,"summary":string,"requiredStack":string[],"restrictions":string[],"deliverables":string[],"criteria":[{"title":string,"description":string,"category":string,"type":"mandatory"|"good"|"excellence","weight":number,"sourceQuote":string,"howToVerify":string}]}`;

const CRITERIA_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    title: { type: SchemaType.STRING },
    summary: { type: SchemaType.STRING },
    requiredStack: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    restrictions: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    deliverables: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    criteria: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          title: { type: SchemaType.STRING },
          description: { type: SchemaType.STRING },
          category: { type: SchemaType.STRING, format: "enum", enum: [...CRITERION_CATEGORIES] },
          type: { type: SchemaType.STRING, format: "enum", enum: ["mandatory", "good", "excellence"] },
          weight: { type: SchemaType.NUMBER },
          sourceQuote: { type: SchemaType.STRING },
          howToVerify: { type: SchemaType.STRING },
        },
        required: ["title", "description", "category", "type", "weight", "sourceQuote", "howToVerify"],
      },
    },
  },
  required: ["title", "summary", "requiredStack", "restrictions", "deliverables", "criteria"],
};

function str(v: unknown, max = 2000): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function strList(v: unknown, maxItems = 30, maxLen = 300): string[] {
  return Array.isArray(v) ? v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems) : [];
}

function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Is the quote really in the document? Exact after normalisation, else a close match. */
function checkQuote(quote: string, docNorm: string, docTokens: Set<string>): QuoteCheck {
  if (!docNorm) return "skipped";
  const q = normText(quote);
  if (!q) return "missing";
  if (docNorm.includes(q)) return "exact";
  const words = q.split(" ");
  const meaningful = words.filter((w) => w.length > 2);
  if (!meaningful.length) return "missing";
  const coverage = meaningful.filter((w) => docTokens.has(w)).length / meaningful.length;
  let run = false;
  for (let i = 0; i + 4 <= words.length && !run; i++) run = docNorm.includes(words.slice(i, i + 4).join(" "));
  return coverage >= 0.85 && (run || words.length < 4) ? "approx" : "missing";
}

const TYPE_ORDER: Record<CriterionType, number> = { mandatory: 0, good: 1, excellence: 2 };
const DEFAULT_WEIGHT: Record<CriterionType, number> = { mandatory: 8, good: 4, excellence: 4 };

function normalizeSpec(json: unknown, docText: string, model: string): AssignmentSpec {
  const o = (json ?? {}) as Record<string, unknown>;
  const docNorm = normText(docText);
  const docTokens = new Set(docNorm.split(" "));
  const raw = Array.isArray(o.criteria) ? (o.criteria as Record<string, unknown>[]) : [];

  const criteria = raw
    .map((c, i) => {
      const type = (["mandatory", "good", "excellence"].includes(String(c.type)) ? c.type : "mandatory") as CriterionType;
      const category = (CRITERION_CATEGORIES as readonly string[]).includes(String(c.category))
        ? (c.category as CriterionCategory)
        : "other";
      const w = Number(c.weight);
      const sourceQuote = type === "excellence" ? "" : str(c.sourceQuote, 400);
      const quoteCheck: QuoteCheck = type === "excellence" ? "skipped" : checkQuote(sourceQuote, docNorm, docTokens);
      return {
        order: i,
        c: {
          id: "",
          title: str(c.title, 120) || `Criterion ${i + 1}`,
          description: str(c.description, 600),
          category,
          type,
          weight: Number.isFinite(w) ? Math.round(Math.min(10, Math.max(1, w))) : DEFAULT_WEIGHT[type],
          sourceQuote,
          quoteCheck,
          howToVerify: str(c.howToVerify, 600),
          // A requirement whose quote isn't in the document may be invented — off until a human confirms it.
          enabled: type === "excellence" || quoteCheck !== "missing",
        } satisfies AssignmentCriterion,
      };
    })
    .sort((a, b) => TYPE_ORDER[a.c.type] - TYPE_ORDER[b.c.type] || a.order - b.order)
    .map(({ c }, i) => ({ ...c, id: `C${i + 1}` }));

  return {
    title: str(o.title, 200) || "Assignment",
    summary: str(o.summary, 1500),
    requiredStack: strList(o.requiredStack),
    restrictions: strList(o.restrictions),
    deliverables: strList(o.deliverables),
    criteria,
    model,
  };
}

/**
 * Read the assignment (pasted text and/or an uploaded PDF / text file) and derive
 * the rubric. FormData fields: `text`, `file` (optional), `ctcBand`, `company`.
 */
export async function deriveAssignmentCriteria(
  formData: FormData,
): Promise<ActionResult<{ spec: AssignmentSpec; documentText: string }>> {
  try {
    const pasted = String(formData.get("text") ?? "").trim();
    const band = (String(formData.get("ctcBand") ?? "8to12") || "8to12") as CtcBand;
    const company = String(formData.get("company") ?? "").trim();
    const file = formData.get("file");

    let pdf: Buffer | null = null;
    let fileText = "";
    if (file && typeof file === "object" && "arrayBuffer" in file && (file as File).size > 0) {
      const f = file as File;
      if (f.size > MAX_UPLOAD_BYTES) return { ok: false, error: "The uploaded file is larger than 15 MB." };
      const buf = Buffer.from(await f.arrayBuffer());
      const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name) || buf.subarray(0, 5).toString() === "%PDF-";
      if (isPdf) {
        pdf = buf;
        fileText = await pdfBufferToText(buf);
      } else {
        fileText = buf.toString("utf8");
      }
    }

    const documentText = [pasted, fileText].filter(Boolean).join("\n\n").slice(0, MAX_DOC_CHARS);
    if (!documentText && !pdf) return { ok: false, error: "Paste the assignment text or upload the assignment document first." };
    if (!documentText && pdf) {
      // Scanned PDF: Gemini can still read it, but quotes can't be verified against text.
      console.warn("[assignment] uploaded PDF has no extractable text (scanned?) — quote verification skipped");
    }

    const bandText = bandLabel(band);
    const instruction =
      `${company ? `Company: ${company}\n` : ""}Target CTC band: ${bandText}\n\n` +
      `Build the rubric for the assignment below. Remember: requirement criteria must quote the document verbatim.`;

    const result = await runLlmChain({
      label: "criteria",
      system: CRITERIA_SYSTEM(bandText),
      schema: CRITERIA_SCHEMA,
      shapeHint: CRITERIA_SHAPE,
      temperature: 0.1,
      maxOutputTokens: 16_384,
      accept: (j) => Array.isArray((j as { criteria?: unknown }).criteria) && ((j as { criteria: unknown[] }).criteria.length > 0),
      build: (_tier, budget) => {
        const doc = documentText.slice(0, budget);
        const text = `${instruction}\n\n=== ASSIGNMENT DOCUMENT ===\n${doc}\n=== END OF DOCUMENT ===`;
        if (pdf) {
          const parts: Array<string | Part> = [
            { inlineData: { mimeType: "application/pdf", data: pdf.toString("base64") } },
            pasted
              ? `${instruction}\n\nThe attached PDF is the assignment. Additional pasted text from the recruiter:\n${pasted.slice(0, budget)}`
              : `${instruction}\n\nThe attached PDF is the assignment document.`,
          ];
          return { geminiParts: parts, text };
        }
        return { geminiParts: text, text };
      },
    });
    if (!result.ok) return { ok: false, error: result.error };

    const spec = normalizeSpec(result.json, documentText, `${result.provider}/${result.model}`);
    if (!spec.criteria.length) return { ok: false, error: "The model returned no criteria — try again." };
    return { ok: true, data: { spec, documentText } };
  } catch (err) {
    console.error("[assignment] deriveAssignmentCriteria failed:", err);
    return { ok: false, error: err instanceof Error ? err.message : "Could not analyse the assignment." };
  }
}
