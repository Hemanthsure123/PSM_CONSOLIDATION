import { normaliseMobile, parseTsv } from "@/lib/qa-parse";
import type { BenchmarkCandidateInput } from "@/lib/benchmark-types";
import { linkOnly } from "@/lib/resume-input";

/**
 * Parse pasted resumes for Benchmark Projects. Three shapes are recognised:
 *
 *  1. TABLE — rows copied from a sheet (tab-separated): an ID column (mobile
 *     number or serial number) and a resume column holding either a link or the
 *     resume text itself (Google Sheets quotes multi-line cells; they are read
 *     whole).
 *  2. LINKS — one candidate per line: "9876543210 https://drive.google.com/…".
 *  3. TEXT DUMP — resumes pasted one after another, each starting with a line
 *     that is just its number:
 *         1
 *         <resume text…>
 *         2.
 *         <resume text…>
 *     or just a mobile number ("9876543210", "Mobile: +91 98765 43210").
 *     Serial numbers must run in sequence (1, 2, 3 …), so a stray "2" or a year
 *     inside a resume is not taken for a new resume; with mobile-number headers,
 *     the resume's own phone line (the same number) stays part of the resume.
 */

export interface ParsedBenchmarkRow {
  /** 1-based position in the paste (row, line or resume block). */
  row: number;
  preview: string;
  candidate: BenchmarkCandidateInput | null;
  /** Why it can't be screened ("" when valid). */
  problem: string;
}

export type PasteFormat = "table" | "links" | "text";

/** Shorter than this, a block is a heading or a note — not a resume. */
const MIN_RESUME_CHARS = 150;

const URL_RE = /(?:https?:\/\/|www\.)[^\s"'<>]+/i;
const PHONE_CELL_RE = /^\+?[\d\s().-]{7,20}$/;
const PHONE_IN_TEXT_RE = /\+?\d[\d\s().-]{7,}\d/;
/** An Indian mobile number inside free text ("+91 98765 43210", "9876543210") — never a run of years. */
const MOBILE_IN_TEXT_RE = /(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/;
const SERIAL_CELL_RE = /^\s*#?\s*(\d{1,5})\s*[.)]?\s*$/;
const HEADER_RE = /\b(mobile|phone|contact|number|resume|cv|name|uuid|link|s\.?\s*no)\b/i;

const LABEL = String.raw`(?:resume|candidate|cv|profile|applicant|student|s\.?\s*no|sr\.?\s*no|no|number)`;
const PHONE_LABEL = String.raw`(?:mobile|mob|phone|ph|contact|number)`;
/** A line that is only a serial number: "1", "1.", "2)", "#3", "Resume 4:", "Candidate - 5". */
const SERIAL_LINE = new RegExp(String.raw`^\s*(?:${LABEL}\.?\s*[:#-]?\s*)?#?\s*(\d{1,5})\s*[.):\-–—]?\s*$`, "i");
/** A line that is only a mobile number, optionally labelled / numbered: "9876543210", "3. +91 98765 43210". */
const MOBILE_LINE = new RegExp(
  String.raw`^\s*(?:(?:${LABEL}|${PHONE_LABEL})\.?\s*[:#-]?\s*)?(?:#?\d{1,5}\s*[.):\-–—]\s*)?(?:${PHONE_LABEL}\.?\s*[:#-]?\s*)?(\+?\d[\d\s().-]{6,18}\d)\s*$`,
  "i",
);

function preview(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 140 ? `${one.slice(0, 137)}…` : one;
}

function isMobile(digits: string): boolean {
  return digits.length >= 10 && digits.length <= 13;
}

/** IDs: a mobile number is global (deduplicated across batches); a serial number is per batch. */
function serialId(batch: number, n: string | number): { id: string; label: string } {
  return { id: `b${batch}-#${n}`, label: batch > 1 ? `Batch ${batch} · Resume ${n}` : `Resume ${n}` };
}

interface Draft {
  row: number;
  id: string;
  label: string;
  mobile: boolean;
  resumeUrl: string;
  resumeText: string;
  preview: string;
  problem: string;
}

/** Duplicates (within the paste and against earlier batches) → problems; the rest → candidates. */
function finish(drafts: Draft[], batch: number, existing: Map<string, number>): ParsedBenchmarkRow[] {
  const seen = new Map<string, number>();
  return drafts.map((d) => {
    const base = { row: d.row, preview: d.preview };
    if (d.problem) return { ...base, candidate: null, problem: d.problem };
    const prior = existing.get(d.id);
    if (prior !== undefined) return { ...base, candidate: null, problem: `Already added in batch ${prior}` };
    const first = seen.get(d.id);
    if (first !== undefined) {
      return { ...base, candidate: null, problem: `Duplicate ${d.mobile ? "mobile number" : "number"} — same as #${first}` };
    }
    seen.set(d.id, d.row);
    return {
      ...base,
      problem: "",
      candidate: {
        id: d.id,
        label: d.label,
        resumeUrl: d.resumeUrl,
        ...(d.resumeText ? { resumeText: d.resumeText } : {}),
        batch,
      },
    };
  });
}

// ── 1. Table (tab-separated) ─────────────────────────────────────────────────

function parseTable(text: string, batch: number): Draft[] {
  const rows = parseTsv(text);
  const out: Draft[] = [];
  rows.forEach((cells, idx) => {
    const row = idx + 1;
    const phoneCell = cells.find((c) => PHONE_CELL_RE.test(c) && isMobile(normaliseMobile(c)));
    const serialCell = cells.find((c) => SERIAL_CELL_RE.test(c));
    // A cell that is only a link is the resume LINK — however long it is (S3 / Drive links
    // run to 150-250 characters; reading one as resume text rejected whole pools).
    const linkCells = cells.filter((c) => linkOnly(c));
    const urlCell = linkCells.find((c) => /drive\.google|docs\.google|\.pdf|resume|\bcv\b/i.test(c)) ?? linkCells[0];
    // Resume TEXT: the longest cell that is real text, not a link / ID.
    const textCell =
      cells
        .filter((c) => c !== phoneCell && c !== serialCell && !linkOnly(c))
        .sort((a, b) => b.length - a.length)[0] ?? "";
    if (idx === 0 && !phoneCell && !serialCell && HEADER_RE.test(cells.join(" ")) && cells.every((c) => c.length < 60)) return;

    const ident = phoneCell
      ? { id: normaliseMobile(phoneCell), label: normaliseMobile(phoneCell), mobile: true }
      : { ...serialId(batch, serialCell ? (serialCell.match(SERIAL_CELL_RE)?.[1] ?? row) : row), mobile: false };
    // Both can be kept: the link is read first, the text is the fallback if the link can't be.
    const resumeUrl = urlCell ? linkOnly(urlCell) : "";
    const resumeText = textCell.length >= MIN_RESUME_CHARS ? textCell : "";
    out.push({
      row,
      ...ident,
      resumeUrl,
      resumeText,
      preview: preview(cells.join(" · ")),
      problem: resumeUrl || resumeText ? "" : "No resume link (or resume text) in this row",
    });
  });
  return out;
}

// ── 2. One link per line ─────────────────────────────────────────────────────

function parseLinkLines(lines: string[], batch: number): Draft[] {
  return lines.map((line, idx) => {
    const row = idx + 1;
    const url = line.match(URL_RE)?.[0] ?? "";
    const rest = url ? line.replace(url, " ") : line;
    const phone = rest.match(PHONE_IN_TEXT_RE)?.[0] ?? "";
    const serial = rest.match(/^\s*#?\s*(\d{1,5})\s*[.):\-–—]?\s/)?.[1];
    const ident =
      phone && isMobile(normaliseMobile(phone))
        ? { id: normaliseMobile(phone), label: normaliseMobile(phone), mobile: true }
        : { ...serialId(batch, serial ?? row), mobile: false };
    let resumeUrl = url.replace(/[).,;]+$/, "");
    if (resumeUrl && !/^https?:\/\//i.test(resumeUrl)) resumeUrl = `https://${resumeUrl}`;
    return { row, ...ident, resumeUrl, resumeText: "", preview: preview(line), problem: resumeUrl ? "" : "No resume link on this line" };
  });
}

// ── 3. Text dump ─────────────────────────────────────────────────────────────

/**
 * The serial-number lines that run in sequence (n, n+1, n+2 …) — the longest such
 * chain, preferring the one that starts lowest. A lone number or year inside a
 * resume can't extend the chain, so it stays resume text.
 */
function serialChain(lines: string[]): number[] {
  const cands: { i: number; v: number }[] = [];
  lines.forEach((l, i) => {
    const m = l.match(SERIAL_LINE);
    if (m) cands.push({ i, v: Number(m[1]) });
  });
  const len = new Array<number>(cands.length).fill(1);
  const prev = new Array<number>(cands.length).fill(-1);
  for (let k = 0; k < cands.length; k++) {
    for (let j = k - 1; j >= 0; j--) {
      if (cands[j].v === cands[k].v - 1 && len[j] + 1 > len[k]) {
        len[k] = len[j] + 1;
        prev[k] = j;
      }
    }
  }
  let best = -1;
  for (let k = 0; k < cands.length; k++) {
    if (best < 0 || len[k] > len[best] || (len[k] === len[best] && cands[k].v - len[k] < cands[best].v - len[best])) best = k;
  }
  if (best < 0) return [];
  const chain: number[] = [];
  for (let k = best; k >= 0; k = prev[k]) chain.unshift(cands[k].i);
  // One serial line counts only when it opens the paste ("1" then a single resume).
  if (chain.length === 1 && lines.slice(0, chain[0]).some((l) => l.trim())) return [];
  return chain;
}

function parseTextDump(text: string, batch: number): Draft[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  type Header = { line: number; end: number; id: string; label: string; mobile: boolean };
  const headers: Header[] = [];

  const chain = serialChain(lines);
  if (chain.length >= 1) {
    for (const i of chain) {
      const n = lines[i].match(SERIAL_LINE)?.[1] ?? "";
      // "1" followed straight away by "9876543210": the mobile number is the ID.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const mob = j < lines.length ? lines[j].match(MOBILE_LINE)?.[1] : undefined;
      if (mob && isMobile(normaliseMobile(mob))) {
        const id = normaliseMobile(mob);
        headers.push({ line: i, end: j + 1, id, label: id, mobile: true });
      } else {
        headers.push({ line: i, end: i + 1, ...serialId(batch, n), mobile: false });
      }
    }
  } else {
    // Mobile-number headers. The resume's own phone line repeats the same number — not a new resume.
    let current = "";
    lines.forEach((l, i) => {
      const mob = l.match(MOBILE_LINE)?.[1];
      if (!mob) return;
      const id = normaliseMobile(mob);
      if (!isMobile(id) || id === current) return;
      headers.push({ line: i, end: i + 1, id, label: id, mobile: true });
      current = id;
    });
  }

  const drafts: Draft[] = [];
  if (!headers.length) {
    const body = text.trim();
    if (!body) return [];
    const phone = body.match(MOBILE_IN_TEXT_RE)?.[0];
    const ident =
      phone && isMobile(normaliseMobile(phone))
        ? { id: normaliseMobile(phone), label: normaliseMobile(phone), mobile: true }
        : { ...serialId(batch, 1), mobile: false };
    drafts.push({ row: 1, ...ident, ...resumeOf(body), preview: preview(body) });
    return drafts;
  }

  const preamble = lines.slice(0, headers[0].line).join("\n").trim();
  if (preamble.length >= 40) {
    drafts.push({
      row: 0,
      id: "",
      label: "",
      mobile: false,
      resumeUrl: "",
      resumeText: "",
      preview: preview(preamble),
      problem: "Text before the first resume number — skipped",
    });
  }
  headers.forEach((h, k) => {
    const stop = k + 1 < headers.length ? headers[k + 1].line : lines.length;
    const body = lines.slice(h.end, stop).join("\n").trim();
    drafts.push({
      row: k + 1,
      id: h.id,
      label: h.label,
      mobile: h.mobile,
      ...(body ? resumeOf(body) : { resumeUrl: "", resumeText: "", problem: "Nothing after this number" }),
      preview: `${h.label}: ${preview(body)}`,
    });
  });
  return drafts;
}

/** A block of pasted content → the resume link (when it is only a link) or the resume text. */
function resumeOf(body: string): { resumeUrl: string; resumeText: string; problem: string } {
  const link = linkOnly(body);
  if (link) return { resumeUrl: link, resumeText: "", problem: "" };
  return { resumeUrl: "", resumeText: body, problem: body.length >= MIN_RESUME_CHARS ? "" : "Too short to be a resume" };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * @param existing ids already in the run (earlier batches) → the batch they came in.
 */
export function parseBenchmarkPaste(
  text: string,
  batch: number,
  existing: Map<string, number>,
): { format: PasteFormat; rows: ParsedBenchmarkRow[] } {
  if (!text.trim()) return { format: "text", rows: [] };

  // A sheet copy — but resume text copied from a PDF can carry stray tabs, so the
  // table reading is used only when most rows really look like candidate rows.
  if (text.includes("\t")) {
    const table = parseTable(text, batch);
    const usable = table.filter((d) => !d.problem).length;
    if (usable > 0 && usable >= table.length * 0.6) return { format: "table", rows: finish(table, batch, existing) };
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const withUrl = lines.filter((l) => URL_RE.test(l)).length;
  if (withUrl > 0 && withUrl >= lines.length * 0.6 && lines.every((l) => l.length < 400)) {
    return { format: "links", rows: finish(parseLinkLines(lines, batch), batch, existing) };
  }

  return { format: "text", rows: finish(parseTextDump(text, batch), batch, existing) };
}
