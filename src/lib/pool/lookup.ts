import { isAssessed, standingFor } from "@/lib/pool/match";
import { normalisePhone, normaliseUserId } from "@/lib/pool/parse";
import {
  JOB_ELIGIBILITY_LABEL,
  assessmentInfo,
  type AssessmentKey,
  type AssessmentScore,
  type CandidateProfile,
  type JobEligibility,
  type PersonRef,
} from "@/lib/pool/scores/catalogue";
import { formatDate } from "@/lib/pool/scores/parse";
import {
  COMPETENCY_LABEL,
  PRODUCT_LABEL,
  STAGE_SHORT,
  TR2_TRACK_LABEL,
  VERDICT_LABEL,
  type AcademyRecord,
  type CandidateStanding,
  type CompetencySubject,
  type InternalStanding,
  type PersonRecords,
  type Product,
  type Tier,
} from "@/lib/pool/types";

/**
 * Standing lookup — internal standings for pasted UUIDs / phone numbers, from the eligible
 * pool (the Edge 2.0, Edge 1.0 and Academy assessments; never a resume), with the details
 * picked: candidate details, the Edge / Academy results, and the final MARKS of the Academy
 * exams and interviews. Pure and client-safe; tested in scripts/standing-lookup-selftest.ts.
 *
 * Output: UUID (+ Phone when phones were pasted), Internal Standing, Internal Stage, Internal
 * Product — the same three values Domain shortlisting exports — and Job Eligibility (Eligible =
 * in the eligible pool with an eligible standing; Not eligible = assessed but not in the pool, or
 * not cleared), then
 *  - the picked text details: ONE "Requirements" column holding only the items the candidate has
 *    a result for, or one column per item;
 *  - the picked marks, ALWAYS in columns of their own: "DSA offline exam (130)" holds only the
 *    marks obtained (a number), and the verdict, date and recording link — when asked for — each
 *    get their own column beside it.
 * People with Academy marks who aren't in the eligible pool are found too: their standing reads
 * "Assessed · not in the eligible pool", and they are Not eligible.
 * Rows keep the pasted order (blank lines too), so the result pastes back beside the source.
 */

/** The lookup endpoint's cap per request. */
export const MAX_LOOKUP_ROWS = 20_000;

// ── The three standing columns (shared with Domain shortlisting's CSVs) ─────────

export const STANDING_HEADERS = ["Internal Standing", "Internal Stage", "Internal Product"] as const;
/** The lookup's own tag after them: whether the person can be put forward for job opportunities. */
export const JOB_ELIGIBILITY_HEADER = "Job Eligibility";
/** Internal Standing of someone with marks who isn't in the eligible pool. */
export const ASSESSED_ONLY = "Assessed · not in the eligible pool";

/**
 * Internal Standing / Stage / Product (and how the person was matched) for one standing.
 * Not in the pool = "External" — or "Not checked" when the pool wasn't looked up at all.
 */
export function internalColumns(st: InternalStanding | null | undefined, poolChecked: boolean): Record<string, string> {
  if (st) {
    const s = st as InternalStanding;
    const label = s.label;
    return {
      "Matched In Pool By": s.matchedBy === "phone" ? "Phone" : "User ID",
      "Internal Standing": isAssessed(s) ? label : `${label} (not eligible)`,
      "Internal Stage": STAGE_SHORT[s.tier],
      "Internal Product": PRODUCT_LABEL[s.product],
    };
  }
  return { "Internal Standing": poolChecked ? "External" : "Not checked" };
}

// ── Reading the paste ─────────────────────────────────────────────────────────

export interface LookupInputRow {
  /** 1-based line in the paste. */
  line: number;
  phone: string | null;
  userId: string | null;
  /** "blank" keeps a blank line's place; "unrecognised" = text with no UUID or phone number. */
  problem: "" | "blank" | "unrecognised";
  /** The line as pasted (trimmed, for messages). */
  raw: string;
}

export interface LookupInput {
  rows: LookupInputRow[];
  /** The first line was a header ("UUID", "Phone" …) and was left out. */
  headerSkipped: boolean;
  /** Lines past MAX_LOOKUP_ROWS (not read). */
  overflow: number;
  counts: { ids: number; userIds: number; phones: number; unrecognised: number; duplicates: number };
}

const PHONE_SHAPE = /^\+?[\d\s().-]{10,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADER_WORD = /\b(uuid|uid|user ?id|id|phone|mobile|contact|number|name)\b/i;

/** One pasted cell as a phone number or a user id (UUID / numeric id), or neither. */
export function classifyCell(cell: string): { phone: string } | { userId: string } | null {
  const v = cell.trim().replace(/^["']|["']$/g, "");
  if (!v) return null;
  if (PHONE_SHAPE.test(v)) {
    const p = normalisePhone(v);
    if (p) return { phone: p };
  }
  if (UUID.test(v)) return { userId: v.toLowerCase() };
  // Digits that aren't a valid phone number are most likely a mistyped one — not an id.
  if (/^[+\d\s().-]+$/.test(v)) return null;
  // A user id: a UUID (every id in the pool is one), or another id of 6+ letters and digits —
  // never a plain word ("Name", "Cleared").
  const u = normaliseUserId(v);
  if (u && u.length >= 6 && /\d/.test(u) && /[a-z]/.test(u)) return { userId: u };
  return null;
}

/**
 * The pasted text as rows: one line each, cells split on tabs or commas (a row copied from a
 * sheet can carry a UUID and a phone number). Every line keeps its place — blank and
 * unrecognised ones too — so the output lines up with the source when pasted back.
 */
export function parseLookupInput(text: string): LookupInput {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const rows: LookupInputRow[] = [];
  let headerSkipped = false;
  let overflow = 0;
  lines.forEach((rawLine, i) => {
    const raw = rawLine.trim();
    const cells = rawLine.split(/[\t,;]/);
    let phone: string | null = null;
    let userId: string | null = null;
    for (const cell of cells) {
      const c = classifyCell(cell);
      if (c && "phone" in c) phone ??= c.phone;
      else if (c) userId ??= c.userId;
    }
    if (!rows.length && !headerSkipped && !phone && !userId && raw && HEADER_WORD.test(raw)) {
      headerSkipped = true;
      return;
    }
    if (rows.length >= MAX_LOOKUP_ROWS) {
      overflow++;
      return;
    }
    rows.push({ line: i + 1, phone, userId, problem: !raw ? "blank" : phone || userId ? "" : "unrecognised", raw: raw.slice(0, 120) });
  });
  const keys = rows.filter((r) => !r.problem).map((r) => (r.phone ? `p:${r.phone}` : `u:${r.userId}`));
  return {
    rows,
    headerSkipped,
    overflow,
    counts: {
      ids: keys.length,
      userIds: rows.filter((r) => r.userId).length,
      phones: rows.filter((r) => r.phone).length,
      unrecognised: rows.filter((r) => r.problem === "unrecognised").length,
      duplicates: keys.length - new Set(keys).size,
    },
  };
}

// ── What can be added ─────────────────────────────────────────────────────────

export type RequirementGroup = "candidate" | "exams" | "competency" | "bucket" | "academy" | "edge2" | "edge1";
export const REQUIREMENT_GROUPS: { group: RequirementGroup; label: string; hint?: string }[] = [
  { group: "candidate", label: "Candidate" },
  { group: "exams", label: "Offline exams", hint: "Academy · marks" },
  { group: "competency", label: "Competency interviews", hint: "Academy · marks" },
  { group: "bucket", label: "Bucket interviews", hint: "Academy TR-1 / TR-2 · marks" },
  { group: "academy", label: "Academy pool" },
  { group: "edge2", label: "Edge 2.0" },
  { group: "edge1", label: "Edge 1.0" },
];
/** The groups whose items are marks (each gets columns of its own). */
export const MARK_GROUPS: RequirementGroup[] = ["exams", "competency", "bucket"];

/** What a lookup fetches besides the standings: products' records, the marks, the profile. */
export type LookupInclude = Product | "scores" | "profile";
const INCLUDE_ORDER: LookupInclude[] = ["edge2", "edge1", "academy", "scores", "profile"];

/** Which attempt of a repeated exam / interview to show. */
export type AttemptChoice = "best" | "latest" | "all";
/** The text details: "cell" = one Requirements column; "columns" = one column per item. */
export type LookupLayout = "cell" | "columns";
export interface LookupOptions {
  attempts: AttemptChoice;
  layout: LookupLayout;
  /** Columns beside each mark. */
  verdict: boolean;
  date: boolean;
  recording: boolean;
}
export const DEFAULT_LOOKUP_OPTIONS: LookupOptions = { attempts: "best", layout: "cell", verdict: true, date: false, recording: true };

/**
 * A matched person: the best standing (null for someone assessed who isn't in the eligible pool),
 * every product's standing, and the details asked for.
 */
export interface MatchedPerson {
  standing: CandidateStanding | null;
  /** The name when there is no standing (the database's). */
  name?: string;
  records: PersonRecords;
  /** Every stored final score, oldest first. */
  scores?: AssessmentScore[];
  profile?: CandidateProfile | null;
}

/** A text detail: one line in the Requirements cell, or one column. */
export interface Requirement {
  key: string;
  group: RequirementGroup;
  /** The chip's label. */
  label: string;
  /** How the item reads in the Requirements cell ("Edge 2.0 TR-1: …") and its column header. */
  cellLabel: string;
  /** The data it reads (none = the standing alone). */
  needs: LookupInclude[];
  /** The candidate's result, or "" when they have none (the item is then skipped). */
  value: (p: MatchedPerson) => string;
}

/** One attempt at an exam or interview, as the lookup shows it. */
export interface Attempt {
  /** Marks obtained; null when only a verdict is known (an older pool-sheet tag). */
  score: number | null;
  max: number | null;
  takenOn: string | null;
  /** "Cycle 4" for the old offline assessment, which has a cycle instead of a date. */
  when: string;
  verdict: string;
  recordingUrl: string | null;
}

/** A mark: an exam or interview whose final score gets columns of its own. */
export interface MarkItem {
  key: string;
  group: RequirementGroup;
  /** The chip's label (short; the group says the rest). */
  label: string;
  /** The column headers' name: "DSA offline exam". */
  name: string;
  /** The usual maximum, for the header ("DSA offline exam (130)"); null when the sheet doesn't say. */
  max: number | null;
  kind: "exam" | "interview" | "scores";
  needs: LookupInclude[];
  /** Every attempt, oldest first. For a fixed score set ("scores"), one entry per column of `fixed`. */
  attempts: (p: MatchedPerson) => Attempt[];
  /** A fixed set of scores, one column each (Edge 2.0's assessment scores, TR-1 ratings). */
  fixed?: { name: string; max: number }[];
}

/** 7, 7.5, 86.25 — no trailing zeros. */
const n = (v: number) => String(Math.round(v * 100) / 100);

// ── Marks ──────────────────────────────────────────────────────────────────

const dated = (a: Attempt) => a.takenOn ?? "";

/** The attempts to show: the best (ties: the latest), the latest, or all of them (oldest first). */
export function chooseAttempts(xs: Attempt[], choice: AttemptChoice): Attempt[] {
  if (!xs.length) return [];
  if (choice === "all") return [...xs].sort((a, b) => dated(a).localeCompare(dated(b)));
  if (choice === "latest") return [xs.reduce((a, b) => (dated(b) >= dated(a) ? b : a))];
  const s = (a: Attempt) => a.score ?? -1;
  return [xs.reduce((a, b) => (s(b) > s(a) || (s(b) === s(a) && dated(b) >= dated(a)) ? b : a))];
}

/**
 * A person's stored attempts at an assessment. The same interview can be logged in two sheets
 * (the audit sheet and the in-app one): an attempt with the same date and score is counted once.
 */
function stored(p: MatchedPerson, key: AssessmentKey): Attempt[] {
  const byId = new Map<string, Attempt>();
  for (const s of p.scores ?? []) {
    if (s.assessment !== key) continue;
    const id = s.takenOn ? `${s.takenOn}|${s.score}|${s.maxScore}` : `${s.sourceKey}|${s.attempt}`;
    const twin = byId.get(id);
    if (twin) {
      // The second copy fills what the first lacks (a recording, a verdict).
      twin.recordingUrl ??= s.recordingUrl;
      twin.verdict ||= s.result;
      continue;
    }
    byId.set(id, {
      score: s.score,
      max: s.maxScore,
      takenOn: s.takenOn,
      when: s.takenOn ? formatDate(s.takenOn) : /^cycle-/.test(s.attempt) ? `Cycle ${s.attempt.slice(6)}` : "",
      verdict: s.result,
      recordingUrl: s.recordingUrl,
    });
  }
  return [...byId.values()];
}

const tagOnly = (verdict: string): Attempt[] => (verdict ? [{ score: null, max: null, takenOn: null, when: "", verdict, recordingUrl: null }] : []);

/**
 * The Academy pool sheet's own result for an interview round (score + status). It fills in when
 * no interview sheet has the round (e.g. Bucket C, or Bucket A TR-1 interviews not in the external
 * panel's sheet), and gives the verdict of the latest attempt when its sheet has none.
 */
function poolRound(a: AcademyRecord | undefined, bucket: "A" | "B" | "C", round: 1 | 2, max: number | null): Attempt | null {
  const r = a?.rounds.find((x) => x.bucket === bucket && x.round === round);
  if (!r) return null;
  return { score: r.score, max, takenOn: null, when: "", verdict: r.status || (r.cleared ? "Cleared" : "Not cleared"), recordingUrl: null };
}

function exam(key: AssessmentKey, label: string, fallback?: (a: AcademyRecord | undefined) => Attempt[]): MarkItem {
  const info = assessmentInfo(key);
  return {
    key: `marks.${key}`,
    group: "exams",
    label,
    name: info.label,
    max: info.max,
    kind: "exam",
    needs: ["scores", "academy"],
    attempts: (p) => {
      const xs = stored(p, key);
      return xs.length ? xs : (fallback?.(p.records.academy) ?? []);
    },
  };
}

function competencyInterview(subject: CompetencySubject): MarkItem {
  const key = `${subject}_interview` as AssessmentKey;
  const info = assessmentInfo(key);
  return {
    key: `marks.${key}`,
    group: "competency",
    label: COMPETENCY_LABEL[subject],
    name: info.label,
    max: info.max,
    kind: "interview",
    needs: ["scores", "academy"],
    attempts: (p) => {
      const xs = stored(p, key);
      if (xs.length) return xs;
      // Not in the interview sheet: the pool sheet's competency result.
      const c = p.records.academy?.competency.find((x) => x.subject === subject);
      if (!c) return [];
      const level = c.levelLabel || (c.level !== null ? (c.level === 0 ? "Below L1" : `L${c.level}`) : "");
      const verdict = [level, c.verdictBand, c.clearanceStatus].filter(Boolean).join(" · ");
      return c.overallScore !== null || verdict ? [{ score: c.overallScore, max: 100, takenOn: null, when: "", verdict, recordingUrl: null }] : [];
    },
  };
}

function bucketRound(bucket: "A" | "B" | "C", round: 1 | 2): MarkItem {
  const key = `bucket_${bucket.toLowerCase()}_tr${round}` as AssessmentKey;
  const known = bucket !== "C";
  const max = known ? assessmentInfo(key).max : null;
  return {
    key: `marks.bucket_${bucket.toLowerCase()}_tr${round}`,
    group: "bucket",
    label: `Bucket ${bucket} TR-${round}`,
    name: `Bucket ${bucket} TR-${round}`,
    max,
    kind: "interview",
    needs: ["scores", "academy"],
    attempts: (p) => {
      const pool = poolRound(p.records.academy, bucket, round, max);
      const xs = known ? stored(p, key) : [];
      if (!xs.length) return pool ? [pool] : [];
      const latest = chooseAttempts(xs, "latest")[0];
      if (!latest.verdict && pool?.verdict) latest.verdict = pool.verdict;
      return xs;
    },
  };
}

/** Edge 2.0's own scores: a fixed set of columns, read from the product record. */
function edgeScores(key: string, label: string, cols: { name: string; max: number; value: (r: NonNullable<PersonRecords["edge2"]>) => number | null }[]): MarkItem {
  return {
    key,
    group: "edge2",
    label,
    name: label,
    max: null,
    kind: "scores",
    needs: ["edge2"],
    fixed: cols.map(({ name, max }) => ({ name, max })),
    attempts: ({ records }) => {
      const r = records.edge2;
      return r ? cols.map((c) => ({ score: c.value(r), max: c.max, takenOn: null, when: "", verdict: "", recordingUrl: null })) : [];
    },
  };
}

/** Every mark, in column order. */
export const MARK_ITEMS: MarkItem[] = [
  exam("old_offline", "Old process", (a) => tagOnly(a?.oldBucket ? `Bucket ${a.oldBucket}` : "")),
  exam("dsa_offline", "DSA", (a) => tagOnly(a?.dsaOfflineStatus ?? "")),
  exam("frontend_offline", "Frontend"),
  exam("backend_offline", "Backend"),
  exam("software_offline", "Software Engineering"),
  competencyInterview("dsa"),
  competencyInterview("frontend"),
  competencyInterview("backend"),
  competencyInterview("software"),
  bucketRound("A", 1),
  bucketRound("A", 2),
  bucketRound("B", 1),
  bucketRound("B", 2),
  bucketRound("C", 1),
  edgeScores("edge2.assessment", "Assessment scores", [
    { name: "Edge 2.0 offline", max: 160, value: (r) => r.offlineOverallScore },
    { name: "Edge 2.0 DSA coding", max: 120, value: (r) => r.dsaCodingScore },
    { name: "Edge 2.0 CS fundamentals", max: 40, value: (r) => r.csFundamentalsScore },
    { name: "Edge 2.0 SQL MCQ", max: 15, value: (r) => r.sqlMcqScore },
    { name: "Edge 2.0 SQL coding", max: 15, value: (r) => r.sqlCodingScore },
  ]),
  edgeScores("edge2.tr1", "TR-1 ratings", [
    { name: "Edge 2.0 TR-1 overall technical", max: 100, value: (r) => r.tr1.overallTechnical },
    { name: "Edge 2.0 TR-1 DSA", max: 10, value: (r) => r.tr1.dsaOverall },
    { name: "Edge 2.0 TR-1 problem solving", max: 10, value: (r) => r.tr1.problemSolving },
    { name: "Edge 2.0 TR-1 coding", max: 10, value: (r) => r.tr1.coding },
    { name: "Edge 2.0 TR-1 debugging", max: 10, value: (r) => r.tr1.debugging },
    { name: "Edge 2.0 TR-1 communication", max: 10, value: (r) => r.tr1.communication },
    { name: "Edge 2.0 TR-1 self intro", max: 10, value: (r) => r.tr1.selfIntro },
  ]),
];

// ── Text details ─────────────────────────────────────────────────────────────

/** Every text detail, in the order they appear in the cell. */
export const REQUIREMENTS: Requirement[] = [
  // Candidate
  { key: "name", group: "candidate", label: "Name", cellLabel: "Name", needs: [], value: ({ standing, name }) => standing?.name || name || "" },
  { key: "college", group: "candidate", label: "College", cellLabel: "College", needs: ["profile"], value: ({ profile }) => profile?.college ?? "" },
  { key: "yog", group: "candidate", label: "Year of graduation", cellLabel: "Year of graduation", needs: ["profile"], value: ({ profile, records }) => String(profile?.yog ?? records.academy?.yog ?? "") },
  { key: "degree", group: "candidate", label: "Degree & department", cellLabel: "Degree", needs: ["profile"], value: ({ profile }) => [profile?.degree, profile?.department].filter(Boolean).join(" · ") },
  {
    key: "resume",
    group: "candidate",
    label: "Resume link (pool)",
    cellLabel: "Resume",
    needs: ["edge2", "edge1", "academy"],
    value: ({ standing, records }) =>
      [...(standing ? [standing.bestProduct] : []), ...(["edge2", "edge1", "academy"] as Product[])].map((p) => records[p]?.referenceResumeUrl).find(Boolean) ?? "",
  },
  {
    key: "other-products",
    group: "candidate",
    label: "Other products",
    cellLabel: "Also",
    needs: [],
    value: ({ standing }) =>
      (standing?.standings ?? [])
        .filter((s) => s.product !== standing?.bestProduct)
        .map((s) => `${s.label}${s.eligible ? "" : " (not eligible)"}`)
        .join("; "),
  },
  { key: "internal-score", group: "candidate", label: "Score within stage", cellLabel: "Score within stage", needs: [], value: ({ standing }) => (standing ? `${standing.bestScore}/100` : "") },
  // Edge 2.0
  { key: "edge2.stage", group: "edge2", label: "Candidate stage", cellLabel: "Edge 2.0 stage", needs: ["edge2"], value: ({ records }) => records.edge2?.candidateStage ?? "" },
  {
    key: "edge2.tr2",
    group: "edge2",
    label: "TR-2 verdicts",
    cellLabel: "Edge 2.0 TR-2",
    needs: ["edge2"],
    value: ({ records }) => (records.edge2?.tr2 ?? []).map((v) => `${TR2_TRACK_LABEL[v.track] ?? v.track} ${VERDICT_LABEL[v.verdict] ?? v.verdict}`).join(" · "),
  },
  // Edge 1.0
  { key: "edge1.assessment", group: "edge1", label: "Assessment", cellLabel: "Edge 1.0 assessment", needs: ["edge1"], value: ({ records }) => records.edge1?.assessmentStatus ?? "" },
  { key: "edge1.tr1", group: "edge1", label: "TR-1", cellLabel: "Edge 1.0 TR-1", needs: ["edge1"], value: ({ records }) => records.edge1?.tr1Status ?? "" },
  { key: "edge1.tr2", group: "edge1", label: "TR-2", cellLabel: "Edge 1.0 TR-2", needs: ["edge1"], value: ({ records }) => records.edge1?.tr2Status ?? "" },
  // Academy pool
  {
    key: "academy.active-pool",
    group: "academy",
    label: "Active pool",
    cellLabel: "Academy active pool",
    needs: ["academy"],
    value: ({ records }) => (records.academy?.activePool === true ? "Yes" : records.academy?.activePool === false ? "No" : ""),
  },
  { key: "academy.placement", group: "academy", label: "Previous placement", cellLabel: "Academy previous placement", needs: ["academy"], value: ({ records }) => records.academy?.previousPlacement ?? "" },
  { key: "academy.preference", group: "academy", label: "Preference", cellLabel: "Academy preference", needs: ["academy"], value: ({ records }) => records.academy?.studentPreference ?? "" },
];

const TEXT = new Map(REQUIREMENTS.map((r) => [r.key, r]));
const MARK = new Map(MARK_ITEMS.map((m) => [m.key, m]));
/** Chip order, and the order of the result's columns within text details and within marks. */
const ORDER = [
  ...["name", "college", "yog", "degree", "resume", "other-products", "internal-score"],
  ...MARK_ITEMS.filter((m) => m.group !== "edge2").map((m) => m.key),
  ...["academy.active-pool", "academy.placement", "academy.preference"],
  ...["edge2.stage", "edge2.assessment", "edge2.tr1", "edge2.tr2"],
  ...["edge1.assessment", "edge1.tr1", "edge1.tr2"],
];

/** Every pickable item, chips in this order. */
export const PICKABLE: { key: string; group: RequirementGroup; label: string; mark: boolean }[] = ORDER.map((k) => {
  const item = TEXT.get(k) ?? MARK.get(k)!;
  return { key: k, group: item.group, label: item.label, mark: MARK.has(k) };
});

/** Keys that were renamed or merged: an older saved choice keeps working. */
const RENAMED: Record<string, string[]> = {
  "academy.yog": ["yog"],
  "academy.old-bucket": ["marks.old_offline"],
  "academy.dsa-offline": ["marks.dsa_offline"],
  "academy.competency.dsa": ["marks.dsa_interview"],
  "academy.competency.frontend": ["marks.frontend_interview"],
  "academy.competency.backend": ["marks.backend_interview"],
  "academy.competency.software": ["marks.software_interview"],
  "academy.interviews": ["marks.bucket_a_tr1", "marks.bucket_a_tr2", "marks.bucket_b_tr1", "marks.bucket_b_tr2", "marks.bucket_c_tr1"],
};

/** Known keys only, in catalogue order (renamed keys mapped, stale ones dropped). */
export const cleanRequirementKeys = (keys: string[]): string[] => {
  const want = new Set(keys.flatMap((k) => RENAMED[k] ?? [k]));
  return ORDER.filter((k) => want.has(k));
};

const needsOf = (k: string) => TEXT.get(k)?.needs ?? MARK.get(k)?.needs ?? [];

/** The data the picked items read, in a fixed order. */
export function includesNeeded(keys: string[]): LookupInclude[] {
  const set = new Set(cleanRequirementKeys(keys).flatMap(needsOf));
  return INCLUDE_ORDER.filter((p) => set.has(p));
}

/** The products whose records the picked items read. */
export const productsNeeded = (keys: string[]): Product[] => includesNeeded(keys).filter((x): x is Product => x === "edge2" || x === "edge1" || x === "academy");

export const textKeys = (keys: string[]) => cleanRequirementKeys(keys).filter((k) => TEXT.has(k));
export const markKeys = (keys: string[]) => cleanRequirementKeys(keys).filter((k) => MARK.has(k));
/** Whether any picked item is a mark (the attempt and column choices apply). */
export const picksMarks = (keys: string[]) => markKeys(keys).length > 0;
/** Whether any picked mark has attempts (the attempt and verdict choices apply). */
export const picksAttempts = (keys: string[]) => markKeys(keys).some((k) => MARK.get(k)!.kind !== "scores");
/** Whether any picked mark is an interview (the recording column applies). */
export const picksInterviews = (keys: string[]) => markKeys(keys).some((k) => MARK.get(k)!.kind === "interview");

/** The Requirements cell's lines: "<item>: <result>" for each picked text item the candidate has a result for. */
export function requirementLines(person: MatchedPerson, keys: string[]): string[] {
  return textKeys(keys)
    .map((k) => {
      const req = TEXT.get(k)!;
      const v = req.value(person).trim();
      return v ? `${req.cellLabel}: ${v}` : "";
    })
    .filter(Boolean);
}

/** One value per picked text item (the one-column-per-item layout); "" when the candidate has no result. */
export function requirementItems(person: MatchedPerson, keys: string[]): Record<string, string> {
  return Object.fromEntries(textKeys(keys).map((k) => [k, TEXT.get(k)!.value(person).trim()]));
}

/** Every attempt at each picked mark, oldest first. */
export function markAttempts(person: MatchedPerson, keys: string[]): Record<string, Attempt[]> {
  return Object.fromEntries(markKeys(keys).map((k) => [k, MARK.get(k)!.attempts(person)]));
}

// ── The result ────────────────────────────────────────────────────────────────

/**
 * internal = in the eligible pool with an eligible standing; not-eligible = in the pool, not
 * cleared; assessed = has Academy marks, not in the pool; external = unknown to the database.
 */
export type LookupStatus = "internal" | "not-eligible" | "assessed" | "external" | "unrecognised" | "blank";

export interface LookupRow {
  line: number;
  status: LookupStatus;
  /** Job eligibility: null when the person is unknown (external) or the line has no id. */
  eligibility: JobEligibility | null;
  tier: Tier | null;
  product: Product | null;
  /** Pasted, or the pool's when only a phone number was pasted. */
  uuid: string;
  phone: string;
  cells: Record<string, string>;
  /** The picked text items, as Requirements lines and by key. */
  requirements: string[];
  items: Record<string, string>;
  /** Every attempt at each picked mark, by mark key. */
  marks: Record<string, Attempt[]>;
}

export interface LookupData {
  standings: Record<string, CandidateStanding>;
  records: Record<string, PersonRecords>;
  /** People with marks who aren't in the eligible pool, by "p:<phone>" / "u:<userId>". */
  assessed?: Record<string, PersonRef>;
  /** By candidate id. */
  scores?: Record<string, AssessmentScore[]>;
  profiles?: Record<string, CandidateProfile>;
}

/** Someone assessed outside the pool, matched like a standing: phone first, then user id. */
function assessedFor(assessed: Record<string, PersonRef> | undefined, phone: string, userId: string): PersonRef | null {
  if (!assessed) return null;
  const p = normalisePhone(phone);
  const u = normaliseUserId(userId);
  return (p ? assessed[`p:${p}`] : undefined) ?? (u ? assessed[`u:${u}`] : undefined) ?? null;
}

/** Every pasted row with its standing and, for matched people, the picked details. */
export function lookupRows(input: LookupInput, data: LookupData, keys: string[]): LookupRow[] {
  const details = (person: MatchedPerson) => ({ requirements: requirementLines(person, keys), items: requirementItems(person, keys), marks: markAttempts(person, keys) });
  const of = (id: number) => ({ records: data.records[String(id)] ?? {}, scores: data.scores?.[String(id)] ?? [], profile: data.profiles?.[String(id)] ?? null });
  return input.rows.map((r): LookupRow => {
    const base = {
      line: r.line,
      uuid: r.userId ?? "",
      phone: r.phone ?? "",
      eligibility: null,
      requirements: [] as string[],
      items: {},
      marks: {},
      tier: null,
      product: null,
      cells: {} as Record<string, string>,
    };
    if (r.problem === "blank") return { ...base, status: "blank" };
    if (r.problem === "unrecognised") return { ...base, status: "unrecognised", cells: { "Internal Standing": "Not a UUID or phone number" } };
    const st = standingFor(data.standings, r.phone ?? "", r.userId ?? "");
    if (!st) {
      const known = assessedFor(data.assessed, r.phone ?? "", r.userId ?? "");
      if (!known) return { ...base, status: "external", cells: internalColumns(null, true) };
      return {
        ...base,
        uuid: r.userId ?? known.userId ?? "",
        status: "assessed",
        eligibility: "not-eligible",
        cells: { "Internal Standing": ASSESSED_ONLY },
        ...details({ standing: null, name: known.name, ...of(known.candidateId) }),
      };
    }
    const key = st.matchedBy === "phone" ? `p:${normalisePhone(r.phone ?? "")}` : `u:${normaliseUserId(r.userId ?? "")}`;
    const standing = data.standings[key];
    const eligible = isAssessed(st);
    return {
      ...base,
      uuid: r.userId ?? standing.userId ?? "",
      status: eligible ? "internal" : "not-eligible",
      eligibility: eligible ? "eligible" : "not-eligible",
      tier: st.tier,
      product: st.product,
      cells: internalColumns(st, true),
      ...details({ standing, ...of(standing.candidateId) }),
    };
  });
}

/** A column of the result: its header, what it holds, and its value per row. */
export interface OutputColumn {
  header: string;
  kind: "id" | "standing" | "eligibility" | "text" | "score" | "verdict" | "date" | "recording";
  value: (r: LookupRow) => string;
}

const scoreText = (a: Attempt | undefined, max: number | null) => (a?.score == null ? "" : a.max !== null && max !== null && a.max !== max ? `${n(a.score)}/${n(a.max)}` : n(a.score));

/**
 * The columns of one mark. Best / latest: "<name> (max)" with the marks obtained, then — when
 * asked for — "<name> – verdict", "– date", "– recording". All attempts: an exam gets those
 * columns per exam date ("DSA offline exam 25 Oct 2026 (130)"), an interview per attempt
 * ("Bucket B TR-1 #2 (15)"), oldest first. The header's maximum is the one every attempt in the
 * column shares (an exam once set out of 140 says so); only a column mixing maxima keeps the
 * usual one and writes the odd marks as "60/140".
 */
function markColumns(item: MarkItem, rows: LookupRow[], o: LookupOptions): OutputColumn[] {
  const scoreColumn = (prefix: string, pick: (r: LookupRow) => Attempt | undefined): OutputColumn => {
    const maxes = new Set(rows.map(pick).flatMap((a) => (a?.score != null && a.max !== null ? [a.max] : [])));
    const max = maxes.size === 1 ? [...maxes][0] : item.max;
    return { header: max !== null ? `${prefix} (${n(max)})` : prefix, kind: "score", value: (r) => scoreText(pick(r), max) };
  };
  if (item.fixed) {
    return item.fixed.map((f, i) => ({ header: `${f.name} (${f.max})`, kind: "score" as const, value: (r: LookupRow) => scoreText(r.marks[item.key]?.[i], f.max) }));
  }
  const extras = (prefix: string, pick: (r: LookupRow) => Attempt | undefined, withDate: boolean): OutputColumn[] => [
    ...(o.verdict ? [{ header: `${prefix} – verdict`, kind: "verdict" as const, value: (r: LookupRow) => pick(r)?.verdict ?? "" }] : []),
    ...(o.date && withDate ? [{ header: `${prefix} – date`, kind: "date" as const, value: (r: LookupRow) => pick(r)?.when ?? "" }] : []),
    ...(o.recording && item.kind === "interview" ? [{ header: `${prefix} – recording`, kind: "recording" as const, value: (r: LookupRow) => pick(r)?.recordingUrl ?? "" }] : []),
  ];
  const of = (r: LookupRow) => r.marks[item.key] ?? [];
  if (o.attempts !== "all") {
    const pick = (r: LookupRow) => chooseAttempts(of(r), o.attempts)[0];
    return [scoreColumn(item.name, pick), ...extras(item.name, pick, true)];
  }
  if (item.kind === "exam") {
    const dates = [...new Set(rows.flatMap((r) => of(r).map((a) => a.takenOn ?? "")))].sort();
    return dates.flatMap((d) => {
      const prefix = d ? `${item.name} ${formatDate(d)}` : item.name;
      const pick = (r: LookupRow) => of(r).find((a) => (a.takenOn ?? "") === d);
      return [scoreColumn(prefix, pick), ...extras(prefix, pick, !d)];
    });
  }
  const most = Math.max(1, ...rows.map((r) => of(r).length));
  return Array.from({ length: most }, (_, i) => {
    const prefix = most > 1 ? `${item.name} #${i + 1}` : item.name;
    const pick = (r: LookupRow) => chooseAttempts(of(r), "all")[i];
    return [scoreColumn(prefix, pick), ...extras(prefix, pick, true)];
  }).flat();
}

/**
 * The result's columns: UUID, Phone (when pasted), the three standing columns, Job Eligibility,
 * the picked text details (one Requirements column, or one column each), then the picked marks —
 * always in columns of their own.
 */
export function lookupColumns(rows: LookupRow[], opts: { phoneColumn: boolean; keys: string[]; options?: LookupOptions }): OutputColumn[] {
  const o = opts.options ?? DEFAULT_LOOKUP_OPTIONS;
  const text = textKeys(opts.keys);
  return [
    { header: "UUID", kind: "id", value: (r) => r.uuid },
    ...(opts.phoneColumn ? [{ header: "Phone", kind: "id" as const, value: (r: LookupRow) => r.phone }] : []),
    ...STANDING_HEADERS.map((h) => ({ header: h, kind: "standing" as const, value: (r: LookupRow) => r.cells[h] ?? "" })),
    { header: JOB_ELIGIBILITY_HEADER, kind: "eligibility", value: (r) => (r.eligibility ? JOB_ELIGIBILITY_LABEL[r.eligibility] : "") },
    ...(text.length
      ? o.layout === "columns"
        ? text.map((k) => ({ header: TEXT.get(k)!.cellLabel, kind: "text" as const, value: (r: LookupRow) => r.items[k] ?? "" }))
        : [{ header: "Requirements", kind: "text" as const, value: (r: LookupRow) => r.requirements.join("\n") }]
      : []),
    ...markKeys(opts.keys).flatMap((k) => markColumns(MARK.get(k)!, rows, o)),
  ];
}

/** Columns and rows for the CSV / the clipboard. */
export function lookupTable(rows: LookupRow[], opts: { phoneColumn: boolean; keys: string[]; options?: LookupOptions }): { headers: string[]; rows: Record<string, string>[] } {
  const cols = lookupColumns(rows, opts);
  return { headers: cols.map((c) => c.header), rows: rows.map((r) => Object.fromEntries(cols.map((c) => [c.header, c.value(r)]))) };
}

export interface LookupSummary {
  /** Rows with an id. */
  looked: number;
  /** Eligible for job opportunities: in the pool with an eligible standing, by stage. */
  internal: number;
  byTier: Record<1 | 2 | 3, number>;
  /** In the pool, not cleared. */
  notEligible: number;
  /** Assessed (Academy marks), not in the pool — also not eligible. */
  assessedOnly: number;
  external: number;
  unrecognised: number;
  byProduct: Record<Product, number>;
}

export function summarise(rows: LookupRow[]): LookupSummary {
  const s: LookupSummary = { looked: 0, internal: 0, byTier: { 1: 0, 2: 0, 3: 0 }, notEligible: 0, assessedOnly: 0, external: 0, unrecognised: 0, byProduct: { edge2: 0, edge1: 0, academy: 0 } };
  for (const r of rows) {
    if (r.status === "blank") continue;
    if (r.status === "unrecognised") {
      s.unrecognised++;
      continue;
    }
    s.looked++;
    if (r.status === "external") s.external++;
    else if (r.status === "not-eligible") s.notEligible++;
    else if (r.status === "assessed") s.assessedOnly++;
    else {
      s.internal++;
      if (r.tier && r.tier <= 3) s.byTier[r.tier as 1 | 2 | 3]++;
      if (r.product) s.byProduct[r.product]++;
    }
  }
  return s;
}

// ── Clipboard (Google Sheets / Excel) ────────────────────────────────────────

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** An HTML table — Sheets and Excel keep multi-line cells intact when pasting it. */
export function toHtmlTable(headers: string[], rows: Record<string, string>[]): string {
  const cell = (tag: "th" | "td", v: string) => `<${tag}>${escapeHtml(v).replace(/\n/g, "<br>")}</${tag}>`;
  return `<table><thead><tr>${headers.map((h) => cell("th", h)).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${headers.map((h) => cell("td", r[h] ?? "")).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

/** Tab-separated text; a cell with a tab, quote or line break is quoted (as Excel does). */
export function toTsv(headers: string[], rows: Record<string, string>[]): string {
  const cell = (v: string) => (/[\t"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [headers.map(cell).join("\t"), ...rows.map((r) => headers.map((h) => cell(r[h] ?? "")).join("\t"))].join("\n");
}
