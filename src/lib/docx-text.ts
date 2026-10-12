import "server-only";
import { inflateRawSync } from "node:zlib";

/**
 * Plain text from a .docx (Word) file — no dependency: a .docx is a ZIP whose
 * body is word/document.xml. Reads the ZIP central directory, inflates that one
 * entry and turns paragraphs / tabs / line breaks into text.
 * Returns "" when the file isn't a readable .docx.
 */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEntry(buf: Buffer, name: string): Buffer | null {
  // End-of-central-directory record: within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const entryName = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (entryName === name) {
      if (buf.readUInt32LE(localOffset) !== LOC_SIG) return null;
      const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

export function docxToText(buf: Buffer): string {
  try {
    if (!isZip(buf)) return "";
    const xml = findEntry(buf, "word/document.xml");
    if (!xml) return "";
    const text = xml
      .toString("utf8")
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:(br|cr)\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "");
    return decodeEntities(text)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch (err) {
    console.warn("[docx-text] extraction failed:", err instanceof Error ? err.message : err);
    return "";
  }
}
