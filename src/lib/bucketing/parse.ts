import { normaliseMobile, parseTsv } from "@/lib/qa-parse";
import { parseCsv } from "@/lib/utils";
import {
  EXPORT_TRACK_NAME,
  TR2_VERDICTS,
  TRACKS,
  isRejectedVerdict,
  normalizeStage,
  normalizeTrack,
  normalizeVerdict,
  type Stage,
  type Track,
  type Tr2Verdict,
} from "@/lib/bucketing/config";
import type { BucketingCandidateInput, InterviewRecord, InterviewTr2 } from "@/lib/bucketing/types";

/**
 * Candidate Bucketing input.
 *
 * The dashboard reads the drive's **interview export** (candidates_all-colleges_*.csv)
 * by its column names — column order never matters — plus an optional **resume
 * sheet** (Phone Number + Resume Link, e.g. the PII sheet) matched by phone:
 *  - phone, id, name, email, college — who the candidate is;
 *  - "TR2 <track> State / Verdict" — TR-2 per track (assigned / completed; strong /
 *    medium / low hire / rejected); combinedInterview* — the combined path;
 *  - tr1Status, the tr1… ratings, dsaInterviewQualifyingStatus and the DSA-interview
 *    scores — TR-1 ("Shortlisted" = cleared);
 *  - offlineOverallScore, dsaCodingScore, csFundamentalsScore, sql…Score — the assessment;
 *  - currentStage, interviewPath, journeyStatus / Reason / Notes — where they are in the drive.
 *
 * Older sheet shapes (Number / Resume / Stage / Track columns, or header-less rows)
 * still parse for the terminal runner and old runs.
 */

export interface ParsedBucketingRow {
  /** 1-based row number in the paste / file. */
  row: number;
  preview: string;
  candidate: BucketingCandidateInput | null;
  /** Why the row can't be used ("" when valid). */
  problem: string;
  /** A note that doesn't block the row (e.g. TR-2 without a track). */
  warning: string;
}

const URL_RE = /(?:https?:\/\/|www\.)[^\s"'<>]+/i;
const PHONE_CELL_RE = /^\+?[\d\s().-]{7,20}$/;
const NAME_RE = /^[A-Za-z][A-Za-z .'-]{1,79}$/;

type Field =
  | "mobile"
  | "name"
  | "resume"
  | "stage"
  | "track"
  | "tr1"
  | "tr2"
  | "github"
  | "leetcode"
  | "codechef"
  | "codeforces";

/** Never the candidate's own number. */
const NOT_OWN_NUMBER = /\b(parent|father|mother|guardian|alternate|emergency|roll|registration|reg|enrol\w*|admission|serial|problems|solved)\b/i;
/** Columns holding a count or rating, not a profile link. */
const NOT_A_LINK_COLUMN = /\b(rating|stars?|solved|problems|score|count|rank)\b/i;

/** Header → field. The first match wins; parent / college / count columns are never the candidate's. */
const HEADER_RULES: [Field, RegExp][] = [
  ["resume", /\b(resume|cv)\b(?!.*\b(score|status)\b)/i],
  ["tr2", /\btr\s*-?\s*2\b.*\bstatus\b|\bround\s*2\b.*\bstatus\b/i],
  ["tr1", /\btr\s*-?\s*1\b.*\bstatus\b|\bround\s*1\b.*\bstatus\b/i],
  ["stage", /^(stage|final stage|highest stage|cleared stage|interview stage|status)$/i],
  ["track", /^(track|tr\s*-?\s*2\s*(domain|track|stack)|interview domain|stack|tr2 track)$/i],
  ["github", /\bgithub\b/i],
  ["leetcode", /\bleet\s*code\b/i],
  ["codechef", /\bcode\s*chef\b/i],
  ["codeforces", /\bcode\s*forces\b/i],
  ["name", /^(?!.*\b(parent|father|mother|college|course|school|sc|company|placement)\b)(student |candidate |full )?name$/i],
];

/** The interview export's own columns: key → [squeezed header, header as the export writes it]. */
const INTERVIEW_COLS = {
  exportId: ["id", "id"],
  email: ["email", "email"],
  college: ["college", "college"],
  currentStage: ["currentstage", "currentStage"],
  interviewPath: ["interviewpath", "interviewPath"],
  journeyStatus: ["journeystatus", "journeyStatus"],
  journeyReason: ["journeyreason", "journeyReason"],
  journeyNotes: ["journeynotes", "journeyNotes"],
  offlineOverall: ["offlineoverallscore", "offlineOverallScore"],
  dsaCoding: ["dsacodingscore", "dsaCodingScore"],
  csFundamentals: ["csfundamentalsscore", "csFundamentalsScore"],
  sqlMcq: ["sqlmcqscore", "sqlMcqScore"],
  sqlCoding: ["sqlcodingscore", "sqlCodingScore"],
  dsaQualifying: ["dsainterviewqualifyingstatus", "dsaInterviewQualifyingStatus"],
  dsaInterviewDsa: ["dsainterviewdsascore", "dsaInterviewDsaScore"],
  dsaInterviewCs: ["dsainterviewcsscore", "dsaInterviewCsScore"],
  tr1Status: ["tr1status", "tr1Status"],
  selfIntro: ["tr1selfintrorating", "tr1SelfIntroRating"],
  dsaOverall: ["tr1dsaoverallrating", "tr1DsaOverallRating"],
  problemSolving: ["tr1problemsolvingability", "tr1ProblemSolvingAbility"],
  coding: ["tr1codingskills", "tr1CodingSkills"],
  communication: ["tr1communicationandcollaboration", "tr1CommunicationAndCollaboration"],
  debugging: ["tr1debugginganditeration", "tr1DebuggingAndIteration"],
  overallTechnical: ["tr1overalltechnicalscore", "tr1OverallTechnicalScore"],
  combined: ["combinedinterviewverdict", "combinedInterviewVerdict"],
  combinedState: ["combinedinterviewstate", "combinedInterviewState"],
} as const;
type InterviewCol = keyof typeof INTERVIEW_COLS;
/** Identity columns — present in many sheets, so they never make a sheet look like the interview export. */
const IDENTITY_COLS: ReadonlySet<InterviewCol> = new Set(["exportId", "email", "college"]);

interface HeaderMap {
  at: number;
  fields: Partial<Record<Field, number>>;
  interview: Partial<Record<InterviewCol, number>>;
  /** "TR2 <track> Verdict" columns. */
  verdicts: { track: Track; col: number }[];
  /** "TR2 <track> State" columns. */
  states: { track: Track; col: number }[];
}

/** CSV (a downloaded file) or tab-separated rows (copied from the sheet), detected from the first line. */
function readRows(textIn: string, csv?: boolean): string[][] {
  const firstLine = textIn.split(/\r?\n/, 1)[0] ?? "";
  const tsv = csv === undefined ? firstLine.includes("\t") : !csv;
  return (tsv ? parseTsv(textIn) : parseCsv(textIn)).filter((r) => r.some((c) => c.trim()));
}

const squeeze = (h: string) => h.toLowerCase().replace(/\(read-only\)/g, "").replace(/[^a-z0-9]/g, "");

function mapHeader(cells: string[], at: number): HeaderMap {
  const fields: Partial<Record<Field, number>> = {};
  const interview: Partial<Record<InterviewCol, number>> = {};
  const verdicts: HeaderMap["verdicts"] = [];
  const states: HeaderMap["states"] = [];
  // The candidate's own phone first ("Phone Number"), a bare "Number" / UUID only as a fallback.
  const phone = cells.findIndex((c) => /\b(mobile|phone|whatsapp|contact number)\b/i.test(c) && !NOT_OWN_NUMBER.test(c));
  const fallback = cells.findIndex((c) => /\b(number|uuid)\b/i.test(c) && !NOT_OWN_NUMBER.test(c) && c.trim().length <= 40);
  if (phone >= 0) fields.mobile = phone;
  else if (fallback >= 0) fields.mobile = fallback;
  cells.forEach((raw, i) => {
    const h = raw.replace(/\s+/g, " ").trim();
    if (!h || h.length > 80 || i === fields.mobile) return;
    const tr2 = h.match(/^tr\s*-?\s*2\s+(.+?)\s+(verdict|state)$/i);
    if (tr2) {
      const track = normalizeTrack(tr2[1]);
      if (track) (tr2[2].toLowerCase() === "verdict" ? verdicts : states).push({ track, col: i });
      return;
    }
    const sq = squeeze(h);
    const ic = (Object.keys(INTERVIEW_COLS) as InterviewCol[]).find((k) => INTERVIEW_COLS[k][0] === sq);
    if (ic) {
      if (interview[ic] === undefined) interview[ic] = i;
      return;
    }
    const hit = HEADER_RULES.find(([field, re]) => fields[field] === undefined && re.test(h));
    if (!hit) return;
    if (["github", "leetcode", "codechef", "codeforces"].includes(hit[0]) && NOT_A_LINK_COLUMN.test(h)) return;
    fields[hit[0]] = i;
  });
  return { at, fields, interview, verdicts, states };
}

/** The interview export: TR-2 columns, or at least three of its interview / score columns. */
function isInterviewHeader(m: HeaderMap): boolean {
  const signal = (Object.keys(m.interview) as InterviewCol[]).filter((k) => !IDENTITY_COLS.has(k)).length;
  return m.verdicts.length > 0 || signal >= 3;
}

/** A header row names a mobile column and either a resume column or interview columns. */
function findHeader(rows: string[][]): HeaderMap | null {
  for (let i = 0; i < Math.min(rows.length, 4); i++) {
    const m = mapHeader(rows[i], i);
    if (m.fields.mobile !== undefined && (m.fields.resume !== undefined || isInterviewHeader(m))) return m;
  }
  return null;
}

// ── Column check (shown before a run) ───────────────────────────────────────

export interface ColumnGroup {
  label: string;
  found: number;
  total: number;
  /** Headers the export should have but doesn't. */
  missing: string[];
}

export interface ExportCheck {
  /** Usable: a phone column and interview columns. */
  ok: boolean;
  /** Why it can't be used ("" when ok). */
  error: string;
  /** Data rows (header excluded). */
  rows: number;
  groups: ColumnGroup[];
  /** A resume column inside the export itself. */
  hasResumeColumn: boolean;
}

const EXPORT_GROUPS: { label: string; cols: InterviewCol[] | "verdicts" | "states" }[] = [
  { label: "Identity (id, email, college)", cols: ["exportId", "email", "college"] },
  { label: "TR-2 verdicts", cols: "verdicts" },
  { label: "TR-2 states", cols: "states" },
  { label: "Combined interview", cols: ["combined", "combinedState", "interviewPath"] },
  {
    label: "TR-1 (DSA interview)",
    cols: ["tr1Status", "selfIntro", "dsaOverall", "problemSolving", "coding", "communication", "debugging", "overallTechnical", "dsaQualifying", "dsaInterviewDsa", "dsaInterviewCs"],
  },
  { label: "Assessment", cols: ["offlineOverall", "dsaCoding", "csFundamentals", "sqlMcq", "sqlCoding"] },
  { label: "Drive status", cols: ["currentStage", "journeyStatus", "journeyReason", "journeyNotes"] },
];

/** Which of the interview export's columns a file / paste has — the dashboard's pre-run check. */
export function inspectInterviewExport(textIn: string, csv?: boolean): ExportCheck {
  const rows = readRows(textIn, csv);
  const header = findHeader(rows);
  const empty: ExportCheck = { ok: false, error: "", rows: 0, groups: [], hasResumeColumn: false };
  if (!rows.length) return { ...empty, error: "The file is empty." };
  if (!header || !isInterviewHeader(header)) {
    return {
      ...empty,
      error:
        "This isn't the interview export: expected its header row (id, name, email, phone, college … tr1Status … TR2 <track> State / Verdict) with a phone column. Upload the CSV, or copy the rows together with the header row.",
    };
  }
  const groups: ColumnGroup[] = EXPORT_GROUPS.map(({ label, cols }) => {
    if (cols === "verdicts" || cols === "states") {
      const have = new Set((cols === "verdicts" ? header.verdicts : header.states).map((v) => v.track));
      const suffix = cols === "verdicts" ? "Verdict" : "State";
      return {
        label,
        found: have.size,
        total: TRACKS.length,
        missing: TRACKS.filter((t) => !have.has(t)).map((t) => `TR2 ${EXPORT_TRACK_NAME[t]} ${suffix}`),
      };
    }
    const missing = cols.filter((k) => header.interview[k] === undefined).map((k) => INTERVIEW_COLS[k][1]);
    return { label, found: cols.length - missing.length, total: cols.length, missing };
  });
  return { ok: true, error: "", rows: rows.length - header.at - 1, groups, hasResumeColumn: header.fields.resume !== undefined };
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

/** A profile cell: a link, or a handle — never a bare number (a rating / count column). */
const profileValue = (v: string) => (v && !/^[\d.\s,]+$/.test(v) && !/\s/.test(v.trim()) ? v.trim() : "");

const num = (v: string): number | null => {
  const t = (v ?? "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** A short free-text cell, cleaned (no control characters, bounded). */
const text = (v: string, max = 120) => (v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const VERDICT_RANK: Record<Tr2Verdict, number> = Object.fromEntries(TR2_VERDICTS.map((v, i) => [v, i])) as Record<Tr2Verdict, number>;

/**
 * The interview columns of one row → the record, plus the stage / track / verdict they imply:
 *  - TR-2: a hire verdict in any track (best first), or a combined-interview hire (no track);
 *  - TR-1: the DSA interview shortlisted them (dsaInterviewQualifyingStatus / currentStage
 *    resume_based_interview / tr1Status pass) — a TR-2 assignment or rejection implies it too;
 *  - otherwise Assessment (everyone in the export cleared it).
 */
function readInterview(cells: string[], m: HeaderMap): { record: InterviewRecord; stage: Stage; track: Track | null; verdict: Tr2Verdict | null } {
  const at = (k: InterviewCol) => (m.interview[k] !== undefined ? (cells[m.interview[k]!] ?? "").trim() : "");
  const tr2: InterviewTr2[] = [];
  const tr2Rejected: Track[] = [];
  const decided = new Set<Track>();
  for (const { track, col } of m.verdicts) {
    const raw = (cells[col] ?? "").trim();
    const verdict = normalizeVerdict(raw);
    if (verdict) tr2.push({ track, verdict });
    else if (raw && isRejectedVerdict(raw)) tr2Rejected.push(track);
    if (raw) decided.add(track);
  }
  tr2.sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict]);
  // Assigned (or any state short of completed) with no verdict yet = pending.
  const tr2Pending = m.states
    .filter(({ track, col }) => {
      const st = (cells[col] ?? "").trim().toLowerCase();
      return st && st !== "completed" && !decided.has(track);
    })
    .map((s) => s.track);
  const combinedRaw = at("combined");
  const combined = normalizeVerdict(combinedRaw);
  const record: InterviewRecord = {
    tr2,
    tr2Rejected,
    tr2Pending,
    combined,
    combinedRejected: !combined && Boolean(combinedRaw) && isRejectedVerdict(combinedRaw),
    combinedState: at("combinedState").toLowerCase(),
    interviewPath: at("interviewPath").toLowerCase(),
    currentStage: at("currentStage").toLowerCase(),
    dsaInterview: {
      qualifying: at("dsaQualifying").toLowerCase(),
      dsaScore: num(at("dsaInterviewDsa")),
      csScore: num(at("dsaInterviewCs")),
    },
    journey: { status: at("journeyStatus").toLowerCase(), reason: text(at("journeyReason"), 60), notes: text(at("journeyNotes"), 200) },
    tr1: {
      status: at("tr1Status").toLowerCase(),
      selfIntro: num(at("selfIntro")),
      dsaOverall: num(at("dsaOverall")),
      problemSolving: num(at("problemSolving")),
      coding: num(at("coding")),
      communication: num(at("communication")),
      debugging: num(at("debugging")),
      overallTechnical: num(at("overallTechnical")),
    },
    assessment: {
      offlineOverall: num(at("offlineOverall")),
      dsaCoding: num(at("dsaCoding")),
      csFundamentals: num(at("csFundamentals")),
      sqlMcq: num(at("sqlMcq")),
      sqlCoding: num(at("sqlCoding")),
    },
  };
  if (tr2.length) return { record, stage: "TR2", track: tr2[0].track, verdict: tr2[0].verdict };
  if (combined) return { record, stage: "TR2", track: null, verdict: combined };
  const tr1Cleared =
    record.dsaInterview?.qualifying === "shortlisted" ||
    record.currentStage === "resume_based_interview" ||
    /^pass/.test(record.tr1.status) ||
    tr2Rejected.length > 0 ||
    tr2Pending.length > 0;
  return { record, stage: tr1Cleared ? "TR1" : "ASSESSMENT", track: null, verdict: null };
}

// ── Resume sheet ─────────────────────────────────────────────────────────────

export interface ResumeSheetRow {
  resumeUrl: string;
  name: string;
  github?: string;
  leetcode?: string;
  codechef?: string;
  codeforces?: string;
}

export interface ResumeSheet {
  /** mobile → resume and profile links. */
  links: Map<string, ResumeSheetRow>;
  /** Why the file can't be used ("" when it can). */
  error: string;
  /** Data rows read. */
  rows: number;
}

/**
 * A resume sheet (e.g. the PII sheet: Phone Number + Resume Link) → mobile → resume,
 * matched to the interview export by phone. "Roll Number" is never read as the phone.
 */
export function readResumeSheet(textIn: string, csv?: boolean): ResumeSheet {
  const rows = readRows(textIn, csv);
  const links = new Map<string, ResumeSheetRow>();
  for (let i = 0; i < Math.min(rows.length, 4); i++) {
    const m = mapHeader(rows[i], i);
    if (m.fields.mobile === undefined || m.fields.resume === undefined) continue;
    const at = (cells: string[], f: Field) => (m.fields[f] !== undefined ? (cells[m.fields[f]!] ?? "").trim() : "");
    for (const cells of rows.slice(i + 1)) {
      const id = normaliseMobile(at(cells, "mobile"));
      const resumeUrl = linkFrom(at(cells, "resume"));
      if (!id || id.length < 10 || !resumeUrl || links.has(id)) continue;
      links.set(id, {
        resumeUrl,
        name: at(cells, "name"),
        github: profileValue(at(cells, "github")) || undefined,
        leetcode: profileValue(at(cells, "leetcode")) || undefined,
        codechef: profileValue(at(cells, "codechef")) || undefined,
        codeforces: profileValue(at(cells, "codeforces")) || undefined,
      });
    }
    return { links, error: links.size ? "" : "The sheet has Phone and Resume columns but no resume links in them.", rows: rows.length - i - 1 };
  }
  return { links, error: rows.length ? "No Phone Number + Resume Link columns found in this sheet." : "The file is empty.", rows: 0 };
}

/** @deprecated use readResumeSheet — kept for the terminal runner. */
export function parseResumeSheet(textIn: string, csv?: boolean): Map<string, ResumeSheetRow> {
  return readResumeSheet(textIn, csv).links;
}

// ── Rows → candidates ────────────────────────────────────────────────────────

/**
 * Parse an uploaded CSV (or pasted rows).
 * @param existing mobile numbers already in the run → the batch they came in (skipped).
 * @param resumes a resume sheet matched by phone (fills rows that have no resume link).
 * @param requireExport only the interview export is accepted (the dashboard's upload).
 */
export function parseBucketingInput(
  textIn: string,
  opts: {
    batch: number;
    existing: Map<string, number>;
    defaultStage: Stage;
    csv?: boolean;
    resumes?: Map<string, ResumeSheetRow>;
    requireExport?: boolean;
  },
): ParsedBucketingRow[] {
  const rows = (
    opts.csv
      ? parseCsv(textIn)
      : textIn.includes("\t")
        ? parseTsv(textIn)
        : textIn
            .split(/\r?\n/)
            .filter((l) => l.trim())
            .map((l) => l.split(/\s*[,;|]\s*|\s{2,}/))
  ).filter((r) => r.some((c) => c.trim()));
  const header = findHeader(rows);
  const interviewSheet = Boolean(header && isInterviewHeader(header));
  if (opts.requireExport && !interviewSheet) {
    return [{ row: 1, preview: preview(rows[0] ?? []), candidate: null, problem: "Not the interview export (no phone + interview columns)", warning: "" }];
  }
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
    let verdict: Tr2Verdict | null = null;
    let interview: InterviewRecord | undefined;
    let trackRaw = "";
    let externalId = "";
    let email = "";
    let college = "";
    const links: Partial<Record<"github" | "leetcode" | "codechef" | "codeforces", string>> = {};

    if (header) {
      const m = header.fields;
      const at = (f: Field) => (m[f] !== undefined ? (cells[m[f]!] ?? "").trim() : "");
      mobileCell = at("mobile");
      resumeCell = at("resume");
      name = at("name");
      if (interviewSheet) {
        const iv = readInterview(cells, header);
        interview = iv.record;
        stage = iv.stage;
        track = iv.track;
        verdict = iv.verdict;
        const ic = (k: InterviewCol) => (header.interview[k] !== undefined ? (cells[header.interview[k]!] ?? "").trim() : "");
        externalId = text(ic("exportId"), 64);
        email = text(ic("email"), 120);
        college = text(ic("college"), 160);
      }
      if (!stage && m.stage !== undefined) stage = normalizeStage(at("stage"));
      if (!stage && (m.tr1 !== undefined || m.tr2 !== undefined)) {
        stage = cleared(at("tr2")) ? "TR2" : cleared(at("tr1")) ? "TR1" : null;
      }
      if (!track && m.track !== undefined) {
        trackRaw = at("track");
        track = normalizeTrack(trackRaw);
      }
      for (const k of ["github", "leetcode", "codechef", "codeforces"] as const) {
        const v = profileValue(at(k));
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
        else if (!verdict && normalizeVerdict(c)) verdict = normalizeVerdict(c);
        else if (!track && normalizeTrack(c) && c.length <= 30) {
          track = normalizeTrack(c);
          trackRaw = c;
        } else if (!name && NAME_RE.test(c)) name = c;
      }
      if (verdict && !stage) stage = "TR2";
    }

    const id = normaliseMobile(mobileCell);
    if (!id || id.length < 10) {
      out.push({ ...base, candidate: null, problem: "No phone number in this row" });
      return;
    }
    const prior = opts.existing.get(id);
    if (prior !== undefined) {
      out.push({ ...base, candidate: null, problem: `Already added in batch ${prior}` });
      return;
    }
    const first = seen.get(id);
    if (first !== undefined) {
      out.push({ ...base, candidate: null, problem: `Duplicate phone — same as row ${first}` });
      return;
    }
    seen.set(id, row);

    // The resume sheet fills what this sheet doesn't have.
    const extra = opts.resumes?.get(id);
    const resumeUrl = linkFrom(resumeCell) || extra?.resumeUrl || "";
    if (!name && extra?.name) name = extra.name;
    for (const k of ["github", "leetcode", "codechef", "codeforces"] as const) if (!links[k] && extra?.[k]) links[k] = extra[k];

    const finalStage = stage ?? opts.defaultStage;
    const cleanName = text(name, 80);
    const candidate: BucketingCandidateInput = {
      id,
      mobile: id,
      // The export's names are the platform's own (any script); loose sheets need the stricter check.
      name: interviewSheet ? cleanName : NAME_RE.test(cleanName) ? cleanName : "",
      resumeUrl,
      stage: finalStage,
      track: finalStage === "TR2" ? track : null,
      verdict: finalStage === "TR2" ? verdict : null,
      interview,
      ...(externalId ? { externalId } : {}),
      ...(email ? { email } : {}),
      ...(college ? { college } : {}),
      githubUrl: links.github,
      leetcodeUrl: links.leetcode,
      codechefUrl: links.codechef,
      codeforcesUrl: links.codeforces,
      batch: opts.batch,
    };
    const warning =
      finalStage === "TR2" && !track && !interview
        ? trackRaw
          ? `TR-2 track "${trackRaw}" not recognised — the TR-2 rule won't apply`
          : "TR-2 cleared with no track — the TR-2 rule won't apply"
        : "";
    out.push({ ...base, warning, problem: "", candidate });
  });
  return out;
}
