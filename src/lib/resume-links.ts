import "server-only";
import { SchemaType, type Schema } from "@google/generative-ai";
import { pdfBufferToText } from "@/lib/pdf-text";
import { parseLeetCodeUser, parseCodeforcesHandle, parseCodeChefHandle } from "@/lib/coding-stats";
import { runLlmChain } from "@/lib/llm-router";
import { env } from "@/lib/env";
import type { ResumeBytes } from "@/lib/resume";

/**
 * Extract a candidate's LeetCode, Codeforces + CodeChef profile links from their resume —
 * INCLUDING links hidden behind an icon or text (very common in resumes). Three
 * layers, unioned in precedence order:
 *
 *   1. PDF link annotations  — pdf.js exposes every clickable link's URL even
 *      when the visible anchor is an icon/word ("hidden" links). THE key fix.
 *   2. Plain-text URLs       — regex over extracted text, incl. scheme-less
 *      ("leetcode.com/u/x" without https://).
 *   3. LLM fallback (Gemini → Mistral on rate limits) — for handle-only mentions
 *      with no link at all; a handle is kept only if it literally appears in the text.
 *
 * Short-link hosts (bit.ly, …) are followed to their destination before
 * classifying. Everything is best-effort: any layer can fail and return nothing.
 */

export type LinkSource = "annotation" | "text" | "llm";

export interface FoundLink {
  url: string;
  source: LinkSource;
}

export interface ExtractedProfiles {
  leetcode: FoundLink | null;
  codeforces: FoundLink | null;
  codechef: FoundLink | null;
}

function ensureScheme(url: string): string {
  const u = (url ?? "").trim();
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

function str(v: unknown): string {
  return String(v ?? "").trim();
}

// ── Layer 1: PDF link annotations ────────────────────────────────────────────

interface PdfAnnotation {
  url?: string;
  unsafeUrl?: string;
}

async function getPdfAnnotationLinks(buffer: Buffer): Promise<string[]> {
  // Destroy the pdf.js document when done — otherwise its parsed pages/fonts
  // stay in memory and accumulate across a large batch until the process OOMs.
  let destroy: (() => Promise<void>) | undefined;
  try {
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    destroy = () => pdf.destroy();
    const urls: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const annots = (await page.getAnnotations()) as PdfAnnotation[];
      for (const a of annots) {
        const url = a?.url || a?.unsafeUrl;
        if (typeof url === "string" && url.trim()) urls.push(url.trim());
      }
    }
    return urls;
  } catch (err) {
    console.warn("[resume-links] annotation extraction failed:", err instanceof Error ? err.message : err);
    return [];
  } finally {
    try {
      await destroy?.();
    } catch {
      /* already torn down */
    }
  }
}

// ── Layer 2: plain-text URLs ─────────────────────────────────────────────────

const TEXT_URL_RE =
  /((?:https?:\/\/)?(?:www\.)?(?:leetcode\.com|codeforces\.com|codechef\.com)\/[^\s"'<>)\]}]+)/gi;

function extractUrlsFromText(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(TEXT_URL_RE)) {
    // Trim trailing punctuation that commonly clings to URLs in resumes.
    out.add(m[1].replace(/[.,);]+$/, ""));
  }
  return [...out];
}

/** Any URL in the resume text (not just coding profiles). */
const ANY_URL_RE = /((?:https?:\/\/)|(?:www\.))[^\s"'<>)\]}]+/gi;

/**
 * Scheme-less GitHub mentions — "github.com/ravi-kumar", "github.com/ravi/todo-app",
 * "ravi-kumar.github.io". ANY_URL_RE needs http(s):// or www., and resumes often print
 * neither when the link isn't clickable. The lookbehind skips text already inside a
 * full URL or an email address.
 */
const BARE_GITHUB_RE =
  /(?<![\w.@/-])(?:github\.com\/[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9._-]+)?|[A-Za-z0-9][A-Za-z0-9-]*\.github\.io)\b/gi;

/**
 * Every URL the resume contains — PDF link annotations (i.e. links hidden behind
 * an icon or a project title, which is how most resumes carry their GitHub and
 * live-demo links) unioned with plain-text URLs. Deduped, scheme-normalised.
 *
 * Used by the projects consolidation to ground each project's repo/demo links in
 * URLs that genuinely exist in the document rather than trusting the model.
 */
export async function collectResumeUrls(resume: ResumeBytes): Promise<string[]> {
  const annotationUrls = resume.mimeType.startsWith("text/") ? [] : await getPdfAnnotationLinks(resume.data);

  let text = "";
  try {
    text = resume.mimeType.startsWith("text/")
      ? resume.data.toString("utf8")
      : await pdfBufferToText(resume.data);
  } catch {
    text = "";
  }
  const textUrls = text
    ? [...text.matchAll(ANY_URL_RE)].map((m) => m[0].replace(/[.,);:]+$/, ""))
    : [];
  const bareGithub = text ? [...text.matchAll(BARE_GITHUB_RE)].map((m) => m[0].replace(/[.,);:]+$/, "")) : [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...annotationUrls, ...textUrls, ...bareGithub]) {
    const url = ensureScheme(raw.trim());
    if (!/^https?:\/\//i.test(url)) continue;
    const key = url.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out.slice(0, 120);
}

// ── Short-link resolution ────────────────────────────────────────────────────

const SHORTENERS = new Set([
  "bit.ly", "tinyurl.com", "rb.gy", "cutt.ly", "is.gd", "t.co",
  "goo.gl", "shorturl.at", "lnkd.in", "rebrand.ly", "shrtco.de", "surl.li",
]);

function hostOf(url: string): string {
  try {
    return new URL(ensureScheme(url)).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function isShortener(url: string): boolean {
  return SHORTENERS.has(hostOf(url));
}

async function resolveRedirect(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(ensureScheme(url), {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "nxtwave-placement-automation" },
    });
    return res.url || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Classification via the existing handle parsers ───────────────────────────

function classify(url: string): "leetcode" | "codeforces" | "codechef" | null {
  if (parseLeetCodeUser(url)) return "leetcode";
  if (parseCodeforcesHandle(url)) return "codeforces";
  if (parseCodeChefHandle(url)) return "codechef";
  return null;
}

// ── Layer 3: LLM fallback (handle-only mentions) ─────────────────────────────

const LINK_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    leetcode: { type: SchemaType.STRING },
    codeforces: { type: SchemaType.STRING },
    codechef: { type: SchemaType.STRING },
  },
  // Required, or models drop the platforms they found nothing for — and sometimes the ones they did.
  required: ["leetcode", "codeforces", "codechef"],
};

const LINK_SYSTEM =
  "You extract coding-profile identifiers from a resume's text. Return strict JSON " +
  '{"leetcode": string, "codeforces": string, "codechef": string}. For each platform give the full profile ' +
  "URL if present; if only a username/handle is mentioned near that platform's name, give " +
  "the bare handle; otherwise an empty string. Never invent or guess a handle that is not " +
  "in the text. Exclude emails and unrelated links.";

/**
 * Turn a value (full URL or bare handle) into a validated LeetCode profile URL,
 * or "" when it can't be resolved. Reused for sheet-provided + LLM values.
 */
export function toLeetCodeUrl(v: string): string {
  const s = v.trim();
  if (!s) return "";
  if (/leetcode\.com/i.test(s)) return parseLeetCodeUser(s) ? ensureScheme(s) : "";
  const handle = s.replace(/^@/, "").replace(/\s+/g, "");
  const url = `https://leetcode.com/u/${encodeURIComponent(handle)}/`;
  return parseLeetCodeUser(url) ? url : "";
}

export function toCodeforcesUrl(v: string): string {
  const s = v.trim();
  if (!s) return "";
  if (/codeforces\.com/i.test(s)) {
    const handle = parseCodeforcesHandle(s);
    return handle ? `https://codeforces.com/profile/${encodeURIComponent(handle)}` : "";
  }
  const handle = s.replace(/^@/, "").replace(/\s+/g, "");
  const url = `https://codeforces.com/profile/${encodeURIComponent(handle)}`;
  return parseCodeforcesHandle(url) ? url : "";
}

export function toCodeChefUrl(v: string): string {
  const s = v.trim();
  if (!s) return "";
  if (/codechef\.com/i.test(s)) {
    const handle = parseCodeChefHandle(ensureScheme(s));
    return handle ? `https://www.codechef.com/users/${encodeURIComponent(handle)}` : "";
  }
  const handle = s.replace(/^@/, "").replace(/\s+/g, "");
  const url = `https://www.codechef.com/users/${encodeURIComponent(handle)}`;
  return parseCodeChefHandle(url) ? url : "";
}

/**
 * Fast chain for this small job. Every tier gets a short timeout, and a model
 * that is rate-limited, out of quota, overloaded or slow is skipped at once
 * (parked for the next calls too) — so when Gemini is throttled the lookup
 * moves straight to Mistral, round-robin across MISTRAL_API_KEYS.
 * Override with LINKS_LLM_CHAIN.
 */
const LINKS_CHAIN =
  "gemini:gemini-3.8-flash,gemini:gemini-3.1-flash-lite,gemini:gemini-2.5-flash," +
  "mistral:ministral-8b-latest,mistral:ministral-3b-latest";
const LINKS_TIMEOUT_MS = 15_000;
/** The whole fallback (every model tried) is abandoned after this — it's the last, optional layer. */
const LINKS_TOTAL_MS = 40_000;

const LINK_SHAPE =
  'Return ONLY a JSON object: {"leetcode": string, "codeforces": string, "codechef": string} — empty strings when absent.';

/**
 * The handle a profile URL points at must literally appear in the resume text —
 * this drops any handle a model guessed or reconstructed from the name.
 */
function handleInText(url: string, textLower: string): boolean {
  const handle = parseLeetCodeUser(url) ?? parseCodeforcesHandle(url) ?? parseCodeChefHandle(url);
  return Boolean(handle && textLower.includes(handle.toLowerCase()));
}

async function llmExtract(text: string): Promise<{ leetcode: string; codeforces: string; codechef: string }> {
  const empty = { leetcode: "", codeforces: "", codechef: "" };
  const input = `Resume text:\n\n${text.slice(0, 20000)}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const res = await Promise.race([
    runLlmChain({
      label: "resume-links",
      chain: env.links.llmChain || LINKS_CHAIN,
      system: LINK_SYSTEM,
      schema: LINK_SCHEMA,
      shapeHint: LINK_SHAPE,
      temperature: 0,
      timeoutMs: LINKS_TIMEOUT_MS,
      fast: true,
      build: () => ({ geminiParts: input, text: input }),
    }).finally(() => clearTimeout(timer)),
    new Promise<{ ok: false; error: string }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: `no answer within ${LINKS_TOTAL_MS / 1000}s` }), LINKS_TOTAL_MS);
    }),
  ]);
  if (!res.ok) {
    console.warn("[resume-links] LLM fallback skipped:", res.error.slice(0, 200));
    return empty;
  }
  const p = res.json as Record<string, unknown>;
  const lower = text.toLowerCase();
  const keep = (url: string) => (url && handleInText(url, lower) ? url : "");
  return {
    leetcode: keep(toLeetCodeUrl(str(p.leetcode))),
    codeforces: keep(toCodeforcesUrl(str(p.codeforces))),
    codechef: keep(toCodeChefUrl(str(p.codechef))),
  };
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Extract LeetCode, Codeforces + CodeChef profile links from a resume's bytes.
 * `useLlm` controls whether the LLM fallback (Gemini, Mistral on rate limits) runs.
 */
export async function extractProfileLinksFromResume(
  resume: ResumeBytes,
  useLlm = true,
): Promise<ExtractedProfiles> {
  const result: ExtractedProfiles = { leetcode: null, codeforces: null, codechef: null };
  const complete = () => Boolean(result.leetcode && result.codeforces && result.codechef);

  const assign = (url: string, source: LinkSource): void => {
    const kind = classify(url);
    if (kind === "leetcode" && !result.leetcode) result.leetcode = { url: ensureScheme(url), source };
    if (kind === "codeforces" && !result.codeforces) result.codeforces = { url: ensureScheme(url), source };
    if (kind === "codechef" && !result.codechef) {
      const normalized = toCodeChefUrl(url);
      if (normalized) result.codechef = { url: normalized, source };
    }
  };

  // Layers 1 + 2, annotation precedence (only PDFs carry link annotations).
  const isText = resume.mimeType.startsWith("text/");
  const annotationUrls = isText ? [] : await getPdfAnnotationLinks(resume.data);
  const text = resume.mimeType.startsWith("text/")
    ? resume.data.toString("utf8")
    : await pdfBufferToText(resume.data);
  const textUrls = extractUrlsFromText(text);

  const candidates: FoundLink[] = [
    ...annotationUrls.map((url): FoundLink => ({ url, source: "annotation" })),
    ...textUrls.map((url): FoundLink => ({ url, source: "text" })),
  ];
  for (const c of candidates) assign(c.url, c.source);

  // Resolve short links only if something is still missing.
  if (!complete()) {
    for (const c of candidates) {
      if (complete()) break;
      if (!isShortener(c.url)) continue;
      const final = await resolveRedirect(c.url);
      if (final) assign(final, c.source);
    }
  }

  // LLM fallback for handle-only mentions.
  if (useLlm && !complete() && text.trim().length > 40) {
    const llm = await llmExtract(text);
    if (!result.leetcode && llm.leetcode) result.leetcode = { url: llm.leetcode, source: "llm" };
    if (!result.codeforces && llm.codeforces) result.codeforces = { url: llm.codeforces, source: "llm" };
    if (!result.codechef && llm.codechef) result.codechef = { url: llm.codechef, source: "llm" };
  }

  return result;
}
