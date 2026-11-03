import { cell, normalisePhone, num, squeeze, type Table } from "@/lib/pool/parse";
import type { ParseIssue } from "@/lib/pool/types";
import { assessmentInfo, type AssessmentKey } from "@/lib/pool/scores/catalogue";

/**
 * Assessment exports (CSV, or a Google Sheets tab) → final scores. Pure and client-safe: the
 * Eligible pool screen runs it in the browser to preview a file before importing it, and the
 * server runs it again on import. Tested in scripts/scores-selftest.ts.
 *
 * Every source is one entry of SOURCES: how to recognise it from its headers, which column holds
 * the ONE final score (never the section scores), its verdict, date, recording (interviews), and
 * the person's details.
 * A new kind of sheet is one more entry. Columns are found by header name (any of the header
 * rows), so column order and extra columns never matter.
 *
 * Only real results are kept: a row needs a valid candidate id and a final score, and rows that
 * were not attempted, cancelled or a no-show are counted as skipped.
 */

export type ScoreSourceId =
  | "old_offline"
  | "competency_offline"
  | "competency_interview"
  | "bucket_a_tr1"
  | "bucket_a_tr2"
  | "bucket_b_tr1_audit"
  | "bucket_b_tr1_app"
  | "bucket_b_tr2_audit"
  | "bucket_b_tr2_app";

export interface ScoreRow {
  userId: string;
  /** The attempt inside its source: "1" (one exam), "2026-03-07" (interview date, "#2" for a repeat), "cycle-4". */
  attempt: string;
  score: number;
  maxScore: number;
  takenOn: string | null;
  result: string;
  passed: boolean | null;
  /** The interview's recording link (http/https only), or null. */
  recordingUrl: string | null;
  /** 1-based row in the sheet (for messages). */
  row: number;
}

export interface PersonRow {
  userId: string;
  phone: string | null;
  name: string;
}

export interface ProfileRow {
  userId: string;
  yog: number | null;
  college: string;
  degree: string;
  department: string;
}

export interface ParsedScores {
  source: ScoreSourceId | null;
  /** Human name of the source kind: "Competency offline exam". */
  sourceLabel: string;
  assessment: AssessmentKey | null;
  /** The export this file is (what a re-import replaces): "dsa_offline@2026-10-25", "bucket_b_tr1:audit". */
  sourceKey: string;
  /** "DSA offline exam · 25 Oct 2026". */
  label: string;
  rows: ScoreRow[];
  people: PersonRow[];
  profiles: ProfileRow[];
  /** 1 = the assessed roster (may overwrite), 2 = an interview sheet, 3 = an exam export (fill gaps only). */
  profileRank: number;
  rowsRead: number;
  skipped: { reason: string; count: number }[];
  issues: ParseIssue[];
  /** Why nothing could be read (unknown sheet, missing column, exam date needed …). */
  error: string;
  /** An offline exam whose date isn't in the file or its name: ask for it. */
  needsDate: boolean;
}

export interface ParseContext {
  /** The CSV's file name or the sheet tab — offline exams carry their date there ("… - 25th Oct DSA offline.csv"). */
  fileName: string;
  /** YYYY-MM-DD, for an offline exam whose file has no date. */
  examDate?: string;
  /** "Now", for dates written without a year ("Mar 7"). */
  today?: Date;
}

// ── Headers ────────────────────────────────────────────────────────────────────

/** A string is compared squeezed (case, spaces, punctuation and "(…)" ignored); a RegExp is tested on the header lower-cased with spaces collapsed. */
type Matcher = string | RegExp;

const norm = (h: unknown) => String(h ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Header {
  /** Header texts per column: the header row, and the sub-header row under it when the sheet has one. */
  cols: string[][];
  /** First data row (0-based). */
  dataFrom: number;
}

const hit = (h: string, m: Matcher) => (typeof m === "string" ? squeeze(h) === squeeze(m) && squeeze(m) !== "" : m.test(norm(h)));

/** The first column whose header (either row) matches — matchers are tried in order, so the first one wins. */
function find(h: Header, ...ms: Matcher[]): number {
  for (const m of ms) {
    const i = h.cols.findIndex((texts) => texts.some((t) => hit(t, m)));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * The header: the first row (of the top five) with a key column. The row under it is a
 * sub-header (as in the interview audit sheets: "Overall Summary" › "Total (/15)") when its key
 * cell is empty, it has two or more labels, and none of them is a candidate id.
 */
function headerOf(table: Table, key: Matcher[]): Header | null {
  for (let r = 0; r < Math.min(5, table.length); r++) {
    const row = table[r] ?? [];
    const k = row.findIndex((c) => key.some((m) => hit(String(c ?? ""), m)));
    if (k < 0) continue;
    const next = table[r + 1] ?? [];
    const labels = next.filter((c) => String(c ?? "").trim());
    const sub = !String(next[k] ?? "").trim() && labels.length >= 2 && !labels.some((c) => UUID.test(norm(c)));
    const width = Math.max(row.length, sub ? next.length : 0);
    const cols = Array.from({ length: width }, (_, i) => [String(row[i] ?? ""), ...(sub ? [String(next[i] ?? "")] : [])]);
    return { cols, dataFrom: r + (sub ? 2 : 1) };
  }
  return null;
}

// ── Dates ──────────────────────────────────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const iso = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
};
/** A date written without a year is the most recent one (allowing two weeks ahead for scheduled rounds). */
function withYear(m: number, d: number, today: Date): string | null {
  const y = today.getUTCFullYear();
  const a = iso(y, m, d);
  if (!a) return iso(y - 1, m, d);
  return Date.parse(a) > today.getTime() + 14 * 86_400_000 ? iso(y - 1, m, d) : a;
}
const monthOf = (s: string) => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;

/**
 * "2026-03-13", "25-Sep-2026", "August 31, 2026", "Sep 13, 2026 at 04:17PM", "31/08/2026"
 * (day first unless that's impossible), "Mar 7" / "7 Mar" (year inferred) → YYYY-MM-DD.
 */
export function parseDate(raw: string, today: Date = new Date()): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    return b > 12 ? iso(+m[3], a, b) : iso(+m[3], b, a);
  }
  m = s.match(/^(\d{1,2})[\s-]+([a-z]{3,9})\.?,?[\s-]*(\d{4})?/i);
  if (m && monthOf(m[2]) > 0) return m[3] ? iso(+m[3], monthOf(m[2]), +m[1]) : withYear(monthOf(m[2]), +m[1], today);
  m = s.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/i);
  if (m && monthOf(m[1]) > 0) return m[3] ? iso(+m[3], monthOf(m[1]), +m[2]) : withYear(monthOf(m[1]), +m[2], today);
  return null;
}

/** "Competency Assessments Results - 25th Oct SE Offline.csv", "… - 25oct DSA offline.csv" → the exam date. */
export function dateFromName(name: string, today: Date = new Date()): string | null {
  const s = (name ?? "").replace(/\.[a-z]+$/i, "");
  const m = s.match(/(?:^|[^0-9])(\d{1,2})\s*(?:st|nd|rd|th)?[\s-]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:[\s-]*(20\d\d))?/i);
  if (m) return m[3] ? iso(+m[3], monthOf(m[2]), +m[1]) : withYear(monthOf(m[2]), +m[1], today);
  const n = s.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:[\s,]+(20\d\d))?(?![0-9])/i);
  return n ? (n[3] ? iso(+n[3], monthOf(n[1]), +n[2]) : withYear(monthOf(n[1]), +n[2], today)) : null;
}

/** "2026-10-25" → "25 Oct 2026" (the same on the server and in every browser). */
export const formatDate = (d: string | null) => {
  const m = (d ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1].replace(/^./, (c) => c.toUpperCase())} ${m[1]}` : "";
};

// ── Verdicts ───────────────────────────────────────────────────────────────────

/** Cleared / Qualified / Shortlisted → true; Not … / Rejected → false; anything else (or nothing) → null. */
export function passedOf(v: string): boolean | null {
  const s = norm(v);
  if (!s) return null;
  if (/^(not|un)[\s-]?(cleared|qualified|selected|shortlisted)\b|^rejected\b|^reject\b/.test(s)) return false;
  if (/^(cleared|qualified|selected|shortlisted)\b/.test(s)) return true;
  return null;
}

// ── The sources ────────────────────────────────────────────────────────────────

interface SourceSpec {
  id: ScoreSourceId;
  label: string;
  /** The candidate-id column. */
  key: Matcher[];
  /** Columns that must all be present (each: any of) — together they identify the sheet. */
  detect: Matcher[][];
  /** The assessment, from the headers (null = this sheet isn't one we can place). */
  assessment: (h: Header) => AssessmentKey | null;
  /** The export's identity (what a re-import replaces) — or the reason it can't be told. */
  partition: (a: AssessmentKey, h: Header, t: Table, ctx: ParseContext) => { sourceKey: string; label: string; date?: string } | { needsDate: true };
  score: Matcher[];
  /** The row's own maximum (else the catalogue's). */
  max?: Matcher[];
  /** Rows whose status doesn't match `accept` were not assessed (no-show, cancelled …): skipped. */
  status?: { col: Matcher[]; accept: RegExp };
  /** "single" = one result per person (an exam); "dated" = one per interview date; "cycle" = per cycle column. */
  attempt: "single" | "dated" | { cycle: Matcher[] };
  date?: Matcher[];
  /** The verdict text and whether it reads as cleared. */
  verdict?: (r: string[], h: Header) => { result: string; passed: boolean | null };
  /** The interview's recording link column. */
  recording?: Matcher[];
  name?: Matcher[];
  phone?: Matcher[];
  profile?: { rank: number; yog?: Matcher[]; college?: Matcher[]; degree?: Matcher[]; department?: Matcher[] };
}

const single = (cols: Matcher[], passed: (v: string) => boolean | null = passedOf) => (r: string[], h: Header) => {
  const v = cell(r, find(h, ...cols));
  return { result: v, passed: passed(v) };
};

/** The verdict from several columns ("Satisfactory – Conditional hire · Cleared"); `decisive` says whether it was cleared. */
const joined = (parts: Matcher[][], decisive: Matcher[]) => (r: string[], h: Header) => ({
  result: parts.map((m) => cell(r, find(h, ...m))).filter(Boolean).join(" · "),
  passed: passedOf(cell(r, find(h, ...decisive))),
});

const RECORDING: Matcher[] = ["Interview Recording Link", "Recording Link"];
/** The first http(s) link in a cell ("Event not found in Calendar …" is no recording). */
const linkIn = (v: string) => v.match(/https?:\/\/[^\s,;"'<>]+/i)?.[0].slice(0, 500) ?? null;

const OFFLINE_SUBJECT: [RegExp, AssessmentKey][] = [
  [/^problem solving coding/, "dsa_offline"],
  [/^html (&|and) css/, "frontend_offline"],
  [/^node ?js/, "backend_offline"],
  [/^(cs fundamentals|object oriented programming)/, "software_offline"],
];
const INTERVIEW_SUBJECT: [RegExp, AssessmentKey][] = [
  [/^problem 1/, "dsa_interview"],
  [/^html (&|and) css/, "frontend_interview"],
  [/backend foundations/, "backend_interview"],
  [/core cs fundamentals/, "software_interview"],
];
const subjectOf = (table: [RegExp, AssessmentKey][]) => (h: Header) => table.find(([re]) => h.cols.some((t) => t.some((x) => re.test(norm(x)))))?.[1] ?? null;

/** The most common date in a column ("attempted_on" of an exam). */
function commonDate(t: Table, h: Header, col: number, today: Date): string | null {
  if (col < 0) return null;
  const counts = new Map<string, number>();
  for (const r of t.slice(h.dataFrom)) {
    const d = parseDate(cell(r, col), today);
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const COMPLETED = /^completed$/i;

export const SOURCES: SourceSpec[] = [
  {
    id: "old_offline",
    label: "Old process offline assessment",
    key: ["User ID"],
    detect: [["User ID"], ["overall_candidate_score"], ["Bucket"]],
    assessment: () => "old_offline",
    partition: () => ({ sourceKey: "old_offline", label: "Old offline assessment" }),
    score: ["overall_candidate_score"],
    attempt: { cycle: ["Cycle"] },
    verdict: (r, h) => {
      const b = cell(r, find(h, "Bucket")).match(/bucket\s*-?\s*([a-d])\b/i);
      return { result: b ? `Bucket ${b[1].toUpperCase()}` : "", passed: null };
    },
    name: ["Student Name", "Name"],
    phone: ["Mobile Number", "Phone Number"],
    profile: { rank: 1, yog: ["YOG"], college: ["College", "College Combined"], degree: ["Bach. Degree"], department: ["Bach. Department"] },
  },
  {
    id: "competency_offline",
    label: "Competency offline exam",
    key: ["candidate_id", "user_id"],
    detect: [["candidate_id", "user_id"], ["overall_candidate_score", "Overall Score"], ["attempt_status"]],
    assessment: subjectOf(OFFLINE_SUBJECT),
    partition: (a, h, t, ctx) => {
      const today = ctx.today ?? new Date();
      const date = commonDate(t, h, find(h, "attempted_on"), today) ?? dateFromName(ctx.fileName, today) ?? (ctx.examDate && parseDate(ctx.examDate, today)) ?? null;
      if (!date) return { needsDate: true };
      return { sourceKey: `${a}@${date}`, label: `${assessmentInfo(a).label} · ${formatDate(date)}`, date };
    },
    score: ["overall_candidate_score", "Overall Score"],
    max: ["overall_total_score"],
    status: { col: ["attempt_status"], accept: /^attempted$/i },
    attempt: "single",
    // "Qualified Status" / "Qualify Status"; one export shifted it under an unnamed column — then
    // it is the cell that reads "Qualified" / "Not Qualified".
    verdict: (r, h) => {
      const i = find(h, "Qualified Status", "Qualify Status", /^qualif/);
      const v = cell(r, i) || (r.map((c) => cell([c], 0)).find((c) => /^(not\s+)?qualified$/i.test(c)) ?? "");
      return { result: v, passed: passedOf(v) };
    },
    profile: { rank: 3, yog: ["YOG"] },
  },
  {
    id: "competency_interview",
    label: "Competency interview",
    key: ["UID"],
    detect: [["UID"], [/^overall score \(out of 100\)$/], ["Template"]],
    assessment: subjectOf(INTERVIEW_SUBJECT),
    partition: (a, h) => {
      // DSA ran on two templates: "Problem 1 -Approach / - Code" (discontinued) and "Problem 1 — Easy" (DSA 2.0).
      const v1 = a === "dsa_interview" && h.cols.some((t) => t.some((x) => /^problem 1 ?- ?approach/.test(norm(x))));
      const variant = a === "dsa_interview" ? (v1 ? "v1" : "v2") : "log";
      return { sourceKey: `${a}:${variant}`, label: `${assessmentInfo(a).label}${a === "dsa_interview" ? (v1 ? " (discontinued format)" : " (DSA 2.0)") : ""}` };
    },
    score: [/^overall score \(out of 100\)$/],
    status: { col: ["Status"], accept: COMPLETED },
    attempt: "dated",
    date: ["Date"],
    verdict: (r, h) => {
      const level = cell(r, find(h, "Level", "Levels"));
      const band = cell(r, find(h, "Verdict Band"));
      const clearance = cell(r, find(h, "Clearance Status"));
      return { result: [level, band, clearance].filter(Boolean).join(" · "), passed: passedOf(clearance) };
    },
    recording: RECORDING,
    name: ["Candidate Name"],
  },
  {
    id: "bucket_b_tr1_audit",
    label: "Bucket B TR-1 (interview audit)",
    key: ["Candidate ID"],
    detect: [["Candidate ID"], [/^total \(\s*\/\s*15\s*\)$/]],
    assessment: () => "bucket_b_tr1",
    partition: () => ({ sourceKey: "bucket_b_tr1:audit", label: "Bucket B TR-1 · interview audit" }),
    score: [/^total \(\s*\/\s*15\s*\)$/],
    status: { col: ["Interview Status"], accept: COMPLETED },
    attempt: "dated",
    date: ["Interview Date"],
    verdict: joined([["Performance Band"], ["Clearance Status"]], ["Clearance Status"]),
    recording: RECORDING,
    name: ["Candidate Name"],
    phone: ["Mobile Number"],
    profile: { rank: 2, college: ["College Combined"], degree: ["Bach. Degree"], department: ["Bach. Department"] },
  },
  {
    id: "bucket_b_tr2_audit",
    label: "Bucket B TR-2 (interview audit)",
    key: ["Candidate UID"],
    detect: [["Candidate UID"], [/^total \(\s*\/\s*10\s*\)$/]],
    assessment: () => "bucket_b_tr2",
    partition: () => ({ sourceKey: "bucket_b_tr2:audit", label: "Bucket B TR-2 · interview audit" }),
    score: [/^total \(\s*\/\s*10\s*\)$/],
    status: { col: ["Interview Status"], accept: COMPLETED },
    attempt: "dated",
    date: ["interview Date"],
    verdict: joined([["Performance Band"], ["Final Status"]], ["Final Status"]),
    recording: RECORDING,
    name: ["Candidate Name"],
    profile: { rank: 2, college: ["College Combined"], degree: ["Bach. Degree"], department: ["Bach. Department"] },
  },
  {
    id: "bucket_b_tr1_app",
    label: "Bucket B TR-1 (conducted in the app)",
    key: ["UID"],
    detect: [["UID"], [/^final score \(\s*15\s*points?\s*\)$/]],
    assessment: () => "bucket_b_tr1",
    partition: () => ({ sourceKey: "bucket_b_tr1:app", label: "Bucket B TR-1 · in the app" }),
    score: [/^final score \(\s*15\s*points?\s*\)$/],
    status: { col: ["Status"], accept: COMPLETED },
    attempt: "dated",
    date: ["Date"],
    verdict: joined([["Overall Recommendation"], ["Clearance Status"]], ["Clearance Status"]),
    recording: RECORDING,
    name: ["Candidate Name"],
  },
  {
    id: "bucket_b_tr2_app",
    label: "Bucket B TR-2 (conducted in the app)",
    key: ["UID"],
    detect: [["UID"], [/^final score \(\s*10\s*\)$/]],
    assessment: () => "bucket_b_tr2",
    partition: () => ({ sourceKey: "bucket_b_tr2:app", label: "Bucket B TR-2 · in the app" }),
    score: [/^final score \(\s*10\s*\)$/],
    status: { col: ["Status"], accept: COMPLETED },
    attempt: "dated",
    date: ["Date"],
    verdict: joined([["Overall Recommendation"], ["Clearance Status"]], ["Clearance Status"]),
    recording: RECORDING,
    name: ["Candidate Name"],
  },
  {
    id: "bucket_a_tr2",
    label: "Bucket A TR-2 (external panel)",
    key: ["Candidate UID"],
    detect: [["Candidate UID"], ["Overall Score"], ["Placement Pool Eligibility"]],
    assessment: () => "bucket_a_tr2",
    partition: () => ({ sourceKey: "bucket_a_tr2:scheduled", label: "Bucket A TR-2 · external panel" }),
    score: ["Overall Score"],
    status: { col: ["Interview status"], accept: COMPLETED },
    attempt: "dated",
    date: ["Interview Date"],
    // Pool eligibility, then the panel's verdict per bucket (the sub-header under "Final Verdict By Nxtwave").
    verdict: (r, h) => {
      const pool = cell(r, find(h, "Placement Pool Eligibility"));
      const per = (
        [
          ["Frontend", "Frontend Bucket"],
          ["Backend", "Backend Bucket"],
          ["Full Stack", "Full Stack Bucket"],
        ] as const
      )
        .map(([label, col]) => {
          const v = cell(r, find(h, col));
          return v ? `${label} ${v}` : "";
        })
        .filter(Boolean);
      return { result: [pool, ...per].filter(Boolean).join(" · "), passed: passedOf(pool) };
    },
    recording: RECORDING,
    name: ["Candidate Name"],
  },
  {
    id: "bucket_a_tr1",
    label: "Bucket A TR-1 (external panel)",
    key: ["UID"],
    detect: [["UID"], [/^total score \(out of 100\)$/], ["Interview status"]],
    assessment: () => "bucket_a_tr1",
    partition: () => ({ sourceKey: "bucket_a_tr1:scheduled", label: "Bucket A TR-1 · external panel" }),
    score: [/^total score \(out of 100\)$/],
    status: { col: ["Interview status"], accept: COMPLETED },
    attempt: "dated",
    date: ["Interview Date"],
    recording: RECORDING,
    name: ["Candidate Name"],
  },
];

/** Which source a table is, from its headers (first match in SOURCES order), with its header. */
export function detectScoreSource(table: Table): { spec: SourceSpec; header: Header } | null {
  for (const spec of SOURCES) {
    const header = headerOf(table, spec.key);
    if (header && spec.detect.every((any) => find(header, ...any) >= 0)) return { spec, header };
  }
  return null;
}

/** The date column with the most readable dates (a sheet can have two "Date" columns, one of them empty). */
function bestDateColumn(t: Table, h: Header, names: Matcher[], today: Date): number {
  let best = -1;
  let bestN = -1;
  h.cols.forEach((texts, i) => {
    if (!texts.some((x) => names.some((m) => hit(x, m)))) return;
    let n = 0;
    for (const r of t.slice(h.dataFrom)) if (parseDate(cell(r, i), today)) n++;
    if (n > bestN) [best, bestN] = [i, n];
  });
  return best;
}

const cleanName = (v: string) => (/@|https?:\/\//i.test(v) ? "" : v.slice(0, 120));
const cleanText = (v: string, max: number) => v.replace(/\s+/g, " ").trim().slice(0, max);
const n2 = (v: number) => Math.round(v * 100) / 100;

/** Read one export. Never throws: an unreadable file comes back with `error` set and no rows. */
export function parseScores(table: Table, ctx: ParseContext): ParsedScores {
  const today = ctx.today ?? new Date();
  const empty: ParsedScores = {
    source: null,
    sourceLabel: "",
    assessment: null,
    sourceKey: "",
    label: "",
    rows: [],
    people: [],
    profiles: [],
    profileRank: 9,
    rowsRead: 0,
    skipped: [],
    issues: [],
    error: "",
    needsDate: false,
  };
  const found = detectScoreSource(table);
  if (!found) return { ...empty, error: "Not a known assessment export — no final-score column this app reads (overall_candidate_score, Total (/15), Overall Score …)." };
  const { spec, header: h } = found;
  const assessment = spec.assessment(h);
  const base = { ...empty, source: spec.id, sourceLabel: spec.label };
  if (!assessment) return { ...base, error: `This ${spec.label.toLowerCase()} has no subject this app knows (DSA, Frontend, Backend or Software Engineering).` };
  const part = spec.partition(assessment, h, table, ctx);
  if ("needsDate" in part) return { ...base, assessment, needsDate: true, error: "Add the exam date — it isn't in the file or its name." };

  const info = assessmentInfo(assessment);
  const i = {
    key: find(h, ...spec.key),
    score: find(h, ...spec.score),
    max: spec.max ? find(h, ...spec.max) : -1,
    status: spec.status ? find(h, ...spec.status.col) : -1,
    date: spec.date ? bestDateColumn(table, h, spec.date, today) : -1,
    cycle: typeof spec.attempt === "object" ? find(h, ...spec.attempt.cycle) : -1,
    recording: spec.recording ? find(h, ...spec.recording) : -1,
    name: spec.name ? find(h, ...spec.name) : -1,
    phone: spec.phone ? find(h, ...spec.phone) : -1,
    yog: spec.profile?.yog ? find(h, ...spec.profile.yog) : -1,
    college: spec.profile?.college ? find(h, ...spec.profile.college) : -1,
    degree: spec.profile?.degree ? find(h, ...spec.profile.degree) : -1,
    department: spec.profile?.department ? find(h, ...spec.profile.department) : -1,
  };

  const issues: ParseIssue[] = [];
  const skipped = new Map<string, number>();
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  const byKey = new Map<string, ScoreRow>();
  const people = new Map<string, PersonRow>();
  const profiles = new Map<string, ProfileRow>();
  let rowsRead = 0;

  table.slice(h.dataFrom).forEach((r, k) => {
    if (!r.some((c) => String(c ?? "").trim())) return;
    rowsRead++;
    const row = h.dataFrom + k + 1;
    const rawCell = cell(r, i.key).toLowerCase();
    const userId = rawCell.split(" ")[0];
    if (!UUID.test(userId)) {
      if (rawCell) issues.push({ row, problem: `"${rawCell.slice(0, 40)}" isn't a candidate id — skipped` });
      else skip("no candidate id");
      return;
    }
    if (rawCell !== userId) issues.push({ row, problem: `Candidate id "${rawCell.slice(0, 60)}" has extra text — read as ${userId}` });

    // Who they are (also from rows without a score — a later row may carry the name).
    const name = cleanName(cell(r, i.name));
    const phoneRaw = cell(r, i.phone);
    const phone = phoneRaw ? normalisePhone(phoneRaw) : null;
    const person = people.get(userId) ?? { userId, phone: null, name: "" };
    person.name ||= name;
    person.phone ||= phone;
    people.set(userId, person);
    if (spec.profile) {
      const yogRaw = num(cell(r, i.yog));
      const p: ProfileRow = profiles.get(userId) ?? { userId, yog: null, college: "", degree: "", department: "" };
      p.yog ??= yogRaw !== null && yogRaw >= 2000 && yogRaw <= 2100 && Number.isInteger(yogRaw) ? yogRaw : null;
      p.college ||= cleanText(cell(r, i.college), 300);
      p.degree ||= cleanText(cell(r, i.degree), 160);
      p.department ||= cleanText(cell(r, i.department), 160);
      if (p.yog !== null || p.college || p.degree || p.department) profiles.set(userId, p);
    }

    const status = cell(r, i.status);
    if (spec.status && !spec.status.accept.test(status)) {
      skip(status ? status.toLowerCase().slice(0, 40) : "no status");
      return;
    }
    const score = num(cell(r, i.score));
    if (score === null) {
      skip("no final score");
      return;
    }
    const max = num(cell(r, i.max)) ?? info.max;
    if (score < 0 || max <= 0 || score > max) {
      issues.push({ row, problem: `Score ${score} isn't between 0 and ${max} — skipped` });
      return;
    }
    const takenOn = i.date >= 0 ? parseDate(cell(r, i.date), today) : (part.date ?? null);
    const v = spec.verdict ? spec.verdict(r, h) : { result: "", passed: null };
    let attempt =
      spec.attempt === "single" ? "1" : spec.attempt === "dated" ? (takenOn ?? "undated") : cell(r, i.cycle).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "1";
    const scoreRow: ScoreRow = {
      userId,
      attempt,
      score: n2(score),
      maxScore: n2(max),
      takenOn: takenOn ?? part.date ?? null,
      result: cleanText(v.result, 160),
      passed: v.passed,
      recordingUrl: linkIn(String(r[i.recording] ?? "")),
      row,
    };
    const prev = byKey.get(`${userId}|${attempt}`);
    if (prev && spec.attempt === "single") {
      // One exam, the same person twice: keep the higher score.
      issues.push({ row, problem: `Same candidate as row ${prev.row} — kept the higher score (row ${score > prev.score ? row : prev.row})` });
      if (score > prev.score) byKey.set(`${userId}|${attempt}`, scoreRow);
      return;
    }
    if (prev) {
      // A repeat interview the same day (or both undated): its own attempt.
      let n = 2;
      while (byKey.has(`${userId}|${attempt}#${n}`)) n++;
      attempt = `${attempt}#${n}`;
    }
    byKey.set(`${userId}|${attempt}`, { ...scoreRow, attempt });
  });

  const rows = [...byKey.values()];
  if (!rows.length && !issues.length && rowsRead) issues.push({ row: 0, problem: "No row has a final score" });
  return {
    ...base,
    assessment,
    sourceKey: part.sourceKey,
    label: part.label,
    rows,
    people: [...people.values()],
    profiles: [...profiles.values()],
    profileRank: spec.profile?.rank ?? 9,
    rowsRead,
    skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    issues,
    error: rows.length ? "" : "No final scores found in this file.",
  };
}
