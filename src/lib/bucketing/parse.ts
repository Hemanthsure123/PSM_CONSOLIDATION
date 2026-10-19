import { normaliseMobile, parseTsv } from "@/lib/qa-parse";
import { parseCsv } from "@/lib/utils";
import { normalizeStage, normalizeTrack, type Stage, type Track } from "@/lib/bucketing/config";
import type { BucketingCandidateInput } from "@/lib/bucketing/types";

/**
 * Candidate Bucketing input — rows pasted from a sheet (tab-separated) or an
 * uploaded CSV export. Two shapes are understood:
 *
 *  1. A sheet with a header row (the "Assessed Pool" master sheet, or any sheet
 *     with Number / Resume columns). The header may sit on row 2 under a group
 *     row. The stage comes from a "Stage" column, or from the TR-1 / TR-2 status
 *     columns ("Cleared" → that round cleared); the track from a "Track" column.
 *  2. Header-less rows: mobile, resume link, stage, track in any order — each
 *     cell is recognised by its content.
 *
 * Rows with no stage get `defaultStage` (everyone in an assessed pool has at
 * least cleared the assessment).
 */

export interface ParsedBucketingRow {
  /** 1-based row number in the paste / file. */
  row: number;
  preview: string;
  candidate: BucketingCandidateInput | null;
  /** Why the row can't be bucketed ("" when valid). */
  problem: string;
  /** A note that doesn't block the row (e.g. TR-2 without a track). */
  warning: string;
  /** A row with a mobile but no resume link — kept so the run can list it as "no resume". */
  stub?: BucketingCandidateInput;
}

const URL_RE = /(?:https?:\/\/|www\.)[^\s"'<>]+/i;
const PHONE_CELL_RE = /^\+?[\d\s().-]{7,20}$/;
const NAME_RE = /^[A-Za-z][A-Za-z .'-]{1,79}$/;

type Field = "mobile" | "name" | "resume" | "stage" | "track" | "tr1" | "tr2" | "github" | "leetcode" | "codechef" | "codeforces";

/** Header → field. Order matters: the first match wins, and parent / college columns are never the candidate's. */
const HEADER_RULES: [Field, RegExp][] = [
  ["mobile", /^(?!.*\b(parent|father|mother|guardian|alternate|emergency)\b).*\b(mobile|phone|contact number|whatsapp|number|uuid)\b/i],
  ["resume", /\b(resume|cv)\b(?!.*\b(score|status)\b)/i],
  ["tr2", /\btr\s*-?\s*2\b.*\bstatus\b|\bround\s*2\b.*\bstatus\b/i],
  ["tr1", /\btr\s*-?\s*1\b.*\bstatus\b|\bround\s*1\b.*\bstatus\b/i],
  ["stage", /^(stage|final stage|highest stage|cleared stage|interview stage|status)$/i],
  ["track", /\b(track|tr\s*-?\s*2\s*(domain|track|stack)|interview domain|stack)\b/i],
  ["github", /\bgithub\b/i],
  ["leetcode", /\bleet\s*code\b/i],
  ["codechef", /\bcode\s*chef\b/i],
  ["codeforces", /\bcode\s*forces\b/i],
  ["name", /^(?!.*\b(parent|father|mother|college|course|school|sc|company|placement)\b)(student |candidate |full )?name$/i],
];

function mapHeader(cells: string[]): Partial<Record<Field, number>> {
  const map: Partial<Record<Field, number>> = {};
  cells.forEach((raw, i) => {
    const h = raw.replace(/\s+/g, " ").trim();
    if (!h || h.length > 60) return;
    const hit = HEADER_RULES.find(([field, re]) => map[field] === undefined && re.test(h));
    if (hit) map[hit[0]] = i;
  });
  return map;
}

/** A header row names at least a mobile column and a resume column. */
function findHeader(rows: string[][]): { at: number; map: Partial<Record<Field, number>> } | null {
  for (let i = 0; i < Math.min(rows.length, 4); i++) {
    const map = mapHeader(rows[i]);
    if (map.mobile !== undefined && map.resume !== undefined) return { at: i, map };
  }
  return null;
}

const cleared = (v: string) => /^\s*cleared\b/i.test(v ?? "") && !/not\s+cleared/i.test(v ?? "");

function preview(cells: string[]): string {
  return cells
    .filter(Boolean)
    .slice(0, 6)
    .map((c) => (c.length > 50 ? `${c.slice(0, 47).replace(/\s+/g, " ")}…` : c))
    .join(" · ")
    .slice(0, 160);
}

function linkFrom(cell: string): string {
  let url = (cell.match(URL_RE)?.[0] ?? "").replace(/[).,;]+$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

/**
 * Parse pasted rows or CSV text.
 * @param existing mobile numbers already in the run → the batch they came in (skipped).
 */
export function parseBucketingInput(
  text: string,
  opts: { batch: number; existing: Map<string, number>; defaultStage: Stage; csv?: boolean },
): ParsedBucketingRow[] {
  const rows = opts.csv ? parseCsv(text) : text.includes("\t") ? parseTsv(text) : text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(/\s*[,;|]\s*|\s{2,}/));
  const header = findHeader(rows);
  const out: ParsedBucketingRow[] = [];
  const seen = new Map<string, number>();

  rows.forEach((cells, idx) => {
    if (header && idx <= header.at) return;
    const row = idx + 1;
    const base = { row, preview: preview(cells), warning: "" };
    let mobileCell = "";
    let resumeCell = "";
    let name = "";
    let stage: Stage | null = null;
    let track: Track | null = null;
    let trackRaw = "";
    const links: Partial<Record<"github" | "leetcode" | "codechef" | "codeforces", string>> = {};

    if (header) {
      const m = header.map;
      const at = (f: Field) => (m[f] !== undefined ? (cells[m[f]!] ?? "").trim() : "");
      mobileCell = at("mobile");
      resumeCell = at("resume");
      name = at("name");
      if (m.stage !== undefined) stage = normalizeStage(at("stage"));
      if (!stage && (m.tr1 !== undefined || m.tr2 !== undefined)) {
        stage = cleared(at("tr2")) ? "TR2" : cleared(at("tr1")) ? "TR1" : null;
      }
      trackRaw = at("track");
      track = normalizeTrack(trackRaw);
      for (const k of ["github", "leetcode", "codechef", "codeforces"] as const) {
        const v = at(k);
        if (v) links[k] = v;
      }
    } else {
      // No header: recognise each cell by what it holds.
      for (const c of cells.map((x) => x.trim()).filter(Boolean)) {
        if (!mobileCell && PHONE_CELL_RE.test(c) && normaliseMobile(c).length >= 10) mobileCell = c;
        else if (URL_RE.test(c)) {
          if (/github\.com/i.test(c)) links.github = c;
          else if (/leetcode\.com/i.test(c)) links.leetcode = c;
          else if (/codechef\.com/i.test(c)) links.codechef = c;
          else if (/codeforces\.com/i.test(c)) links.codeforces = c;
          else if (!resumeCell) resumeCell = c;
        } else if (!stage && normalizeStage(c)) stage = normalizeStage(c);
        else if (!track && normalizeTrack(c) && c.length <= 30) {
          track = normalizeTrack(c);
          trackRaw = c;
        } else if (!name && NAME_RE.test(c)) name = c;
      }
    }

    const id = normaliseMobile(mobileCell);
    if (!id || id.length < 10) {
      out.push({ ...base, candidate: null, problem: "No mobile number in this row" });
      return;
    }
    const resumeUrl = linkFrom(resumeCell);
    const finalStage = stage ?? opts.defaultStage;
    const prior = opts.existing.get(id);
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
    const input: BucketingCandidateInput = {
      id,
      mobile: id,
      name: NAME_RE.test(name) ? name : "",
      resumeUrl,
      stage: finalStage,
      track: finalStage === "TR2" ? track : null,
      githubUrl: links.github,
      leetcodeUrl: links.leetcode,
      codechefUrl: links.codechef,
      codeforcesUrl: links.codeforces,
      batch: opts.batch,
    };
    if (!resumeUrl) {
      out.push({ ...base, candidate: null, problem: "No resume link in this row", stub: input });
      return;
    }

    const warning =
      finalStage === "TR2" && !track
        ? trackRaw
          ? `TR-2 track "${trackRaw}" not recognised — the TR-2 rule won't apply`
          : "TR-2 cleared with no track — the TR-2 rule won't apply"
        : "";
    out.push({ ...base, warning, problem: "", candidate: input });
  });
  return out;
}
