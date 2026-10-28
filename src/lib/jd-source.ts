import "server-only";
import { pdfBufferToLines } from "@/lib/pdf-text";
import { docxToText, isZip } from "@/lib/docx-text";

/**
 * A job description (or any context about a role) as text — from pasted text and / or one
 * uploaded file: PDF, Word (.docx), text / Markdown / HTML, or an image / scanned PDF (then the
 * file itself goes to the models that read files). Shared by Domain Shortlisting's and Sample
 * profiles' autofill. Never throws.
 */

/** Accepted uploads. */
export const JD_MAX_BYTES = 10 * 1024 * 1024;
export const JD_MAX_TEXT = 60_000;
export const JD_ACCEPT = ".pdf,.docx,.txt,.md,.html,.htm,.png,.jpg,.jpeg,.webp";

export type JdSourceKind = "text" | "pdf" | "docx" | "image" | "html";

export interface JdSourceInput {
  text: string;
  file: { name: string; type: string; data: Buffer } | null;
}

export type JdSource =
  | { ok: true; kind: JdSourceKind; name: string; text: string; inline: { mimeType: string; data: string } | null }
  | { ok: false; error: string; status: number };

function sniff(data: Buffer): "pdf" | "zip" | "ole" | { image: string } | null {
  if (data.subarray(0, 1024).toString("latin1").includes("%PDF-")) return "pdf";
  if (isZip(data)) return "zip";
  if (data.length > 8 && data.readUInt32BE(0) === 0xd0cf11e0) return "ole";
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { image: "image/jpeg" };
  if (data.length > 8 && data.readUInt32BE(0) === 0x89504e47) return { image: "image/png" };
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return { image: "image/webp" };
  return null;
}

const htmlToText = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h\d|tr)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .trim();

/** The pasted text and / or the uploaded file → one text (plus the file itself when it has no text layer). */
export async function readJdSource(input: JdSourceInput): Promise<JdSource> {
  const pasted = input.text.trim();
  if (!input.file) {
    if (pasted.length < 40) return { ok: false, error: "Paste the job description (at least a few lines) or upload it.", status: 400 };
    return { ok: true, kind: "text", name: "pasted text", text: pasted.slice(0, JD_MAX_TEXT), inline: null };
  }
  const { name, type, data } = input.file;
  const kind = sniff(data);
  const mime = type.toLowerCase();
  const withPasted = (text: string) => [text.trim(), pasted].filter(Boolean).join("\n\n").slice(0, JD_MAX_TEXT);

  if (kind === "pdf" || (!kind && mime.includes("pdf"))) {
    const text = await pdfBufferToLines(data);
    // A scanned PDF has no text layer — the models that read files see it as is.
    return {
      ok: true,
      kind: "pdf",
      name,
      text: withPasted(text),
      inline: text.trim().length < 40 ? { mimeType: "application/pdf", data: data.toString("base64") } : null,
    };
  }
  if (kind === "zip" || mime.includes("wordprocessingml") || /\.docx$/i.test(name)) {
    const text = docxToText(data);
    if (!text.trim() && !pasted) return { ok: false, error: "The Word file has no readable text — save it as PDF and upload that.", status: 422 };
    return { ok: true, kind: "docx", name, text: withPasted(text), inline: null };
  }
  if (kind === "ole" || mime.includes("msword") || /\.doc$/i.test(name)) {
    return { ok: false, error: "Old Word (.doc) files can't be read — save it as .docx or PDF.", status: 415 };
  }
  const image = kind && typeof kind === "object" ? kind.image : mime.startsWith("image/") ? mime : "";
  if (image) return { ok: true, kind: "image", name, text: pasted.slice(0, JD_MAX_TEXT), inline: { mimeType: image, data: data.toString("base64") } };
  if (mime.startsWith("text/") || /\.(txt|md|html?|csv)$/i.test(name) || !kind) {
    const raw = data.toString("utf8");
    if (/�{3,}/.test(raw.slice(0, 2_000))) return { ok: false, error: "That file isn't text, PDF, Word or an image.", status: 415 };
    const html = mime.includes("html") || /\.html?$/i.test(name);
    const text = withPasted(html ? htmlToText(raw) : raw);
    if (text.length < 40) return { ok: false, error: "The file has almost no text.", status: 422 };
    return { ok: true, kind: html ? "html" : "text", name, text, inline: null };
  }
  return { ok: false, error: "Upload a PDF, Word (.docx), text or image file.", status: 415 };
}

/** The multipart body every JD-autofill route takes: `text` and an optional `file`. */
export async function jdInputFromForm(form: FormData): Promise<{ ok: true; input: JdSourceInput } | { ok: false; error: string; status: number }> {
  const text = String(form.get("text") ?? "").slice(0, JD_MAX_TEXT);
  const raw = form.get("file");
  let file: JdSourceInput["file"] = null;
  if (raw && typeof raw === "object" && "arrayBuffer" in raw && (raw as File).size > 0) {
    const f = raw as File;
    if (f.size > JD_MAX_BYTES) return { ok: false, error: `The file is larger than ${JD_MAX_BYTES / 1024 / 1024} MB.`, status: 413 };
    file = { name: f.name.slice(0, 200), type: f.type, data: Buffer.from(await f.arrayBuffer()) };
  }
  if (!file && !text.trim()) return { ok: false, error: "Paste the job description or upload it first.", status: 400 };
  return { ok: true, input: { text, file } };
}
