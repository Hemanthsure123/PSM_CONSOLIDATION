import "server-only";
import { SchemaType, type Part, type Schema } from "@google/generative-ai";
import { env } from "@/lib/env";
import { runLlmChain, type ChainResult } from "@/lib/llm-router";
import {
  DOC_LABEL,
  geminiOnly,
  loadResumeContent,
  looksLikeResume,
  transcribeDocument,
  type ResumeContent,
} from "@/lib/resume-content";
import { inText, loose, textCtx, type TextCtx } from "@/lib/qa-verify";
import {
  MIN_RETURNED_RELEVANCE,
  MIN_RETURNED_SCORE,
  OTHER_CATEGORY,
  failedBenchmark,
  type BenchmarkCandidateInput,
  type BenchmarkDomainProfile,
  type BenchmarkProject,
  type BenchmarkResult,
} from "@/lib/benchmark-types";

/**
 * Benchmark Projects — everything is judged against the ONE domain the user
 * typed ("Generative AI", "MERN Stack", "Java Spring Boot" …):
 *
 *  1. `buildDomainProfile` turns that text into a domain profile once per run —
 *     what counts as the domain, its sub-areas, what production-grade and basic
 *     work look like in it, and its terms.
 *  2. `extractBenchmarkProjects` reads ONE resume against that profile and keeps
 *     only the domain's industry-standard (≥15 LPA) projects. A resume with none
 *     of the domain's terms is skipped without a model call.
 *
 * Accuracy: images / scanned PDFs are identified before anything is read
 * (resume-content.ts); every project must be traceable to the resume text, and
 * technologies the resume never names are dropped. Gemini judges; Mistral takes
 * over only when Gemini is rate-limited (llm-router.ts). The browser applies the
 * quality and domain-match bars, so changing them never needs a re-read.
 */

const DEFAULT_CHAIN =
  "gemini:gemini-3.8-flash,gemini:gemini-3.5-flash,gemini:gemini-3-flash-preview,gemini:gemini-3.1-flash-lite,gemini:gemini-2.5-flash," +
  "mistral:ministral-14b-latest,mistral:codestral-latest,mistral:ministral-8b-latest";
/** A slow model holds a screening slot; past this the next model is tried. */
const TIER_TIMEOUT_MS = 60_000;
const MAX_TEXT = 24_000;
const MAX_PROJECTS = 15;

function chain(): string {
  return env.benchmarks.llmChain || DEFAULT_CHAIN;
}

const str = (v: unknown, max = 400) =>
  typeof v === "string"
    ? v
        .replace(/\\u([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

const strList = (v: unknown, maxItems: number, maxLen: number) =>
  Array.isArray(v)
    ? Array.from(new Set(v.map((x) => str(x, maxLen).replace(/^[•\-*\d.)\s]+/, "").trim()).filter(Boolean))).slice(0, maxItems)
    : [];

const bullets = (items: string[]) => items.map((s) => `   - ${s}`).join("\n");

// ── 1. The domain profile ────────────────────────────────────────────────────

const PROFILE_SYSTEM = `You define a technical domain so that resumes can be screened for that domain's best projects. The user typed a domain — it may be a field ("Generative AI", "Data Engineering"), a role ("Backend Developer") or a tech stack ("MERN Stack", "Java Spring Boot"). Keep exactly the user's intent; do not widen it into a neighbouring field. Follow the user's focus notes when given (inclusions and exclusions).

Return JSON:
- "domain": a clean display name for exactly what the user typed (e.g. "Generative AI", "MERN Stack Development", "Java Spring Boot Backend") — fix capitalisation only; never add the focus notes or anything else to it.
- "summary": 1-2 sentences: what project work counts as this domain, and what does not.
- "categories": 4-8 mutually exclusive sub-areas of this domain to group its projects under (e.g. for Generative AI: "RAG & Knowledge Retrieval", "AI Agents & Tool Use", "LLM Fine-tuning & Evaluation", "Multimodal & Diffusion", "LLMOps & Model Serving"). Short names.
- "advancedSignals": 8-14 concrete signs that a project in THIS domain is production-grade and worth a 15+ LPA role — architecture, optimisation, scale, evaluation, real-world use, hard techniques specific to the domain.
- "basicExamples": 6-12 project types in THIS domain that are basic, tutorial-level or overdone and must be excluded (e.g. for Generative AI: "chatbot that only forwards prompts to the OpenAI API").
- "keywords": 40-80 lowercase terms of this domain — technologies, libraries, frameworks, services, concepts, abbreviations and common spellings (e.g. "llm", "rag", "langchain", "vector database", "hugging face"). A resume that contains NONE of them cannot have a project in this domain, so be inclusive: cover every common tool and synonym.`;

const PROFILE_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    domain: { type: SchemaType.STRING },
    summary: { type: SchemaType.STRING },
    categories: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    advancedSignals: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    basicExamples: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    keywords: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  },
  required: ["domain", "summary", "categories", "advancedSignals", "basicExamples", "keywords"],
};

const PROFILE_SHAPE = `Return ONLY a JSON object:
{"domain": string, "summary": string, "categories": string[], "advancedSignals": string[], "basicExamples": string[], "keywords": string[]}`;

/** Words of the typed domain itself always count as its terms ("generative", "spring"). */
const DOMAIN_STOP = new Set(["and", "the", "for", "with", "development", "developer", "engineering", "engineer", "stack", "based", "projects", "project"]);

export async function buildDomainProfile(input: string, focus: string): Promise<{ ok: true; profile: BenchmarkDomainProfile } | { ok: false; error: string }> {
  const domainText = input.trim().slice(0, 200);
  const focusText = focus.trim().slice(0, 1500);
  if (!domainText) return { ok: false, error: "Type the domain to screen for." };
  const prompt = `Domain the user typed: ${domainText}${focusText ? `\nFocus notes from the user: ${focusText}` : ""}\n\nDefine this domain.`;
  const res = await runLlmChain({
    label: `bench-profile:${domainText.slice(0, 40)}`,
    chain: chain(),
    system: PROFILE_SYSTEM,
    schema: PROFILE_SCHEMA,
    shapeHint: PROFILE_SHAPE,
    temperature: 0.2,
    timeoutMs: TIER_TIMEOUT_MS,
    maxOutputTokens: 8_192,
    accept: (j) => Array.isArray((j as { categories?: unknown }).categories) && (j as { categories: unknown[] }).categories.length > 0,
    build: () => ({ geminiParts: prompt, text: prompt }),
  });
  if (!res.ok) return { ok: false, error: `Could not prepare the domain: ${res.error}` };
  const j = res.json as Record<string, unknown>;

  const categories = strList(j.categories, 8, 60).filter((c) => loose(c) !== loose(OTHER_CATEGORY));
  const typed = domainText
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((w) => w.length >= 3 && !DOMAIN_STOP.has(w));
  const keywords = Array.from(new Set([...strList(j.keywords, 120, 50).map((k) => k.toLowerCase()), ...typed])).filter((k) => k.length >= 2);
  if (!categories.length) return { ok: false, error: "Could not prepare the domain: no sub-areas came back — try again." };

  return {
    ok: true,
    profile: {
      domain: str(j.domain, 80) || domainText,
      input: domainText,
      focus: focusText,
      summary: str(j.summary, 500),
      categories,
      advancedSignals: strList(j.advancedSignals, 16, 200),
      basicExamples: strList(j.basicExamples, 14, 200),
      keywords,
    },
  };
}

// ── 2. Screening one resume against the profile ──────────────────────────────

function screeningSystem(p: BenchmarkDomainProfile): string {
  const d = p.domain;
  return `Act as a Senior Technical Recruiter and Principal Software Architect specialising in ${d}. You read ONE candidate's resume and extract the absolute best, industry-standard ${d} projects from it. They will be used as benchmark ${d} project ideas to train students for ${d} job opportunities paying 15 LPA or more, so precision matters far more than count.

TARGET DOMAIN: ${d}
${p.summary}${p.focus ? `\nFocus from the user (follow it): ${p.focus}` : ""}
Sub-areas of ${d}: ${p.categories.join(" | ")}

Strictly follow these rules:

1. Domain first. Consider ONLY projects whose core engineering is ${d} work. A project from another domain is ignored however good it is — do not stretch a project to fit ${d}. Consider the Projects section and substantial project work described under internships / experience. Base everything ONLY on the resume: never invent a project, feature, component, technology, scale or metric.

2. 15+ LPA quality filter — select a ${d} project ONLY if its description demonstrates complex, production-grade engineering, such as:
${bullets(p.advancedSignals)}
   and, in general: advanced architecture, system optimisation, scalability, real-world problem solving with real users or data, heavy data handling.

3. Ignore basic projects completely, including:
${bullets(p.basicExamples)}
   and, in general: calculators, to-do lists, standard CRUD apps, simple UI clones, tutorial or course projects, and vague projects with no technical detail.

4. Quality over quantity — no limit: return EVERY ${d} project in this resume that genuinely meets the bar, and none that doesn't. Never pad. An empty list is normal and correct for most resumes.

5. Ignore links — never evaluate or require GitHub links, deployment URLs or portfolios. Judge only the technical description, features and tech stack.

For each selected project return:
- "title": the project's name as written in the resume (tidy capitalisation only).
- "category": exactly one of: ${[...p.categories, OTHER_CATEGORY].map((c) => `"${c}"`).join(", ")} — the ${d} sub-area it fits best.
- "techStack": the technologies the resume names for this project (max 12, short names).
- "architecture": 3-6 short bullets naming the complex technical components and how they fit together. Only what the resume states or what its stated stack directly implies; never add numbers the resume doesn't give.
- "whyBenchmark": 1-2 sentences on the engineering depth and why ${d} teams hiring at 15+ LPA value exactly this.
- "relevance" (0-100): how squarely the project is ${d} work — 85-100 = the project IS ${d} work; 70-84 = ${d} is a major part of it; 50-69 = partial overlap. Do NOT return projects below 50.
- "score" (0-100) against the 15 LPA bar for ${d}: 85-100 = exceptional, would stand out at a top product company; 70-84 = clearly meets the bar; 60-69 = borderline. Do NOT return projects below 60. Be strict and calibrated — do not give everything 80.
- "evidence": 5-15 words copied EXACTLY from the resume's description of this project — used to verify that the project really is in the resume.

Also return "isResume": false when the document is not a resume at all.`;
}

function screeningSchema(p: BenchmarkDomainProfile): Schema {
  return {
    type: SchemaType.OBJECT,
    properties: {
      isResume: { type: SchemaType.BOOLEAN },
      projects: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            title: { type: SchemaType.STRING },
            category: { type: SchemaType.STRING, format: "enum", enum: [...p.categories, OTHER_CATEGORY] },
            techStack: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
            architecture: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
            whyBenchmark: { type: SchemaType.STRING },
            relevance: { type: SchemaType.NUMBER },
            score: { type: SchemaType.NUMBER },
            evidence: { type: SchemaType.STRING },
          },
          required: ["title", "category", "techStack", "architecture", "whyBenchmark", "relevance", "score", "evidence"],
        },
      },
    },
    required: ["isResume", "projects"],
  };
}

function screeningShape(p: BenchmarkDomainProfile): string {
  return `Return ONLY a JSON object:
{"isResume": boolean, "projects": [{"title": string, "category": string, "techStack": string[], "architecture": string[], "whyBenchmark": string, "relevance": number, "score": number, "evidence": string}]}
"category" must be exactly one of: ${[...p.categories, OTHER_CATEGORY].join(" | ")}.`;
}

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

/** A sub-area the model wrote slightly differently ("RAG and Knowledge Retrieval") → the profile's own name. */
function toCategory(v: unknown, p: BenchmarkDomainProfile): string {
  const s = loose(str(v, 80));
  if (!s) return OTHER_CATEGORY;
  const exact = p.categories.find((c) => loose(c) === s);
  if (exact) return exact;
  const partial = p.categories.find((c) => loose(c).includes(s) || s.includes(loose(c)));
  return partial ?? OTHER_CATEGORY;
}

/**
 * Is the project really in this resume? Its evidence phrase must be in the text
 * (spacing / punctuation ignored, phrases broken across columns tolerated), or
 * its title must be.
 */
function traceable(title: string, evidence: string, ctx: TextCtx): boolean {
  if (evidence && inText(evidence, ctx)) return true;
  const t = loose(title);
  return t.length >= 6 && ctx.loose.includes(t);
}

function verifiedProjects(
  json: Record<string, unknown>,
  text: string,
  p: BenchmarkDomainProfile,
): { projects: BenchmarkProject[]; unverified: number } {
  const raw = Array.isArray(json.projects) ? (json.projects as Record<string, unknown>[]) : [];
  const ctx = textCtx(text);
  const projects: BenchmarkProject[] = [];
  let unverified = 0;
  const seen = new Set<string>();
  for (const item of raw.slice(0, MAX_PROJECTS * 2)) {
    if (!item || typeof item !== "object") continue;
    const title = str(item.title, 140);
    const score = clampScore(item.score);
    const relevance = clampScore(item.relevance);
    if (!title || score < MIN_RETURNED_SCORE || relevance < MIN_RETURNED_RELEVANCE) continue;
    if (!traceable(title, str(item.evidence, 300), ctx)) {
      unverified++;
      continue;
    }
    const key = loose(title);
    if (seen.has(key)) continue;
    seen.add(key);
    const architecture = strList(item.architecture, 6, 240);
    const whyBenchmark = str(item.whyBenchmark, 500);
    if (!architecture.length || !whyBenchmark) continue;
    projects.push({
      title,
      category: toCategory(item.category, p),
      // A technology the resume never names is the model's guess — leave it out.
      techStack: strList(item.techStack, 12, 40).filter((t) => inText(t, ctx)),
      architecture,
      whyBenchmark,
      score,
      relevance,
    });
    if (projects.length >= MAX_PROJECTS) break;
  }
  projects.sort((a, b) => b.score - a.score);
  return { projects, unverified };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does the resume name any term of the domain? Short terms ("rag", "llm", "aws")
 * must stand alone as a word; longer ones may sit inside one ("langchain-based").
 */
function mentionsDomain(text: string, keywords: string[]): boolean {
  if (!keywords.length) return true;
  const lower = text.toLowerCase();
  return keywords.some((k) =>
    k.length <= 3 || !/[a-z]/.test(k) ? new RegExp(`(?<![a-z0-9])${escapeRe(k)}(?![a-z0-9])`).test(lower) : lower.includes(k),
  );
}

async function readWithModel(c: BenchmarkCandidateInput, content: ResumeContent, p: BenchmarkDomainProfile): Promise<ChainResult> {
  const instruction = `Screen this resume and return only its ${p.domain} projects that meet the 15+ LPA bar (an empty list if none do).`;
  const textPrompt = `${instruction}\n\nResume text:\n${content.text.slice(0, MAX_TEXT)}`;
  return runLlmChain({
    label: `bench:${c.label || c.id}`,
    chain: chain(),
    system: screeningSystem(p),
    schema: screeningSchema(p),
    shapeHint: screeningShape(p),
    temperature: 0.1,
    timeoutMs: TIER_TIMEOUT_MS,
    fast: true,
    // Room for the model's judgement plus a long answer — a cut-off JSON wastes the whole call.
    maxOutputTokens: 32_768,
    // Same judgement as the default effort on side-by-side checks, at a fraction of the latency.
    thinking: "low",
    accept: (j) => Array.isArray((j as { projects?: unknown }).projects),
    build: () => ({
      geminiParts: content.inline ? ([{ inlineData: content.inline }, instruction] as Array<string | Part>) : textPrompt,
      text: textPrompt,
    }),
  });
}

export async function extractBenchmarkProjects(c: BenchmarkCandidateInput, profile: BenchmarkDomainProfile): Promise<BenchmarkResult> {
  const started = Date.now();
  const fail = (error: string, retryable = false) => failedBenchmark(c, error, retryable, Date.now() - started);

  try {
    const content = await loadResumeContent({ resumeUrl: c.resumeUrl, resumeText: c.resumeText });
    if (typeof content === "string") return fail(content);
    const invalid = (error: string, model = ""): BenchmarkResult => ({ ...fail(error), status: "invalid", source: content.source, model });

    // No usable text layer (image, scanned PDF): find out what the file IS, and read its transcription.
    let read: ResumeContent = content;
    let ocrModel = "";
    if (!looksLikeResume(content.text)) {
      if (!content.inline) {
        return content.source === "pasted"
          ? invalid("The pasted text doesn't look like a resume (no skills / projects / experience / education).")
          : fail("Could not read any text from the resume — share it as a PDF.");
      }
      const doc = await transcribeDocument(content.inline, {
        chain: geminiOnly(chain()),
        label: `bench-ocr:${c.label || c.id}`,
        timeoutMs: TIER_TIMEOUT_MS,
      });
      if (!doc.ok) return fail(doc.error, true);
      if (doc.type !== "resume") {
        return invalid(`The resume link is ${DOC_LABEL[doc.type]}${doc.description ? ` — ${doc.description}` : ""}.`, doc.model);
      }
      if (!looksLikeResume(doc.text)) return invalid(`The uploaded resume can't be read (${doc.description || "too little text"}).`, doc.model);
      read = { source: content.source, text: doc.text };
      ocrModel = doc.model;
    }

    const base: BenchmarkResult = {
      id: c.id,
      status: "ok",
      projects: [],
      unverified: 0,
      error: "",
      retryable: false,
      source: content.source,
      model: ocrModel,
      durationMs: 0,
    };
    // Not one term of the domain anywhere → no project in it. No model call needed.
    if (!mentionsDomain(read.text, profile.keywords)) return { ...base, skipped: true, durationMs: Date.now() - started };

    const res = await readWithModel(c, read, profile);
    // Rate limits, overload, an unusable answer — transient; the browser retries.
    if (!res.ok) return fail(res.error, true);
    const json = res.json as Record<string, unknown>;
    const model = `${res.provider}/${res.model}${ocrModel ? ` · transcribed by ${ocrModel}` : ""}`;
    if (json.isResume === false && !(Array.isArray(json.projects) && json.projects.length)) {
      return invalid("The file is not a resume.", model);
    }

    const { projects, unverified } = verifiedProjects(json, read.text, profile);
    return { ...base, projects, unverified, model, durationMs: Date.now() - started };
  } catch (err) {
    console.error(`[bench] ${c.label || c.id} failed:`, err);
    return fail(err instanceof Error ? err.message.slice(0, 300) : "Screening failed.");
  }
}
