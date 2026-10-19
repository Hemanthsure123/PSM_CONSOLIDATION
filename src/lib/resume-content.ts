import "server-only";
import { SchemaType, type Part, type Schema } from "@google/generative-ai";
import { runLlmChain } from "@/lib/llm-router";
import { fetchResume, type ResumeBytes } from "@/lib/resume";
import { pdfBufferToLines } from "@/lib/pdf-text";
import { docxToText, isZip } from "@/lib/docx-text";
import { linkOnly } from "@/lib/resume-input";

/**
 * Getting a resume's TEXT for screening, shared by QA Resume Screening and
 * Benchmark Projects:
 *  - pasted text is used as is;
 *  - a link is downloaded and read by type (PDF text layer, .docx, HTML / text);
 *  - a file with no usable text (image, scanned PDF) is first IDENTIFIED and only
 *    transcribed when it really is a resume. Uploads are often photos, ID cards or
 *    certificates, and a model asked to "screen this resume" about a photo invents
 *    one — so nothing is screened from an image directly.
 */

export type ResumeSource = "pdf" | "docx" | "text" | "image" | "pasted";

export interface ResumeContent {
  source: ResumeSource;
  /** Extracted text ("" when the file has no usable text layer). */
  text: string;
  /** Inline file for Gemini (PDF / image). */
  inline?: { mimeType: string; data: string };
}

/** Real resume text (not a garbled font encoding) names at least two of these. */
const RESUME_WORDS = /\b(education|skills?|projects?|experience|universit(y|ies)|college|intern(ship)?|b\.?\s?tech|degree|email|linkedin|github|objective|summary|certifications?)\b/gi;

export function looksLikeResume(text: string): boolean {
  if (text.trim().length < 200) return false;
  const hits = new Set((text.match(RESUME_WORDS) ?? []).map((w) => w.toLowerCase().replace(/[^a-z]/g, "")));
  return hits.size >= 2;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h\d|tr|br)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * The resume's content, or a readable reason it can't be read.
 *
 * A link is read first and pasted text is the fallback when the link can't be.
 * "Pasted text" that is really just a link (a long S3 / Drive URL pasted in the
 * resume column) is downloaded like any link — never screened as text.
 */
export async function loadResumeContent(input: { resumeUrl: string; resumeText?: string }): Promise<ResumeContent | string> {
  const pasted = (input.resumeText ?? "").trim();
  const pastedLink = linkOnly(pasted);
  const text = pastedLink ? "" : pasted;
  const url = /^https?:\/\//i.test(input.resumeUrl.trim()) ? input.resumeUrl.trim() : pastedLink;

  if (url) {
    const fromLink = await loadFromLink(url);
    if (typeof fromLink !== "string" || text.length < 100) return fromLink;
  }
  if (text.length >= 100) return { source: "pasted", text };
  return "No resume link or resume text for this candidate.";
}

/** What a file really is, from its first bytes — servers often label uploads "binary/octet-stream". */
function sniff(data: Buffer): "pdf" | "zip" | "ole" | { image: string } | null {
  if (data.subarray(0, 1024).toString("latin1").includes("%PDF-")) return "pdf";
  if (isZip(data)) return "zip";
  if (data.length > 8 && data.readUInt32BE(0) === 0xd0cf11e0) return "ole"; // legacy .doc
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { image: "image/jpeg" };
  if (data.length > 8 && data.readUInt32BE(0) === 0x89504e47) return { image: "image/png" };
  if (data.subarray(0, 4).toString("latin1") === "GIF8") return { image: "image/gif" };
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return { image: "image/webp" };
  if (/^ftyp(heic|heix|hevc|mif1|msf1)$/.test(data.subarray(4, 12).toString("latin1"))) return { image: "image/heic" };
  return null;
}

/** Prefix of the error for a download that failed for a passing reason (network, rate limit, 5xx) — worth a retry. */
export const RESUME_DOWNLOAD_RETRY = "Resume download failed temporarily";

async function loadFromLink(url: string): Promise<ResumeContent | string> {
  const fetched = await fetchResume(url);
  if (!fetched.ok) {
    return fetched.transient
      ? `${RESUME_DOWNLOAD_RETRY} (${fetched.error.slice(0, 80)}) — re-run this candidate.`
      : "Resume could not be downloaded — check that it is shared with the service account or public.";
  }
  return contentFromBytes(fetched.bytes);
}

/**
 * Read already-downloaded resume bytes by what the file really is (PDF text layer,
 * .docx, image, HTML / text) — for callers that also need the raw bytes (e.g. to read
 * the PDF's hidden links) and must not download the file twice.
 */
export async function contentFromBytes(resume: ResumeBytes): Promise<ResumeContent | string> {
  const mime = (resume.mimeType || "").toLowerCase();
  const kind = sniff(resume.data);

  if (kind === "pdf" || (!kind && mime.includes("pdf"))) {
    return {
      source: "pdf",
      text: await pdfBufferToLines(resume.data),
      inline: { mimeType: "application/pdf", data: resume.data.toString("base64") },
    };
  }
  if (kind === "zip" || mime.includes("wordprocessingml")) {
    const text = docxToText(resume.data);
    return text ? { source: "docx", text } : "The Word (.docx) resume has no readable text — share it as a PDF.";
  }
  if (kind === "ole" || mime.includes("msword")) return "Old Word (.doc) resumes can't be read — share it as a PDF.";
  const image = kind && typeof kind === "object" ? kind.image : mime.startsWith("image/") ? mime : "";
  if (image) return { source: "image", text: "", inline: { mimeType: image, data: resume.data.toString("base64") } };
  if (mime.startsWith("text/")) {
    const raw = resume.data.toString("utf8");
    return { source: "text", text: mime.includes("html") ? htmlToText(raw) : raw };
  }
  return `Unsupported resume file type (${mime || "unknown"}) — share it as a PDF.`;
}

// ── Files without a text layer (images, scanned PDFs) ───────────────────────

export const DOC_TYPES = ["resume", "photo", "id-card", "certificate", "marksheet", "screenshot", "other-document", "blank-or-unreadable"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_LABEL: Record<Exclude<DocType, "resume">, string> = {
  photo: "a photograph, not a resume",
  "id-card": "an ID card, not a resume",
  certificate: "a certificate, not a resume",
  marksheet: "a mark sheet, not a resume",
  screenshot: "a screenshot, not a resume",
  "other-document": "a document that is not a resume",
  "blank-or-unreadable": "blank or unreadable",
};

const DOC_SYSTEM = `You look at ONE file that a candidate uploaded in the "resume" field of a job application. Uploads are often wrong — profile photos, selfies, ID cards, certificates, mark sheets, screenshots, blank pages — so first look at what the file really is.
- "description": one plain sentence saying what is actually visible (e.g. "A photograph of a young man in a suit standing against a wall", "A one-page resume with Skills, Projects and Education sections").
- "documentType": "resume" ONLY if the file is a resume / CV — a document whose text lists the person's education, skills, projects or work experience. Otherwise the closest of ${DOC_TYPES.filter((t) => t !== "resume")
  .map((t) => `"${t}"`)
  .join(", ")}.
- "text": when documentType is "resume", transcribe ALL the visible text exactly as written — top to bottom, column by column, one line per line, section headings on their own lines. Never add, correct, summarise or invent anything. Otherwise "".`;

const DOC_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    description: { type: SchemaType.STRING },
    documentType: { type: SchemaType.STRING, format: "enum", enum: [...DOC_TYPES] },
    text: { type: SchemaType.STRING },
  },
  required: ["description", "documentType", "text"],
};

export type Transcript = { ok: true; type: DocType; description: string; text: string; model: string } | { ok: false; error: string };

/** Trimmed text; also undoes a literal "—" a model sometimes leaves in its JSON strings. */
const str = (v: unknown, max = 400) =>
  typeof v === "string"
    ? v
        .replace(/\\u([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

const DOC_ASK = "What is this file? If it is a resume, transcribe it.";

/**
 * What is this file — and, if it is a resume, its text. Only models that can see
 * the file may do this: `chain` should list Gemini (and optionally OpenAI) tiers
 * only — see `geminiOnly` / `visionTiers`.
 */
export async function transcribeDocument(
  inline: { mimeType: string; data: string },
  opts: { chain: string; label: string; timeoutMs: number },
): Promise<Transcript> {
  if (!opts.chain) return { ok: false, error: "Image / scanned resumes need a Gemini or OpenAI model in the LLM chain." };
  const res = await runLlmChain({
    label: opts.label,
    chain: opts.chain,
    system: DOC_SYSTEM,
    schema: DOC_SCHEMA,
    shapeHint: "",
    temperature: 0,
    timeoutMs: opts.timeoutMs,
    fast: true,
    maxOutputTokens: 16_384,
    thinking: "low",
    accept: (j) => DOC_TYPES.includes((j as { documentType?: string }).documentType as DocType),
    build: () => ({
      geminiParts: [{ inlineData: inline }, DOC_ASK] as Array<string | Part>,
      // OpenAI tiers read the same file; text-only tiers never reach here (see vision chains).
      text: DOC_ASK,
      inline,
    }),
  });
  if (!res.ok) return res;
  const j = res.json as { documentType: DocType; description?: unknown; text?: unknown };
  return {
    ok: true,
    type: j.documentType,
    description: str(j.description, 200).replace(/[.\s]+$/, ""),
    text: typeof j.text === "string" ? j.text.trim() : "",
    model: `${res.provider}/${res.model}`,
  };
}

/** The Gemini tiers of a "provider:model,…" chain — the ones that can read an image. */
export function geminiOnly(chain: string): string {
  return chain
    .split(",")
    .filter((t) => t.trim().startsWith("gemini:"))
    .join(",");
}

/** The Gemini and OpenAI tiers of a chain — every tier that reads the file itself. */
export function visionTiers(chain: string): string {
  return chain
    .split(",")
    .filter((t) => /^(gemini|openai):/.test(t.trim()))
    .join(",");
}
