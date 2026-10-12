import "server-only";
import { SchemaType, type Part, type Schema } from "@google/generative-ai";
import { env } from "@/lib/env";
import { runLlmChain } from "@/lib/llm-router";
import { fetchResumeBytes } from "@/lib/resume";
import { pdfBufferToText } from "@/lib/pdf-text";
import { coveredMonths, resolveDuration } from "@/lib/experience-duration";
import {
  EXPERIENCE_TYPES,
  type ExperienceCandidateInput,
  type ExperienceEntry,
  type ExperienceResult,
  type ExperienceType,
} from "@/lib/experience-types";

/**
 * Experience Analysis — read one resume and list every internship / job in a
 * fixed shape: company, role, type, duration (normalised to months), tech stack
 * (only what the resume names for that role) and context (what they did).
 *
 * The model only READS: dates and durations come back exactly as written and
 * the months are computed deterministically (experience-duration.ts); each
 * technology is kept only if it literally appears in the resume text.
 * Gemini reads the PDF natively; when Gemini is rate-limited the chain moves
 * to Mistral free-tier models (on the extracted text).
 */

const DEFAULT_CHAIN =
  "gemini:gemini-3.8-flash,gemini:gemini-3.5-flash,gemini:gemini-2.5-flash,gemini:gemini-3.1-flash-lite," +
  "mistral:ministral-14b-latest,mistral:ministral-8b-latest,mistral:codestral-latest";
const TIER_TIMEOUT_MS = 60_000;
const MAX_TEXT = 30_000;

const SYSTEM = `You read ONE candidate's resume and list their INTERNSHIP and WORK EXPERIENCE — nothing else. A recruiter will filter these rows in a spreadsheet, so be exact and never invent.

INCLUDE: internships (paid or unpaid, on-site or remote), virtual internships and job simulations (type "Virtual Internship" — e.g. Forage, AICTE / Eduskills virtual internships), full-time jobs, part-time jobs, freelance / contract work, research internships or research assistant roles, apprenticeships.
EXCLUDE: academic, college or personal projects; hackathons and competitions; clubs, societies and positions of responsibility; volunteering; certifications, courses, trainings and bootcamps; education.

For each experience (in the order the resume lists them):
- "company": the organisation exactly as written. "" if none is written.
- "role": the job title exactly as written (e.g. "Frontend Developer Intern"). "" if none.
- "type": one of ${EXPERIENCE_TYPES.map((t) => `"${t}"`).join(", ")}.
- "durationText": the dates / duration EXACTLY as written for this entry (e.g. "Jan 2024 – Mar 2024", "3 months", "Summer 2023"). "" if nothing is written.
- "startDate" / "endDate": "YYYY-MM" (or "YYYY-MM-DD" when a day is written, or "YYYY" when only a year is written). endDate "Present" when the role is current. "" when not written. If only ONE date is written (e.g. "completed Dec 2024"), put it in endDate and leave startDate "". NEVER guess a date that is not in the resume.
- "ongoing": true only if the resume says it is current (Present / Current / Till date / Ongoing).
- "location": city or "Remote" as written, else "".
- "techStack": technologies, languages, frameworks, libraries, databases, cloud services and tools written INSIDE THIS ENTRY's description (not the separate skills section). Short canonical names ("React", "Node.js", "PostgreSQL", "AWS Lambda"). [] if the entry names none.
- "context": 1-2 factual sentences on what the candidate did or built there, taken from the entry (e.g. "Built REST APIs for order tracking and wrote unit tests."). If the entry has no description, "".
Also return "candidateName" as written at the top of the resume ("" if absent).
If the resume has no internship or work experience, return an empty "experiences" array.`;

const SHAPE = `Return ONLY a JSON object:
{"candidateName":string,"experiences":[{"company":string,"role":string,"type":string,"durationText":string,"startDate":string,"endDate":string,"ongoing":boolean,"location":string,"techStack":string[],"context":string}]}`;

const SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    candidateName: { type: SchemaType.STRING },
    experiences: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          company: { type: SchemaType.STRING },
          role: { type: SchemaType.STRING },
          type: { type: SchemaType.STRING, format: "enum", enum: [...EXPERIENCE_TYPES] },
          durationText: { type: SchemaType.STRING },
          startDate: { type: SchemaType.STRING },
          endDate: { type: SchemaType.STRING },
          ongoing: { type: SchemaType.BOOLEAN },
          location: { type: SchemaType.STRING },
          techStack: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          context: { type: SchemaType.STRING },
        },
        required: ["company", "role", "type", "durationText", "startDate", "endDate", "ongoing", "location", "techStack", "context"],
      },
    },
  },
  required: ["candidateName", "experiences"],
};

const str = (v: unknown, max = 400) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Loose form for "does the resume really mention this?" checks. */
const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#]+/g, "");

/** A technology counts only if the resume text names it (React ≈ React.js ≈ ReactJS). */
function mentioned(tech: string, looseText: string): boolean {
  const t = loose(tech);
  if (t.length < 1) return false;
  if (looseText.includes(t)) return true;
  const stripped = t.replace(/js$/, "");
  return stripped.length >= 2 && stripped !== t && looseText.includes(stripped);
}

/** A month written in any common form: "Jun", "June", "06/2024", "2024-06", "15.06.2024". */
const MONTH_IN_TEXT =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\b\d{1,2}\s*[/.-]\s*\d{2,4}\b|\b\d{4}\s*[/.-]\s*\d{1,2}\b/i;

function normalizeDate(v: unknown): string {
  const s = str(v, 20);
  if (/^present$/i.test(s)) return "Present";
  const m = s.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
  if (!m) return "";
  const parts = [m[1], m[2]?.padStart(2, "0"), m[3]?.padStart(2, "0")].filter(Boolean);
  return parts.join("-");
}

function normalizeEntries(raw: unknown, resumeText: string, asOf: Date): ExperienceEntry[] {
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const looseText = loose(resumeText);
  const out: ExperienceEntry[] = [];
  for (const r of list.slice(0, 20)) {
    const company = str(r.company, 160);
    const role = str(r.role, 160);
    if (!company && !role) continue;
    const type = (EXPERIENCE_TYPES as readonly string[]).includes(String(r.type)) ? (r.type as ExperienceType) : "Other";
    const durationText = str(r.durationText, 120);
    // Months must come from the resume: if the written duration names no month
    // ("3 months, Summer 2023"), a model-supplied month is a guess — keep the year only.
    const monthWritten = MONTH_IN_TEXT.test(durationText);
    const keepMonth = (d: string) => (d === "Present" || monthWritten ? d : d.slice(0, 4));
    const startDate = keepMonth(normalizeDate(r.startDate));
    const endDate = keepMonth(normalizeDate(r.endDate));
    const ongoing = r.ongoing === true || endDate === "Present";
    const techRaw = Array.isArray(r.techStack) ? r.techStack.map((t) => str(t, 60)).filter(Boolean) : [];
    // No resume text (scanned PDF) → can't verify, keep what the model read from the page.
    const techStack = Array.from(new Set(looseText ? techRaw.filter((t) => mentioned(t, looseText)) : techRaw)).slice(0, 25);
    const { months, label, source } = resolveDuration({ startDate, endDate, ongoing, durationText }, asOf);
    out.push({
      company,
      role,
      type,
      durationText,
      startDate,
      endDate: ongoing && !endDate ? "Present" : endDate,
      ongoing,
      months,
      durationLabel: label,
      durationSource: source,
      location: str(r.location, 80),
      techStack,
      techMentioned: techStack.length > 0,
      context: str(r.context, 400) || "No description of the work in the resume.",
    });
  }
  return out;
}

function blank(c: ExperienceCandidateInput): ExperienceResult {
  return {
    id: c.id,
    mobile: c.mobile,
    name: c.name,
    resumeUrl: c.resumeUrl,
    status: "error",
    error: "",
    entries: [],
    totalMonths: null,
    internshipMonths: null,
    model: "",
    durationMs: 0,
    analyzedAt: new Date().toISOString(),
  };
}

export async function analyzeExperience(c: ExperienceCandidateInput): Promise<ExperienceResult> {
  const started = Date.now();
  const base = blank(c);
  const fail = (error: string): ExperienceResult => ({ ...base, error, durationMs: Date.now() - started });
  try {
    if (!/^https?:\/\//i.test(c.resumeUrl.trim())) return fail("No resume link in the sheet.");
    const resume = await fetchResumeBytes(c.resumeUrl);
    if (!resume) return fail("Resume could not be downloaded — check that it is shared with the service account or public.");

    const mime = (resume.mimeType || "application/pdf").toLowerCase();
    const isPdf = mime.includes("pdf") || resume.data.subarray(0, 5).toString() === "%PDF-";
    const isImage = mime.startsWith("image/");
    const isText = mime.startsWith("text/");
    if (!isPdf && !isImage && !isText) return fail(`Unsupported resume file type (${mime}) — share it as a PDF.`);

    const text = isText ? resume.data.toString("utf8") : isPdf ? await pdfBufferToText(resume.data) : "";
    const hasText = text.trim().length > 40;
    // Without extracted text (scanned PDF / image) only Gemini can read the file.
    const chain = (env.experience.llmChain || DEFAULT_CHAIN)
      .split(",")
      .filter((t) => hasText || t.trim().startsWith("gemini:"))
      .join(",");
    const instruction = "List this candidate's internship and work experience.";

    const res = await runLlmChain({
      label: `experience:${c.mobile || c.id}`,
      chain,
      system: SYSTEM,
      schema: SCHEMA,
      shapeHint: SHAPE,
      temperature: 0,
      timeoutMs: TIER_TIMEOUT_MS,
      fast: true,
      maxOutputTokens: 8_192,
      accept: (j) => Array.isArray((j as { experiences?: unknown }).experiences),
      build: () => {
        const parts: Array<string | Part> = isText
          ? [`${instruction}\n\nResume text:\n${text.slice(0, MAX_TEXT)}`]
          : [{ inlineData: { mimeType: isPdf ? "application/pdf" : mime, data: resume.data.toString("base64") } }, instruction];
        return { geminiParts: parts, text: `${instruction}\n\nResume text:\n${text.slice(0, MAX_TEXT)}` };
      },
    });
    if (!res.ok) return fail(res.error);

    const json = res.json as { candidateName?: unknown; experiences?: unknown };
    const asOf = new Date();
    const entries = normalizeEntries(json.experiences, hasText ? text : "", asOf);
    const internships = entries.filter((e) => e.type === "Internship" || e.type === "Virtual Internship");
    return {
      ...base,
      name: c.name || str(json.candidateName, 120),
      status: entries.length ? "ok" : "no-experience",
      entries,
      totalMonths: coveredMonths(entries, asOf),
      internshipMonths: coveredMonths(internships, asOf),
      model: `${res.provider}/${res.model}`,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    console.error(`[experience] ${c.mobile || c.id} failed:`, err);
    return fail(err instanceof Error ? err.message.slice(0, 300) : "Analysis failed.");
  }
}
