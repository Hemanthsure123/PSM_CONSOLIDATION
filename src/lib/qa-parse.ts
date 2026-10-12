import type { QaCandidateInput } from "@/lib/qa-types";

/**
 * Parse pasted candidates for QA Resume Screening — rows copied from a sheet:
 * `mobile <TAB> resume link` (a name column and any column order are fine).
 * The resume can also be the resume TEXT itself: Google Sheets wraps a
 * multi-line cell in quotes when copying, and those cells are read whole.
 * Without tabs, each line is read as "mobile … link" (commas / spaces / pipes).
 */

export interface ParsedQaRow {
  /** 1-based row number in the paste. */
  row: number;
  /** Short preview of the row for the problems table. */
  preview: string;
  candidate: QaCandidateInput | null;
  /** Why the row can't be screened ("" when valid). */
  problem: string;
}

const URL_RE = /(?:https?:\/\/|www\.)[^\s"'<>]+/i;
const PHONE_CELL_RE = /^\+?[\d\s().-]{7,20}$/;
const PHONE_IN_TEXT_RE = /\+?\d[\d\s().-]{7,}\d/;
const NAME_RE = /^[A-Za-z][A-Za-z .'-]{1,79}$/;
const HEADER_RE = /\b(mobile|phone|contact|number|resume|cv|name|uuid|link)\b/i;

/** "+91 98765-43210", "09876543210" and "9876543210" are the same candidate. */
export function normaliseMobile(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

/** Index of the next tab / line break at or after `from` (-1 = none). */
function nextDelim(text: string, from: number): number {
  for (let k = from; k < text.length; k++) {
    const ch = text[k];
    if (ch === "\t" || ch === "\n" || ch === "\r") return k;
  }
  return -1;
}

/** Tab-separated rows; a cell that starts with a quote may span lines ("" = a literal quote). */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const n = text.length;
  while (i <= n) {
    let cell = "";
    if (text[i] === '"') {
      // Quoted cell — read to the closing quote.
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            cell += '"';
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        cell += text[j++];
      }
      if (!closed || (j < n && text[j] !== "\t" && text[j] !== "\n" && text[j] !== "\r")) {
        // Not a real quoted cell — fall back to reading it plainly.
        const end = nextDelim(text, i);
        cell = end < 0 ? text.slice(i) : text.slice(i, end);
        j = end < 0 ? n : end;
      }
      i = j;
    } else {
      const end = nextDelim(text, i);
      cell = end < 0 ? text.slice(i) : text.slice(i, end);
      i = end < 0 ? n : end;
    }
    row.push(cell.trim());
    if (i >= n) {
      rows.push(row);
      break;
    }
    if (text[i] === "\t") {
      i++;
      continue;
    }
    // Line break ends the row (\r\n counts once).
    if (text[i] === "\r" && text[i + 1] === "\n") i++;
    i++;
    rows.push(row);
    row = [];
  }
  return rows.filter((r) => r.some((c) => c));
}

/** Rows without tabs: split each line on commas / semicolons / pipes, keeping a URL whole. */
function parseLines(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const url = line.match(URL_RE)?.[0] ?? "";
      const rest = url ? line.replace(url, " ") : line;
      const phone = rest.match(PHONE_IN_TEXT_RE)?.[0] ?? "";
      const remaining = (phone ? rest.replace(phone, " ") : rest)
        .split(/[,;|]/)
        .map((c) => c.trim())
        .filter(Boolean);
      return [phone, url, ...remaining].filter(Boolean);
    });
}

function preview(cells: string[]): string {
  return cells
    .filter(Boolean)
    .map((c) => (c.length > 60 ? `${c.slice(0, 57).replace(/\s+/g, " ")}…` : c))
    .join(" · ")
    .slice(0, 160);
}

/**
 * @param existing ids already in the run (earlier batches) → batch they came in.
 */
export function parseQaPaste(text: string, batch: number, existing: Map<string, number>): ParsedQaRow[] {
  const raw = text.includes("\t") ? parseTsv(text) : parseLines(text);
  const out: ParsedQaRow[] = [];
  const seen = new Map<string, number>();

  raw.forEach((cells, idx) => {
    const row = idx + 1;
    const phoneCell = cells.find((c) => PHONE_CELL_RE.test(c) && normaliseMobile(c).length >= 7);
    // The resume link: a Drive / Docs / PDF / "resume" link first, else any link.
    const urlCell =
      cells.find((c) => URL_RE.test(c) && /drive\.google|docs\.google|\.pdf|resume|\bcv\b/i.test(c)) ??
      cells.find((c) => URL_RE.test(c));
    // Header row: no phone number, but header words.
    if (idx === 0 && !phoneCell && HEADER_RE.test(cells.join(" ")) && cells.every((c) => c.length < 60)) return;

    const base = { row, preview: preview(cells) };
    if (!phoneCell) {
      out.push({ ...base, candidate: null, problem: "No mobile number in this row" });
      return;
    }
    const id = normaliseMobile(phoneCell);
    let resumeUrl = "";
    let resumeText: string | undefined;
    if (urlCell) {
      resumeUrl = (urlCell.match(URL_RE)?.[0] ?? "").replace(/[).,;]+$/, "");
      if (!/^https?:\/\//i.test(resumeUrl)) resumeUrl = `https://${resumeUrl}`;
    } else {
      const longest = cells.filter((c) => c !== phoneCell).sort((a, b) => b.length - a.length)[0] ?? "";
      if (longest.length >= 100) resumeText = longest;
    }
    if (!resumeUrl && !resumeText) {
      out.push({ ...base, candidate: null, problem: "No resume link (or resume text) in this row" });
      return;
    }
    const prior = existing.get(id);
    if (prior !== undefined) {
      out.push({ ...base, candidate: null, problem: `Already added in batch ${prior}` });
      return;
    }
    const first = seen.get(id);
    if (first !== undefined) {
      out.push({ ...base, candidate: null, problem: `Duplicate mobile — same as row ${first}` });
      return;
    }
    seen.set(id, row);
    const name = cells.find((c) => c !== phoneCell && c !== urlCell && c !== resumeText && NAME_RE.test(c)) ?? "";
    out.push({
      ...base,
      candidate: { id, mobile: id, name, resumeUrl, ...(resumeText ? { resumeText } : {}), batch },
      problem: "",
    });
  });
  return out;
}
