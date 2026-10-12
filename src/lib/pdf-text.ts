import "server-only";

/**
 * Extract plain text from a PDF buffer (used to feed the text-only fallback LLM
 * providers — Groq / Mistral — which can't read PDFs natively the way Gemini
 * can). Uses `unpdf`, a serverless-friendly bundled build of pdf.js.
 *
 * Returns "" for image-only/scanned PDFs (no embedded text) — callers should
 * treat an empty result as "no usable text".
 */
export async function pdfBufferToText(buffer: Buffer): Promise<string> {
  // pdf.js keeps the parsed document (pages, fonts) in memory until destroyed;
  // NOT destroying it leaks on every resume and eventually OOMs a long batch.
  let destroy: (() => Promise<void>) | undefined;
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    destroy = () => pdf.destroy();
    const { text } = await extractText(pdf, { mergePages: true });
    const out = Array.isArray(text) ? text.join("\n") : text;
    return (out ?? "").trim();
  } catch (err) {
    console.warn("[pdf-text] extraction failed:", err instanceof Error ? err.message : err);
    return "";
  } finally {
    try {
      await destroy?.();
    } catch {
      /* already torn down */
    }
  }
}

/**
 * Like pdfBufferToText, but keeps each page's line breaks (only runs of spaces
 * are collapsed), so section headings such as "SKILLS" or "PROJECTS" stay on
 * their own lines. Returns "" for image-only PDFs.
 */
export async function pdfBufferToLines(buffer: Buffer): Promise<string> {
  let destroy: (() => Promise<void>) | undefined;
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    destroy = () => pdf.destroy();
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    return pages
      .join("\n")
      .replace(/[^\S\n]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch (err) {
    console.warn("[pdf-text] line extraction failed:", err instanceof Error ? err.message : err);
    return "";
  } finally {
    try {
      await destroy?.();
    } catch {
      /* already torn down */
    }
  }
}
