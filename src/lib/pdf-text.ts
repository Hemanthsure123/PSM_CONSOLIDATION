import "server-only";
import { PDF_READER_VERSION, readResumeCache, sha256, writeResumeCache } from "@/lib/resume-cache";

/**
 * Reading a PDF's text layer and its link annotations with `unpdf` (a bundled pdf.js).
 *
 * A PDF is opened ONCE per file: `parsePdf` reads every page's text and every clickable link in
 * one pass, and the result is shared by everyone who asks about the same bytes —
 *  - in memory, per Buffer, while the file is being screened (the text for the model, the URLs
 *    for GitHub, the coding-profile links for DSA all come from one parse);
 *  - in the database (automation.resume_cache, by the file's SHA-256), so the same file in a
 *    re-run or in another company's job is never parsed again.
 * On the free instance (0.1 CPU) parsing is the most expensive thing screening does, so this
 * matters more than anything else for its speed. Results are identical to parsing each time.
 *
 * pdf.js warnings ("CFF stem hints are in wrong order"…) are switched off: they are about font
 * hinting, never about the text, and printing thousands of them costs CPU.
 */

export interface ParsedPdf {
  /** Each page's text as pdf.js extracts it ([] when the file has no readable text layer). */
  pages: string[];
  /** Every link annotation's URL, in page order. */
  links: string[];
  /** Came from the database cache (this file was parsed before). */
  fromCache?: boolean;
}

interface ParseOutcome extends ParsedPdf {
  /** False when reading failed (a failure is never cached). */
  complete: boolean;
}

const inFlight = new WeakMap<Buffer, Promise<ParseOutcome>>();

interface PdfAnnotation {
  url?: string;
  unsafeUrl?: string;
}

async function parseUncached(buffer: Buffer): Promise<ParseOutcome> {
  const out: ParseOutcome = { pages: [], links: [], complete: true };
  let pdf: Awaited<ReturnType<typeof import("unpdf")["getDocumentProxy"]>> | undefined;
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    pdf = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 });
    try {
      const { text } = await extractText(pdf, { mergePages: false });
      out.pages = Array.isArray(text) ? text : [text];
    } catch (err) {
      out.complete = false;
      console.warn("[pdf-text] text extraction failed:", err instanceof Error ? err.message : err);
    }
    try {
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        for (const a of (await page.getAnnotations()) as PdfAnnotation[]) {
          const url = a?.url || a?.unsafeUrl;
          if (typeof url === "string" && url.trim()) out.links.push(url.trim());
        }
      }
    } catch (err) {
      out.complete = false;
      console.warn("[pdf-text] link extraction failed:", err instanceof Error ? err.message : err);
    }
  } catch (err) {
    out.complete = false;
    console.warn("[pdf-text] the PDF couldn't be opened:", err instanceof Error ? err.message : err);
  } finally {
    // pdf.js keeps pages and fonts in memory until destroyed; not destroying it leaks on every
    // resume and eventually runs a long batch out of memory.
    await pdf?.destroy().catch(() => undefined);
  }
  return out;
}

async function parseWithCache(buffer: Buffer): Promise<ParseOutcome> {
  const hash = sha256(buffer);
  const cached = await readResumeCache<ParsedPdf>(hash, "pdf", PDF_READER_VERSION);
  if (cached && Array.isArray(cached.pages) && Array.isArray(cached.links)) {
    parseStats.cacheHits++;
    return { pages: cached.pages, links: cached.links, complete: true, fromCache: true };
  }
  parseStats.parses++;
  const parsed = await parseUncached(buffer);
  if (parsed.complete) await writeResumeCache(hash, "pdf", PDF_READER_VERSION, { pages: parsed.pages, links: parsed.links }, buffer.length);
  return parsed;
}

/** Counters for tests and the timing report (process-wide). */
export const parseStats = { parses: 0, cacheHits: 0 };

/** The PDF's pages and links — parsed at most once per Buffer, and once per file content overall. */
export function parsePdf(buffer: Buffer): Promise<ParsedPdf> {
  let pending = inFlight.get(buffer);
  if (!pending) {
    pending = parseWithCache(buffer);
    inFlight.set(buffer, pending);
  }
  return pending;
}

/**
 * Plain text of the whole PDF: pages joined, all whitespace collapsed to single spaces (exactly
 * what unpdf's `mergePages: true` returns). "" for image-only / scanned PDFs.
 */
export async function pdfBufferToText(buffer: Buffer): Promise<string> {
  const { pages } = await parsePdf(buffer);
  return pages.join("\n").replace(/\s+/g, " ").trim();
}

/**
 * Like pdfBufferToText, but keeps each page's line breaks (only runs of spaces are collapsed),
 * so section headings such as "SKILLS" or "PROJECTS" stay on their own lines.
 */
export async function pdfBufferToLines(buffer: Buffer): Promise<string> {
  const { pages } = await parsePdf(buffer);
  return pages
    .join("\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Every clickable link's URL (icons and words included — how resumes carry most GitHub links). */
export async function pdfAnnotationLinks(buffer: Buffer): Promise<string[]> {
  return (await parsePdf(buffer)).links;
}
