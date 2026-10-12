import type { CandidateInput } from "@/lib/assignment-types";

/**
 * Parse pasted candidate rows — typically two columns copied from a sheet:
 * `mobile <TAB> github link` (commas, semicolons or spaces also work, and the
 * columns may be in either order). A header row is skipped automatically.
 */

export interface ParsedRow {
  line: number;
  raw: string;
  candidate: CandidateInput | null;
  /** Why the row can't be evaluated ("" when valid). */
  problem: string;
}

const GITHUB_RE = /(?:https?:\/\/)?(?:www\.)?github\.com\/[^\s,;"'<>|]+|git@github\.com:[^\s,;"'<>|]+/i;
const ANY_URL_RE = /(?:https?:\/\/|www\.)[^\s,;"'<>|]+/i;
const HEADER_RE = /^(?=.*\b(mobile|phone|number|uuid|id|contact)\b)(?=.*\b(github|repo|link|url)\b)/i;

/**
 * Phone-like IDs are reduced to digits, and an Indian +91 / 0 prefix on a
 * 10-digit mobile is dropped, so "+91 98765-43210", "09876543210" and
 * "9876543210" are the same candidate.
 */
function normaliseId(value: string): string {
  const v = value.trim().replace(/^["']|["']$/g, "");
  if (!/^[+\d\s().-]+$/.test(v)) return v;
  const digits = v.replace(/\D/g, "");
  if (digits.length < 7) return v;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

function normaliseGithub(value: string): string {
  let v = value.trim().replace(/[).,;]+$/, "");
  if (/^git@github\.com:/i.test(v)) v = `https://github.com/${v.replace(/^git@github\.com:/i, "")}`;
  if (!/^https?:\/\//i.test(v)) v = `https://${v.replace(/^www\./i, "")}`;
  return v.replace(/^http:\/\//i, "https://");
}

export function parseCandidateRows(text: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const seen = new Map<string, number>();
  const lines = text.split(/\r?\n/);

  lines.forEach((rawLine, idx) => {
    const raw = rawLine.trim();
    if (!raw) return;
    const line = idx + 1;
    if (rows.length === 0 && HEADER_RE.test(raw) && !GITHUB_RE.test(raw)) return; // header row

    const gh = raw.match(GITHUB_RE);
    if (!gh) {
      rows.push({
        line,
        raw,
        candidate: null,
        problem: ANY_URL_RE.test(raw) ? "Link is not a GitHub link" : "No GitHub link in this row",
      });
      return;
    }
    const rest = raw.replace(gh[0], " ");
    // Prefer a phone-looking run anywhere in the row; else the first other cell (any UUID).
    const phone = rest.match(/\+?\d[\d\s().-]{7,}\d/);
    const cells = rest
      .split(/\t|,|;|\|/)
      .map((c) => c.trim())
      .filter(Boolean);
    const id = normaliseId(phone ? phone[0] : (cells[0] ?? ""));
    if (!id) {
      rows.push({ line, raw, candidate: null, problem: "No mobile number / ID in this row" });
      return;
    }
    const first = seen.get(id);
    if (first !== undefined) {
      rows.push({ line, raw, candidate: null, problem: `Duplicate of line ${first}` });
      return;
    }
    seen.set(id, line);
    rows.push({ line, raw, candidate: { id, githubUrl: normaliseGithub(gh[0]) }, problem: "" });
  });

  return rows;
}
