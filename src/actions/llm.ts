"use server";

import { SchemaType, type Schema, type Part } from "@google/generative-ai";
import { geminiGenerateJson, geminiJsonForModel } from "@/lib/gemini-keys";
import { ChatPoolError, filePart, hasProviderKeys, pooledChatJson, strictJsonSchema, type ChatProvider } from "@/lib/key-pool";
import { escalate, type EscalationTier, type TierResult } from "@/lib/llm-escalation";
import { fetchResumeBytes, type ResumeBytes } from "@/lib/resume";
import { pdfBufferToText } from "@/lib/pdf-text";
import { env } from "@/lib/env";
import type {
  ActionResult,
  GithubProject,
  ReportCriteria,
  ResumeAnalysis,
  ResumeLink,
} from "@/lib/types";

const SYSTEM_PROMPT = `You prepare a candidate screening report that a hiring manager (POC) at the company reads. You are given a resume and the role's requirements. Return a strict JSON object.

1) "points" — the Top Highlights. Pick the candidate's strongest, most relevant achievements and write them as crisp one-liners from the POC's perspective (NOT a resume summary, NOT AI commentary).
   - Lead with a strong action + outcome, e.g. "Built a real-time chat app using React and Node.js" or "Optimized SQL queries cutting report load time by 40%".
   - Prefer items matching the mandatory skills, then optional skills, then the job description — but only if the resume supports them.
   - ONE short line each (≈8–16 words). Plain everyday English. Eye-catching but honest.
   - NEVER mention the job description, matching, AI, or this task. No "as required", "aligns with the JD", "the candidate". No first-person pronouns. No trailing period.
   - Output 4 highlights normally; up to 6 only if there are genuinely strong extra achievements. Never pad with weak points.

2) "skills" — the candidate's technical skills, ORDERED BY CORE STRENGTH so what makes them distinctive comes FIRST. Lead with their most specialized / standout skills (e.g. "OpenCV", "Machine Learning", "Kubernetes", "Rust"); put generic baseline skills every candidate lists (e.g. "HTML", "CSS") LAST, and drop truly filler ones. 6–8 max, deduped, short names ("React", "Python", "AWS"). Prefer skills matching the role when one is given, but ordering is by the candidate's genuine strength — the goal is that two candidates never look identical just because both start with "HTML, CSS". Omit soft skills.

3) "remarks" — an ARRAY of AT LEAST 4 key points (aim for 4–6) summarizing the resume for a NON-TECHNICAL HR reader. Each point:
   - is ONE short, simple sentence in beginner-friendly, everyday English (a non-technical person understands it instantly);
   - is GENERIC and impersonal — start with a fact or action word: "Solved …", "Built …", "Completed an internship at …", "Has strong exposure to …", "Achieved …", "Won …";
   - NEVER uses pronouns (they / he / she / his / her), the word "student", or hedging words ("likely", "probably", "seems", "appears", "maybe"). The word "candidate" is allowed only when a subject is unavoidable (e.g. "…where the candidate worked on X, Y, Z");
   - states a REAL fact from the resume: work/internship experience (company + what was worked on), projects, achievements, certifications, standout skills, or coding/problem-solving activity;
   - does NOT recommend, rate, or reject ("good hire", "we can use", "strong candidate for us"). Just factual highlights, strongest first.
   Tailor which points you pick to the role when it is given; otherwise pick the overall strongest. Never mention the job description, matching, AI, or this task; do not fabricate.

4) Links — extract ONLY what literally appears in the resume; never invent URLs:
   - "github": GitHub PROJECT repository links as objects { "name": project/repo name, "url": the github.com repo URL }.
   - "githubProfile": the candidate's GitHub profile URL (github.com/username) if present.
   - "leetcode": LeetCode profile URL if present.
   - "codeforces": Codeforces profile URL (codeforces.com/profile/<handle>) if present.
   - "portfolio": personal portfolio/website URL if present.
   - "otherLinks": other relevant professional links as { "label", "url" } (e.g. live demo, Kaggle, Behance). Exclude email and phone.
   Use empty string / empty array when something is absent.`;

const OUTPUT_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    points: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    skills: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    remarks: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    github: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: { name: { type: SchemaType.STRING }, url: { type: SchemaType.STRING } },
        required: ["name", "url"],
      },
    },
    githubProfile: { type: SchemaType.STRING },
    leetcode: { type: SchemaType.STRING },
    codeforces: { type: SchemaType.STRING },
    portfolio: { type: SchemaType.STRING },
    otherLinks: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: { label: { type: SchemaType.STRING }, url: { type: SchemaType.STRING } },
        required: ["label", "url"],
      },
    },
  },
  required: ["points"],
};

/** JSON shape spelled out for text providers (Groq/Mistral) that lack a schema. */
const SHAPE_HINT = `Return ONLY a JSON object with exactly this shape:
{"points": string[], "skills": string[], "remarks": string[], "github": [{"name": string, "url": string}], "githubProfile": string, "leetcode": string, "codeforces": string, "portfolio": string, "otherLinks": [{"label": string, "url": string}]}`;

function str(v: unknown): string {
  return String(v ?? "").trim();
}
function isHttp(v: string): boolean {
  return /^https?:\/\//i.test(v);
}

function normalizeAnalysis(raw: string): ResumeAnalysis {
  const p = JSON.parse(raw) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);

  const points = arr(p.points)
    .map((x) => str(x).replace(/\.$/, ""))
    .filter(Boolean)
    .slice(0, 6);

  const skills = arr(p.skills).map(str).filter(Boolean).slice(0, 16);

  const remarks = arr(p.remarks)
    .map(str)
    .map((s) => s.replace(/^[•\-*\s]+/, "").replace(/\.+$/, "").trim())
    .filter((s) => s.length > 0)
    .slice(0, 6);

  const github = arr(p.github)
    .map((g) => ({ name: str((g as GithubProject)?.name), url: str((g as GithubProject)?.url) }))
    .filter((g) => g.name && isHttp(g.url))
    .slice(0, 6);

  const otherLinks = arr(p.otherLinks)
    .map((l) => ({ label: str((l as ResumeLink)?.label), url: str((l as ResumeLink)?.url) }))
    .filter((l) => l.label && isHttp(l.url))
    .slice(0, 5);

  const clean = (v: unknown) => {
    const s = str(v);
    return isHttp(s) ? s : "";
  };

  return {
    points,
    skills,
    remarks,
    github,
    githubProfile: clean(p.githubProfile),
    leetcode: clean(p.leetcode),
    codeforces: clean(p.codeforces),
    portfolio: clean(p.portfolio),
    otherLinks,
  };
}

/**
 * One LLM job: its system prompt, response schema and the shape hint used by the
 * text-only fallback providers (which have no schema support). Lets the resume
 * analysis and the projects extraction share the whole provider/retry chain.
 */
interface LlmTask {
  system: string;
  schema: Schema;
  shapeHint: string;
  temperature: number;
}

const HIGHLIGHTS_TASK: LlmTask = {
  system: SYSTEM_PROMPT,
  schema: OUTPUT_SCHEMA,
  shapeHint: SHAPE_HINT,
  temperature: 0.4,
};

/**
 * Gemini analysis — reads the resume PDF natively (or text if it's text/*).
 *
 * Routes through the shared ROUND-ROBIN KEY POOL (`geminiGenerateJson`): every
 * candidate rotates to the next key, and a key that hits its daily quota (or is
 * dead) is parked for the rest of the run. So the daily throughput of the whole
 * analysis scales with the number of keys in GEMINI_API_KEYS — with a single
 * GEMINI_API_KEY it behaves exactly as before. The pool also fans across the
 * Gemini model chain per key. Throws when the pool is exhausted so the caller
 * fails over to Groq / Mistral.
 */
async function geminiAnalyze(resume: ResumeBytes, instruction: string, task: LlmTask): Promise<string> {
  const opts = { systemInstruction: task.system, schema: task.schema, temperature: task.temperature };
  const parts: string | Array<string | Part> = resume.mimeType.startsWith("text/")
    ? `${instruction}\n\nResume text:\n\n${resume.data.toString("utf8").slice(0, 20000)}`
    : [
        { inlineData: { mimeType: resume.mimeType || "application/pdf", data: resume.data.toString("base64") } },
        instruction,
      ];

  const text = await geminiGenerateJson(parts, opts);
  if (text === null) {
    // Every key/model in the pool failed — usually daily quota. Mention "quota"
    // so callers surface the right guidance and fail over to other providers.
    throw new Error("Gemini key pool exhausted (daily quota reached or no valid key)");
  }
  return text;
}

/**
 * Call an OpenAI-compatible provider (Groq / Mistral) for JSON output through
 * its round-robin key pool (GROQ_API_KEYS / MISTRAL_API_KEYS, see key-pool.ts).
 */
async function pooledProviderJson(
  provider: ChatProvider,
  modelName: string,
  resumeText: string,
  instruction: string,
  task: LlmTask,
): Promise<string> {
  const { text } = await pooledChatJson(provider, modelName, {
    system: `${task.system}\n\n${task.shapeHint}`,
    user: `${instruction}\n\nResume text:\n\n${resumeText.slice(0, 20000)}`,
    temperature: task.temperature,
    timeoutMs: 90_000,
  });
  return text;
}

const groqGenerate = (text: string, instruction: string, task: LlmTask) =>
  pooledProviderJson("groq", env.groq.model, text, instruction, task);

const mistralGenerate = (text: string, instruction: string, task: LlmTask) =>
  pooledProviderJson("mistral", env.mistral.model, text, instruction, task);

/** Build the role-context block from the screening criteria. */
function criteriaBlock(criteria?: ReportCriteria): string {
  if (!criteria) return "";
  const parts: string[] = [];
  if (criteria.mandatorySkills.trim()) parts.push(`Mandatory skills: ${criteria.mandatorySkills.trim()}`);
  if (criteria.optionalSkills.trim()) parts.push(`Optional skills: ${criteria.optionalSkills.trim()}`);
  if (criteria.jobDescription.trim()) parts.push(`Job description:\n${criteria.jobDescription.trim().slice(0, 6000)}`);
  return parts.length ? `Role requirements (for relevance only — never reference them in the output):\n${parts.join("\n")}\n\n` : "";
}

/**
 * Analyze a resume from its URL, tailored to the role's screening criteria.
 *
 * Tries providers in order — Gemini (reads the PDF natively) → Groq → Mistral —
 * falling through whenever a provider errors (e.g. daily quota) or returns no
 * highlights. Groq/Mistral run on the resume's extracted text. Returns the first
 * result that actually has highlights.
 */
export async function analyzeResumeFromUrl(
  resumeUrl: string,
  criteria?: ReportCriteria,
): Promise<ActionResult<ResumeAnalysis>> {
  const url = (resumeUrl ?? "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: "No resume link found for this candidate in the sheet." };
  }

  const resume = await fetchResumeBytes(url);
  if (!resume) {
    return {
      ok: false,
      error:
        "Couldn't download the resume from the sheet link. Ensure the file is " +
        "shared with the service account (or publicly viewable).",
    };
  }

  return analyzeResumeBytes(resume, criteria);
}

/**
 * Analyze already-fetched resume bytes. Split out of `analyzeResumeFromUrl` so
 * callers that also need the raw bytes (e.g. the Skill Set & Remarks flow, which
 * additionally scans PDF link annotations) can fetch the resume once and reuse
 * it for both passes.
 */
export async function analyzeResumeBytes(
  resume: ResumeBytes,
  criteria?: ReportCriteria,
): Promise<ActionResult<ResumeAnalysis>> {
  const instruction = `${criteriaBlock(criteria)}Write the top highlights for this resume.`;

  // Lazily extract resume text (only needed by the text-only fallback providers).
  let cachedText: string | null = null;
  const getText = async (): Promise<string> => {
    if (cachedText !== null) return cachedText;
    cachedText = resume.mimeType.startsWith("text/")
      ? resume.data.toString("utf8")
      : await pdfBufferToText(resume.data);
    return cachedText;
  };
  const fromText = (run: (t: string, i: string, task: LlmTask) => Promise<string>) => async () => {
    const t = await getText();
    if (!t || t.trim().length < 30) throw new Error("no extractable text in the resume PDF");
    return run(t, instruction, HIGHLIGHTS_TASK);
  };

  const providers: { name: string; enabled: boolean; run: () => Promise<string> }[] = [
    { name: "gemini", enabled: true, run: () => geminiAnalyze(resume, instruction, HIGHLIGHTS_TASK) },
    { name: "groq", enabled: hasProviderKeys("groq"), run: fromText(groqGenerate) },
    { name: "mistral", enabled: hasProviderKeys("mistral"), run: fromText(mistralGenerate) },
  ];

  const errors: string[] = [];
  for (const p of providers) {
    if (!p.enabled) continue;
    try {
      const data = normalizeAnalysis(await p.run());
      if (data.points.length > 0) {
        if (p.name !== "gemini") console.warn(`[llm] highlights via fallback provider: ${p.name}`);
        return { ok: true, data };
      }
      errors.push(`${p.name}: no highlights extracted`);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`[llm] ${p.name} failed: ${m.slice(0, 160)}`);
      errors.push(`${p.name}: ${m.slice(0, 120)}`);
    }
  }

  const onlyGemini = providers.filter((p) => p.enabled).length === 1;
  if (onlyGemini && errors.some((e) => /quota|PerDay|429/i.test(e))) {
    return {
      ok: false,
      error:
        "Gemini daily free-tier quota reached and no fallback provider is configured. " +
        "Add GROQ_API_KEY or MISTRAL_API_KEY, enable Gemini billing, or try again tomorrow.",
    };
  }
  return { ok: false, error: `Could not extract highlights from the resume. (${errors.join(" | ")})` };
}

// ── Projects consolidation ───────────────────────────────────────────────────

/**
 * Extracts the candidate's projects and scores them against a brief supplied by
 * the user (e.g. "GenAI projects using LLMs, RAG or agents"). Scoring is what
 * makes the consolidation possible: every project across every resume is ranked
 * on the same two axes, and only the best survive into the report.
 */
const PROJECTS_SYSTEM = `You extract PROJECTS from a candidate's resume and judge them against a brief.

Return JSON only. Rules — follow every one:

1) Extract ONLY projects that genuinely appear in the resume. Never invent a project, a metric, a technology or a link. If the resume has no project matching the brief, return an empty list.

2) "description" MUST be the project's wording AS WRITTEN IN THE RESUME — copy the resume's own bullet points/sentences for that project, joined into one short paragraph. Do not paraphrase, summarise, embellish, or add words the resume does not contain. Keep its numbers and metrics exactly.

3) "relevance" (0-100): how well the project matches the BRIEF. A project unrelated to the brief scores below 30.
   "quality" (0-100): how strong the project is on its own merits — real engineering depth, non-trivial scale, measurable outcomes, production/deployment, hard techniques. A toy/tutorial/CRUD clone scores below 40 however well it matches the brief.
   Be strict and calibrated: 90+ means genuinely exceptional. Do not cluster everything at 80.

4) "github" / "live": copy a URL for this project ONLY if the resume actually shows one. You are given a list of every URL found in the document — pick from that list only, choosing the one belonging to THIS project. "live" is a deployed/demo/hosted app URL (not a repo). If unsure, return "".

5) "tech": the technologies named for this project in the resume (max 8).

6) "title": the project's name as written in the resume.`;

const PROJECTS_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    projects: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          title: { type: SchemaType.STRING },
          description: { type: SchemaType.STRING },
          tech: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          github: { type: SchemaType.STRING },
          live: { type: SchemaType.STRING },
          relevance: { type: SchemaType.NUMBER },
          quality: { type: SchemaType.NUMBER },
        },
        required: ["title", "description", "relevance", "quality"],
      },
    },
  },
  required: ["projects"],
};

const PROJECTS_SHAPE_HINT = `Return ONLY a JSON object with exactly this shape:
{"projects":[{"title":string,"description":string,"tech":string[],"github":string,"live":string,"relevance":number,"quality":number}]}`;

const PROJECTS_TASK: LlmTask = {
  system: PROJECTS_SYSTEM,
  schema: PROJECTS_SCHEMA,
  shapeHint: PROJECTS_SHAPE_HINT,
  // Extraction must be faithful to the document, so keep it near-deterministic.
  temperature: 0.1,
};

/** One project pulled from a resume, scored against the brief. */
export interface ExtractedProject {
  title: string;
  description: string;
  tech: string[];
  github: string;
  live: string;
  relevance: number;
  quality: number;
}

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Keep a model-supplied link only when that exact URL was really found in the
 * document — the single strongest guard against hallucinated repo/demo links.
 */
function verifyUrl(candidate: string, known: Set<string>): string {
  const url = str(candidate).trim();
  if (!isHttp(url)) return "";
  return known.has(url.replace(/\/+$/, "").toLowerCase()) ? url : "";
}

function normalizeProjects(raw: string, knownUrls: string[]): ExtractedProject[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (parsed as { projects?: unknown })?.projects;
  if (!Array.isArray(list)) return [];

  const known = new Set(knownUrls.map((u) => u.replace(/\/+$/, "").toLowerCase()));

  return list
    .map((item): ExtractedProject => {
      const p = (item ?? {}) as Record<string, unknown>;
      return {
        title: str(p.title).trim(),
        description: str(p.description).replace(/\s+/g, " ").trim(),
        tech: (Array.isArray(p.tech) ? p.tech : []).map(str).map((t) => t.trim()).filter(Boolean).slice(0, 8),
        github: verifyUrl(str(p.github), known),
        live: verifyUrl(str(p.live), known),
        relevance: clampScore(p.relevance),
        quality: clampScore(p.quality),
      };
    })
    .filter((p) => p.title && p.description);
}

/**
 * Pull the projects out of one resume, scored against `brief`. `knownUrls` are
 * the URLs actually present in the document (annotations + text); the model may
 * only attach links drawn from that list.
 */
export async function extractProjectsFromResume(
  resume: ResumeBytes,
  brief: string,
  knownUrls: string[],
): Promise<ActionResult<ExtractedProject[]>> {
  const urlBlock = knownUrls.length
    ? `URLs found in this document (attach links ONLY from this list):\n${knownUrls.join("\n")}\n\n`
    : "No URLs were found in this document — return an empty string for github and live.\n\n";

  const instruction =
    `${urlBlock}Brief describing the projects wanted:\n${brief.trim().slice(0, 2000)}\n\n` +
    `Extract this resume's projects and score each one against the brief.`;

  let cachedText: string | null = null;
  const getText = async (): Promise<string> => {
    if (cachedText !== null) return cachedText;
    cachedText = resume.mimeType.startsWith("text/")
      ? resume.data.toString("utf8")
      : await pdfBufferToText(resume.data);
    return cachedText;
  };
  const fromText = (run: (t: string, i: string, task: LlmTask) => Promise<string>) => async () => {
    const t = await getText();
    if (!t || t.trim().length < 30) throw new Error("no extractable text in the resume PDF");
    return run(t, instruction, PROJECTS_TASK);
  };

  const providers: { name: string; enabled: boolean; run: () => Promise<string> }[] = [
    { name: "gemini", enabled: true, run: () => geminiAnalyze(resume, instruction, PROJECTS_TASK) },
    { name: "groq", enabled: hasProviderKeys("groq"), run: fromText(groqGenerate) },
    { name: "mistral", enabled: hasProviderKeys("mistral"), run: fromText(mistralGenerate) },
  ];

  const errors: string[] = [];
  for (const p of providers) {
    if (!p.enabled) continue;
    try {
      // An empty list is a VALID answer here (the resume may hold nothing that
      // matches the brief), so unlike the highlights pass we do not fall through
      // to the next provider on an empty result.
      return { ok: true, data: normalizeProjects(await p.run(), knownUrls) };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`[llm:projects] ${p.name} failed: ${m.slice(0, 160)}`);
      errors.push(`${p.name}: ${m.slice(0, 120)}`);
    }
  }
  return { ok: false, error: `Could not read projects from the resume. (${errors.join(" | ")})` };
}

// ── Domain shortlisting ──────────────────────────────────────────────────────

/**
 * Scores a candidate's fit for a target domain from their resume — projects,
 * internship/work experience, and github/portfolio work — plus optional
 * coding-platform activity. Used to shortlist the strongest people for a domain.
 */
const DOMAIN_SYSTEM = `You assess whether a candidate FITS a target domain, using only their resume.

Judge fit ONLY on real evidence in the resume: domain-relevant PROJECTS, INTERNSHIP / WORK experience, and GitHub / portfolio work that is described. Consider the FULL breadth of the domain — its technologies, topics, sub-topics and tools. Coding-platform activity (LeetCode / Codeforces), when provided, is a SECONDARY strength signal only, never a substitute for domain evidence.

Return JSON only:
1) "domainScore" (0-100): how strongly this candidate fits the domain.
   - 80-100: strong, repeated domain evidence — e.g. substantial domain projects AND relevant experience/internship.
   - 55-79: clear but lighter evidence — one solid domain project or some relevant exposure.
   - 1-54: tangential, tutorial-grade, or only keyword mentions.
   - 0: no domain evidence at all.
   Be strict and calibrated. Do NOT cluster scores; most candidates are not a strong fit.
2) "coreSkills": the domain-specific skills the candidate is GENUINELY STRONG in — each MUST be backed by a real project, experience, or github work in the resume. Short names (e.g. "RAG", "LangChain", "Fine-tuning", "Vector DBs", "Prompt Engineering"). 4-8 max, strongest first. NEVER list a skill the resume does not substantiate. If the candidate does not fit the domain, return an empty array.
3) "evidence": ONE short, factual line naming the strongest domain proof (e.g. "Built a production RAG assistant and interned on an LLM team"). No hype, no pronouns, no "the candidate". Empty string when there is no fit.
4) "meetsMandatory" (boolean): when MANDATORY REQUIREMENTS are given, set true ONLY if the resume shows genuine, evidence-backed proof of EVERY one (a real project/experience for each — not a mere mention in a skills list). If any single mandatory item is missing or only name-dropped, set false. When no mandatory requirements are given, set true.
5) "hasDomainExperience" (boolean) + "experience" (string): does the resume show INTERNSHIP or WORK experience that is genuinely RELEVANT to this domain (and to the mandatory requirements)? Set hasDomainExperience true ONLY for a real internship or job where domain-relevant work was actually done — NOT a personal project, a course, or an unrelated job. Give "experience" as ONE short factual line naming the most relevant one (company + what was done), e.g. "Backend intern at Acme — built Node/Express REST APIs". Empty string and false when there is no relevant internship/work experience.

6) "presentationScore" (0-100) + "presentationNotes" (string): ONLY when a RESUME PRESENTATION CHECK is requested in the instruction. Judge the DOCUMENT ITSELF — how well structured, aligned, organised and visually presentable it is against industry-standard resume conventions — SEPARATELY from the candidate's skills. A weak candidate can have a beautiful resume and a strong one a messy resume; never let domainScore leak into this number. Return 0 and an empty string when no presentation check was requested.

Never invent projects, skills, companies, tools or numbers.`;

/**
 * Presentation rubric — appended to the instruction only when the run asks for
 * the resume-structure check, so ordinary runs pay no prompt cost for it.
 */
const PRESENTATION_RUBRIC = `RESUME PRESENTATION CHECK REQUESTED — also grade the document's structure and visual quality in "presentationScore" (0-100) with a short "presentationNotes" line.

Score these aspects, all of them about the DOCUMENT, not the candidate:
- STRUCTURE: the standard sections are present and in a sensible order (contact/header, then education, skills, experience, projects, achievements). Nothing important missing (no name, no email/phone, no skills section = heavy penalty).
- ORGANISATION: related content grouped under clear headings; no repetition; no skill dumped in three different places; reverse-chronological ordering within sections.
- ALIGNMENT & CONSISTENCY: margins and columns line up; dates/locations aligned in a consistent position; ONE consistent bullet style, date format, heading style, capitalisation and font treatment throughout. Misaligned or ragged blocks, mixed fonts/sizes, and inconsistent date formats are the most common failures — penalise them.
- READABILITY & DENSITY: crisp bullet points (not walls of paragraph text), sensible white space, no cramped or overflowing page, no orphaned section heading at a page break, length appropriate (1 page for a fresher, 2 max).
- VISUAL APPEAL: looks polished and eye-catching at a glance — deliberate typography, tasteful use of a single accent colour or clean rules/dividers, scannable hierarchy where the most important thing stands out first. Reward a design a hiring manager would call clean and professional; do NOT reward decoration that hurts clarity (clip-art, photos, rainbow colours, dense tables, heavy graphics, skill "rating" bars with no meaning).
- PROFESSIONAL POLISH: no typos or grammar errors in headings, action-verb-led bullets, quantified outcomes, no first-person pronouns, no placeholder/lorem text, links labelled properly.
- ATS-SAFETY: single-column, machine-readable layout with real text; multi-column/graphic-heavy layouts that break parsing lose points.

Calibration — be strict and do NOT cluster:
- 85-100: recruiter-ready. Clean, consistent, well-aligned, genuinely good looking; would be shown to a client as-is.
- 70-84: solid and professional with minor nits (a spacing/consistency slip or two).
- 50-69: readable but visibly rough — inconsistent formatting, cluttered or poorly ordered sections.
- 1-49: messy, misaligned, hard to scan, missing standard sections, or clearly unprofessional.

"presentationNotes": ONE short factual line (≤ 14 words) naming what drives the score, e.g. "Clean single-column layout, consistent bullets and aligned dates" or "Cluttered two-column layout, mixed fonts, skills scattered across sections". No pronouns, no hype, no advice.`;

/** Text-only providers can't see the layout — say so and keep them conservative. */
const PRESENTATION_TEXT_NOTE = `You are given the resume's EXTRACTED TEXT, not the rendered page, so judge presentation from what the text reveals: section presence and order, heading clarity, bullet vs paragraph style, consistency of date formats and capitalisation, repetition, length, typos, and whether the reading order looks jumbled (a sign of a broken multi-column layout). Do not guess about colour, fonts or margins; when the text gives no signal either way, stay near 70 rather than inventing a high or low score.`;

const DOMAIN_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    domainScore: { type: SchemaType.NUMBER },
    coreSkills: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    evidence: { type: SchemaType.STRING },
    meetsMandatory: { type: SchemaType.BOOLEAN },
    hasDomainExperience: { type: SchemaType.BOOLEAN },
    experience: { type: SchemaType.STRING },
    presentationScore: { type: SchemaType.NUMBER },
    presentationNotes: { type: SchemaType.STRING },
  },
  required: ["domainScore"],
};

const DOMAIN_SHAPE_HINT = `Return ONLY a JSON object with exactly this shape:
{"domainScore":number,"coreSkills":string[],"evidence":string,"meetsMandatory":boolean,"hasDomainExperience":boolean,"experience":string,"presentationScore":number,"presentationNotes":string}`;

const DOMAIN_TASK: LlmTask = {
  system: DOMAIN_SYSTEM,
  schema: DOMAIN_SCHEMA,
  shapeHint: DOMAIN_SHAPE_HINT,
  temperature: 0.15,
};

/** One candidate's domain-fit judgement. */
export interface DomainFit {
  domainScore: number;
  coreSkills: string[];
  evidence: string;
  /** Whether ALL mandatory requirements are met (true when none were given). */
  meetsMandatory: boolean;
  /** Whether the resume shows domain-relevant internship/work experience. */
  hasDomainExperience: boolean;
  /** One-line summary of the most relevant internship/experience ("" = none). */
  experience: string;
  /** 0-100 structure / alignment / visual quality of the resume (0 = not checked). */
  presentationScore: number;
  /** One line naming what drives the presentation score ("" = not checked). */
  presentationNotes: string;
  /** The model that gave this judgement, e.g. "gemini/gemini-3.6-flash". */
  scoredBy: string;
}

/** Clamp any LLM-returned score to a 0-100 integer (0 when unusable). */
function clamp100(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

/** Parse a model's JSON answer, tolerating a ```json fence or prose around the object. */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = (raw ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  for (const candidate of [text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    try {
      const v = JSON.parse(candidate) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* try the next form */
    }
  }
  return null;
}

/**
 * The model's domain-fit answer, or null when it is unusable — unreadable JSON, no
 * numeric domainScore, or a passing score with no skill and no evidence behind it.
 * An unusable answer must never pass as "score 0, no fit": the caller tries the next
 * provider and, failing that, reports a retryable error.
 */
function normalizeDomainFit(raw: string): Omit<DomainFit, "scoredBy"> | null {
  const p = parseJsonObject(raw);
  if (!p) return null;
  const rawScore = typeof p.domainScore === "number" ? p.domainScore : Number(p.domainScore);
  if (p.domainScore === undefined || p.domainScore === null || p.domainScore === "" || !Number.isFinite(rawScore)) return null;
  const domainScore = clamp100(p.domainScore);
  const coreSkills = (Array.isArray(p.coreSkills) ? p.coreSkills : [])
    .map(str)
    .map((s) => s.replace(/^[•\-*\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 8);
  // Default true so a run WITHOUT mandatory requirements never spuriously gates;
  // the model only returns false when it was asked to check and one is missing.
  const meetsMandatory = p.meetsMandatory === undefined ? true : Boolean(p.meetsMandatory);
  const evidence = str(p.evidence).replace(/\s+/g, " ").trim();
  // A real fit always names what proves it; a 55+ score with nothing behind it is a broken answer.
  if (domainScore >= 55 && !coreSkills.length && !evidence) return null;
  return {
    domainScore,
    coreSkills,
    evidence,
    meetsMandatory,
    hasDomainExperience: Boolean(p.hasDomainExperience),
    experience: str(p.experience).replace(/\s+/g, " ").trim(),
    presentationScore: clamp100(p.presentationScore),
    presentationNotes: str(p.presentationNotes).replace(/\s+/g, " ").trim(),
  };
}

/**
 * Judge one resume's fit for `domain`. `dsaContext` is an optional short line of
 * coding-platform activity ("LeetCode 800, Codeforces 300") folded in as a
 * secondary signal. A low score with no skills is a VALID answer (no fit), so —
 * unlike the highlights pass — an empty result does not fall through providers.
 */
export async function analyzeCandidateForDomain(
  resume: ResumeBytes,
  domain: string,
  dsaContext: string,
  /** Strict must-haves; the model sets meetsMandatory=false if any is missing. */
  mandatory = "",
  /** When true, emphasise that domain internship/work experience is required. */
  requireExperience = false,
  /** When true, also grade the resume's structure / alignment / visual quality. */
  checkPresentation = false,
): Promise<ActionResult<DomainFit>> {
  const base =
    `Domain to shortlist for:\n${domain.trim().slice(0, 1500)}\n\n` +
    (mandatory.trim()
      ? `MANDATORY REQUIREMENTS (candidate must genuinely satisfy EVERY one, with real evidence): ${mandatory.trim().slice(0, 600)}\n\n`
      : "") +
    (requireExperience
      ? `EXPERIENCE IS REQUIRED: set hasDomainExperience true ONLY if there is a genuine internship or job with domain-relevant work (not a project or course).\n\n`
      : "") +
    (dsaContext.trim() ? `Coding-platform activity (secondary signal): ${dsaContext.trim()}\n\n` : "") +
    `Assess this resume's fit for the domain, its core skills, the strongest evidence, whether every mandatory requirement is met, and any domain-relevant internship/work experience.`;

  // The presentation rubric is layout-aware, so it only fully applies when the
  // model actually SEES the page (Gemini or OpenAI reading the PDF itself). Text-only
  // providers — and text/* resumes — get the degraded, text-signal variant.
  const withRubric = (visual: boolean) =>
    checkPresentation
      ? `${base}\n\n${PRESENTATION_RUBRIC}${visual ? "" : `\n\n${PRESENTATION_TEXT_NOTE}`}`
      : base;
  const isTextResume = resume.mimeType.startsWith("text/");
  const visualInstruction = withRubric(!isTextResume);
  const textInstruction = withRubric(false);

  let cachedText: string | null = null;
  const getText = async (): Promise<string> => {
    if (cachedText !== null) return cachedText;
    cachedText = isTextResume ? resume.data.toString("utf8") : await pdfBufferToText(resume.data);
    return cachedText;
  };
  const textPrompt = async (): Promise<string> => {
    const t = await getText();
    if (!t || t.trim().length < 30) throw new Error("no extractable text in the resume PDF");
    return `${textInstruction}\n\nResume text:\n\n${t.slice(0, 20000)}`;
  };
  // A model's raw answer → a judgement, or "unusable" (never a silent score of 0).
  const judge = (raw: string): TierResult<Omit<DomainFit, "scoredBy">> => {
    const fit = normalizeDomainFit(raw);
    return fit
      ? { ok: true, value: fit }
      : { ok: false, kind: "unusable", detail: "unreadable JSON, no domainScore, or a score with no evidence" };
  };

  const tiers: EscalationTier<Omit<DomainFit, "scoredBy">>[] = [];
  for (const { provider, model } of domainChain()) {
    if (provider === "gemini") {
      tiers.push({
        provider,
        model,
        label: `gemini/${model}`,
        run: async () => {
          const parts: string | Array<string | Part> = isTextResume
            ? `${visualInstruction}\n\nResume text:\n\n${resume.data.toString("utf8").slice(0, 20000)}`
            : [{ inlineData: { mimeType: resume.mimeType || "application/pdf", data: resume.data.toString("base64") } }, visualInstruction];
          const res = await geminiJsonForModel(parts, model, {
            systemInstruction: DOMAIN_TASK.system,
            schema: DOMAIN_TASK.schema,
            temperature: DOMAIN_TASK.temperature,
            timeoutMs: DOMAIN_GEMINI_TIMEOUT_MS,
          });
          return res.ok ? judge(res.text) : { ok: false, kind: res.kind, detail: res.detail };
        },
      });
    } else if (provider === "openai") {
      // The PDF itself first (same view Gemini gets), then its text — a file OpenAI
      // can't read must not cost the candidate an OpenAI judgement.
      if (!isTextResume) {
        tiers.push({ provider, model, label: `openai/${model} (pdf)`, run: () => openaiDomainJudge(model, visualInstruction, resume, judge) });
      }
      tiers.push({ provider, model, label: `openai/${model}`, run: async () => openaiDomainJudge(model, await textPrompt(), null, judge) });
    } else {
      tiers.push({
        provider,
        model,
        label: `${provider}/${model}`,
        run: async () => {
          const user = await textPrompt();
          try {
            const { text } = await pooledChatJson(provider, model, {
              system: `${DOMAIN_TASK.system}\n\n${DOMAIN_TASK.shapeHint}`,
              user,
              temperature: DOMAIN_TASK.temperature,
              timeoutMs: 90_000,
            });
            return judge(text);
          } catch (err) {
            return poolFailure(err);
          }
        },
      });
    }
  }

  const res = await escalate(tiers, DOMAIN_LEAVE_ON, (line) => console.warn(`[llm:domain] ${line}`));
  if (res.ok) {
    if (res.provider !== "gemini") console.warn(`[llm:domain] judged by fallback ${res.label}`);
    return { ok: true, data: { ...res.value, scoredBy: `${res.provider}/${res.model}` } };
  }
  return { ok: false, error: `${DOMAIN_RETRY_PREFIX} (${res.error})` };
}

/** Start of the error when every model failed (quota, overload, unusable answers) — a retry can succeed. */
const DOMAIN_RETRY_PREFIX = "Could not assess the resume for the domain";

/**
 * Domain judgement chain — quality first, never a "lite" model:
 *  1. Gemini: GEMINI_MODEL first (the model past runs were judged by), then the 3.x Flash
 *     models — each has its own quota on every key, so they add capacity. A model that is
 *     rate-limited, out of quota or overloaded is skipped at once, no sleeping;
 *  2. OpenAI (OPENAI_MODEL, default gpt-5.4-mini then gpt-5.5, reasoning off — see env.ts)
 *     when Gemini can't answer; it reads the PDF too;
 *  3. Mistral's strongest free-tier model, ONLY when OpenAI is rate-limited / out of quota.
 * Models checked against these keys on 2026-10-14 (2.5-flash answers only on keys created
 * before its retirement). Override with DOMAIN_LLM_CHAIN="provider:model,…".
 */
function domainChain(): { provider: "gemini" | ChatProvider; model: string }[] {
  const gemini = Array.from(
    new Set([
      ...env.gemini.model.split(",").map((m) => m.trim()).filter((m) => m && !/lite/i.test(m)),
      "gemini-3.6-flash",
      "gemini-3.8-flash",
      "gemini-3.5-flash",
      "gemini-3-flash-preview",
    ]),
  );
  const spec =
    env.domain.llmChain.trim() ||
    [...gemini.map((m) => `gemini:${m}`), ...env.openai.models.map((m) => `openai:${m}`), "mistral:ministral-14b-latest"].join(",");
  const out: { provider: "gemini" | ChatProvider; model: string }[] = [];
  for (const entry of spec.split(",")) {
    const [p, ...rest] = entry.trim().split(":");
    const provider = p?.trim().toLowerCase();
    const model = rest.join(":").trim();
    if (!model) continue;
    if (provider === "gemini" && env.gemini.apiKeys.length) out.push({ provider, model });
    else if ((provider === "openai" || provider === "mistral" || provider === "groq") && hasProviderKeys(provider)) out.push({ provider, model });
  }
  return out;
}

/** Leave Gemini on any failure (OpenAI is as capable); leave OpenAI only when it is throttled. */
const DOMAIN_LEAVE_ON: Record<string, "any" | "throttle"> = { gemini: "any", openai: "throttle", mistral: "throttle", groq: "throttle" };

/** One Gemini request is cut off after this; the model is then skipped briefly on every key. */
const DOMAIN_GEMINI_TIMEOUT_MS = 75_000;

/** A key-pool failure → escalation kind: capacity problems are "rate", the rest "error". */
function poolFailure(err: unknown): TierResult<never> {
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof ChatPoolError) {
    if (err.kind === "model") return { ok: false, kind: "unavailable", detail };
    if (err.kind === "exhausted" && err.throttled) return { ok: false, kind: "rate", detail };
  }
  return { ok: false, kind: "error", detail };
}

/** One OpenAI judgement — the PDF itself when `pdf` is given, else `prompt` holds the text. */
async function openaiDomainJudge(
  model: string,
  prompt: string,
  pdf: ResumeBytes | null,
  judge: (raw: string) => TierResult<Omit<DomainFit, "scoredBy">>,
): Promise<TierResult<Omit<DomainFit, "scoredBy">>> {
  try {
    const { text } = await pooledChatJson("openai", model, {
      system: DOMAIN_TASK.system,
      user: prompt,
      userParts: pdf
        ? [filePart({ mimeType: pdf.mimeType || "application/pdf", data: pdf.data.toString("base64") }), { type: "text", text: prompt }]
        : undefined,
      jsonSchema: { name: "domain_fit", schema: strictJsonSchema(DOMAIN_TASK.schema) },
      reasoningEffort: env.openai.reasoningEffort,
      temperature: DOMAIN_TASK.temperature,
      timeoutMs: 120_000,
      // Every key rate-limited for a moment (a per-minute burst) → wait up to 5 s and try
      // OpenAI again; a longer limit goes straight to Mistral.
      maxWaitMs: 5_000,
    });
    return judge(text);
  } catch (err) {
    return poolFailure(err);
  }
}
