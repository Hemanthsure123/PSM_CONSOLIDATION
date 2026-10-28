import { isCleared, parseVerdict, standingOf } from "@/lib/pool/standing";
import {
  type AcademyBucket,
  type AcademyCompetency,
  type AcademyRecord,
  type AcademyRound,
  type CompetencySubject,
  type Edge1Record,
  type Edge2Record,
  type ParsedPool,
  type ParseIssue,
  type PoolRecord,
  type Product,
  type Tr2Track,
} from "@/lib/pool/types";

/**
 * The eligible-pool sheets (or CSV exports of them) → records. Pure and client-safe.
 * Columns are found by their header names, so column order never matters; only the
 * columns the placement team named are read. Spreadsheet error cells (#N/A, #REF! …)
 * read as empty.
 */

/** A table read from a sheet or a CSV: every row as cells, header rows included. */
export type Table = string[][];

const ERROR_CELL = /^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!|ERROR!)$/i;
const cell = (row: string[] | undefined, i: number | undefined): string => {
  if (!row || i === undefined || i < 0) return "";
  const v = String(row[i] ?? "").replace(/\s+/g, " ").trim();
  return ERROR_CELL.test(v) || v === "-" ? "" : v;
};
const squeeze = (h: string) => h.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "");
const num = (v: string): number | null => {
  if (!v) return null;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** 10-digit Indian mobile: "+91 98765 43210", "09876543210", "919876543210" → "9876543210". */
export function normalisePhone(raw: string): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  const ten = d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d;
  return /^\d{10}$/.test(ten) ? ten : null;
}

/** A user id cell (uuid / numeric id), trimmed and lower-cased; null when empty or implausible. */
export function normaliseUserId(raw: string): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  return v && v.length <= 64 && /^[a-z0-9-_]+$/.test(v) ? v : null;
}

const link = (v: string) => (/^https?:\/\//i.test(v) ? v : null);

/** Index of the first header cell matching one of `names` (compared squeezed), or -1. */
function col(header: string[], ...names: string[]): number {
  const want = names.map(squeeze);
  return header.findIndex((h) => want.includes(squeeze(String(h ?? ""))));
}

/** The first row (within the top 5) that holds every one of `names`. */
function findHeader(table: Table, names: string[]): number {
  for (let i = 0; i < Math.min(5, table.length); i++) if (names.every((n) => col(table[i], n) >= 0)) return i;
  return -1;
}

interface Collected<R extends PoolRecord> {
  records: R[];
  issues: ParseIssue[];
}

/**
 * Identity + de-duplication: a row needs a phone or a user id; when two rows share a
 * phone (or a user id), the one with the stronger standing is kept.
 */
function collect<R extends PoolRecord>(rows: { row: number; record: R }[]): Collected<R> {
  const issues: ParseIssue[] = [];
  const byKey = new Map<string, { row: number; record: R }>();
  for (const item of rows) {
    const r = item.record;
    if (!r.phone && !r.userId) {
      issues.push({ row: item.row, problem: "No phone number or user id — skipped" });
      continue;
    }
    const key = r.phone ? `p:${r.phone}` : `u:${r.userId}`;
    const prev = byKey.get(key) ?? (r.userId ? [...byKey.values()].find((x) => x.record.userId === r.userId) : undefined);
    if (prev) {
      const a = standingOf(prev.record);
      const b = standingOf(r);
      const keepNew = b.tier < a.tier || (b.tier === a.tier && b.internalScore > a.internalScore);
      issues.push({ row: item.row, problem: `Same person as row ${prev.row} — kept the ${keepNew ? "later" : "earlier"} row (stronger standing)` });
      if (keepNew) {
        byKey.delete(prev.record.phone ? `p:${prev.record.phone}` : `u:${prev.record.userId}`);
        byKey.set(key, item);
      }
      continue;
    }
    byKey.set(key, item);
  }
  return { records: [...byKey.values()].map((x) => x.record), issues };
}

function identityIssues(row: number, phoneRaw: string, phone: string | null): ParseIssue[] {
  return phoneRaw && !phone ? [{ row, problem: `Phone "${phoneRaw.slice(0, 20)}" isn't a 10-digit number — matched by user id only` }] : [];
}

// ── Edge 2.0 ─────────────────────────────────────────────────────────────────

const TRACK_OF: Record<string, Tr2Track> = {
  dataanalytics: "data_analytics",
  dsml: "dsml",
  genai: "genai",
  javafullstack: "java_fullstack",
  mernfullstack: "mern_fullstack",
  product: "product",
  pythonfullstack: "python_fullstack",
};

/** "All Assessment Cleared PII DATA" → resume link by phone and by user id (reference only). */
export function parseResumeReference(table: Table): { byPhone: Map<string, string>; byUserId: Map<string, string> } {
  const byPhone = new Map<string, string>();
  const byUserId = new Map<string, string>();
  const h = findHeader(table, ["Phone Number", "Resume Link"]);
  if (h < 0) return { byPhone, byUserId };
  const head = table[h];
  const iPhone = col(head, "Phone Number");
  const iUser = col(head, "User ID");
  const iResume = col(head, "Resume Link");
  for (const row of table.slice(h + 1)) {
    const url = link(cell(row, iResume));
    if (!url) continue;
    const phone = normalisePhone(cell(row, iPhone));
    const user = normaliseUserId(cell(row, iUser));
    if (phone && !byPhone.has(phone)) byPhone.set(phone, url);
    if (user && !byUserId.has(user)) byUserId.set(user, url);
  }
  return { byPhone, byUserId };
}

export function parseEdge2(table: Table, reference?: ReturnType<typeof parseResumeReference>): ParsedPool<Edge2Record> {
  const required = ["Candidate Stage", "phone"];
  const h = findHeader(table, required);
  if (h < 0) return { product: "edge2", records: [], rowsRead: 0, missingColumns: required.filter((n) => !table.slice(0, 5).some((r) => col(r, n) >= 0)), issues: [] };
  const head = table[h];
  const i = {
    stage: col(head, "Candidate Stage"),
    phone: col(head, "phone"),
    userId: col(head, "bqCandidateId", "User ID", "userId"),
    name: col(head, "name"),
    offline: col(head, "offlineOverallScore"),
    dsa: col(head, "dsaCodingScore"),
    cs: col(head, "csFundamentalsScore"),
    sqlMcq: col(head, "sqlMcqScore"),
    sqlCoding: col(head, "sqlCodingScore"),
    selfIntro: col(head, "tr1SelfIntroRating"),
    dsaOverall: col(head, "tr1DsaOverallRating"),
    problemSolving: col(head, "tr1ProblemSolvingAbility"),
    coding: col(head, "tr1CodingSkills"),
    communication: col(head, "tr1CommunicationAndCollaboration"),
    debugging: col(head, "tr1DebuggingAndIteration"),
    overallTechnical: col(head, "tr1OverallTechnicalScore"),
  };
  const verdictCols = head
    .map((raw, idx) => {
      const m = String(raw ?? "").replace(/\s+/g, " ").trim().match(/^tr\s*-?\s*2\s+(.+?)\s+verdict$/i);
      const track = m ? TRACK_OF[squeeze(m[1])] : undefined;
      return track ? { track, idx } : null;
    })
    .filter((x): x is { track: Tr2Track; idx: number } => Boolean(x));

  const rows: { row: number; record: Edge2Record }[] = [];
  const issues: ParseIssue[] = [];
  let rowsRead = 0;
  table.slice(h + 1).forEach((r, k) => {
    if (!r.some((c) => String(c ?? "").trim())) return;
    rowsRead++;
    const row = h + 2 + k;
    const phoneRaw = cell(r, i.phone);
    const phone = normalisePhone(phoneRaw);
    const userId = normaliseUserId(cell(r, i.userId));
    issues.push(...identityIssues(row, phoneRaw, phone));
    const stage = cell(r, i.stage);
    if (!stage) {
      issues.push({ row, problem: "No Candidate Stage — skipped" });
      return;
    }
    const tr2 = verdictCols.flatMap(({ track, idx }) => {
      const v = parseVerdict(cell(r, idx));
      return v ? [{ track, verdict: v }] : [];
    });
    const ref = (phone && reference?.byPhone.get(phone)) || (userId && reference?.byUserId.get(userId)) || null;
    rows.push({
      row,
      record: {
        product: "edge2",
        phone,
        userId,
        name: cell(r, i.name),
        referenceResumeUrl: ref,
        candidateStage: stage,
        offlineOverallScore: num(cell(r, i.offline)),
        dsaCodingScore: num(cell(r, i.dsa)),
        csFundamentalsScore: num(cell(r, i.cs)),
        sqlMcqScore: num(cell(r, i.sqlMcq)),
        sqlCodingScore: num(cell(r, i.sqlCoding)),
        tr1: {
          selfIntro: num(cell(r, i.selfIntro)),
          dsaOverall: num(cell(r, i.dsaOverall)),
          problemSolving: num(cell(r, i.problemSolving)),
          coding: num(cell(r, i.coding)),
          communication: num(cell(r, i.communication)),
          debugging: num(cell(r, i.debugging)),
          overallTechnical: num(cell(r, i.overallTechnical)),
        },
        tr2,
      },
    });
  });
  const c = collect(rows);
  return { product: "edge2", records: c.records, rowsRead, missingColumns: [], issues: [...issues, ...c.issues] };
}

// ── Edge 1.0 ─────────────────────────────────────────────────────────────────

export function parseEdge1(table: Table): ParsedPool<Edge1Record> {
  const required = ["User ID", "Assesment Selection Status", "Phone Number"];
  const h = findHeader(table, required);
  if (h < 0) return { product: "edge1", records: [], rowsRead: 0, missingColumns: required.filter((n) => !table.slice(0, 5).some((r) => col(r, n) >= 0)), issues: [] };
  const head = table[h];
  const i = {
    userId: col(head, "User ID"),
    name: col(head, "Name"),
    assessment: col(head, "Assesment Selection Status", "Assessment Selection Status"),
    tr1: col(head, "TR-1 Selection Status"),
    tr2: col(head, "Tr-2 Selection Status", "TR-2 Selection Status"),
    phone: col(head, "Phone Number"),
    resume: col(head, "Resume Link"),
  };
  const rows: { row: number; record: Edge1Record }[] = [];
  const issues: ParseIssue[] = [];
  let rowsRead = 0;
  table.slice(h + 1).forEach((r, k) => {
    if (!r.some((c) => String(c ?? "").trim())) return;
    rowsRead++;
    const row = h + 2 + k;
    const phoneRaw = cell(r, i.phone);
    const phone = normalisePhone(phoneRaw);
    issues.push(...identityIssues(row, phoneRaw, phone));
    rows.push({
      row,
      record: {
        product: "edge1",
        phone,
        userId: normaliseUserId(cell(r, i.userId)),
        name: cell(r, i.name),
        referenceResumeUrl: link(cell(r, i.resume)),
        assessmentStatus: cell(r, i.assessment),
        tr1Status: cell(r, i.tr1),
        tr2Status: cell(r, i.tr2),
      },
    });
  });
  const c = collect(rows);
  return { product: "edge1", records: c.records, rowsRead, missingColumns: [], issues: [...issues, ...c.issues] };
}

// ── Academy ──────────────────────────────────────────────────────────────────

const BUCKET_ROUND = /^(?:bucket\s*([abc])|([abc])\s*bucket)\s*tr\s*-?\s*([12])\s*(score|status)$/i;
const SUBJECT_OF: Record<string, CompetencySubject> = { frontend: "frontend", dsa: "dsa", software: "software", backend: "backend" };

/** "L4" → 4, "Below L1" → 0, "Below L2" → 1. */
export function parseLevel(raw: string): number | null {
  const s = (raw ?? "").trim();
  const below = s.match(/below\s*l\s*([1-5])/i);
  if (below) return Number(below[1]) - 1;
  const m = s.match(/^l\s*([1-5])$/i);
  return m ? Number(m[1]) : null;
}

export function parseAcademy(table: Table): ParsedPool<AcademyRecord> {
  const required = ["UID", "Number"];
  const h = findHeader(table, required);
  if (h < 0) return { product: "academy", records: [], rowsRead: 0, missingColumns: required.filter((n) => !table.slice(0, 5).some((r) => col(r, n) >= 0)), issues: [] };
  const head = table[h].map((x) => String(x ?? ""));
  // The competency groups ("Frontend (Last Updated …)", "DSA", …) sit one row above
  // their columns; a merged group cell is only filled in its first column.
  const groupRow = h > 0 ? table[h - 1].map((x) => String(x ?? "")) : [];
  const groupAt = (idx: number) => {
    for (let j = idx; j >= 0; j--) {
      const g = groupRow[j]?.trim();
      if (g) return SUBJECT_OF[squeeze(g).match(/^(frontend|dsa|software|backend)/)?.[1] ?? ""];
    }
    return undefined;
  };
  const i = {
    uid: col(head, "UID"),
    dsaOffline: col(head, "DSA Offline"),
    oldChecks: col(head, "Old Assessment Checks"),
    yog: col(head, "YOG"),
    name: col(head, "Name"),
    phone: col(head, "Number"),
    placement: head.findIndex((x) => /^previous placement info/i.test(x.trim())),
    preference: col(head, "Student Preference"),
    active: col(head, "Active Pool"),
    resume: col(head, "Resume"),
  };
  const roundCols: { bucket: "A" | "B" | "C"; round: 1 | 2; kind: "score" | "status"; idx: number }[] = [];
  head.forEach((raw, idx) => {
    const m = raw.replace(/\s+/g, " ").trim().match(BUCKET_ROUND);
    if (m) roundCols.push({ bucket: (m[1] || m[2]).toUpperCase() as "A" | "B" | "C", round: Number(m[3]) as 1 | 2, kind: m[4].toLowerCase() as "score" | "status", idx });
  });
  const compCols: Partial<Record<CompetencySubject, { score?: number; band?: number; clearance?: number; level?: number }>> = {};
  head.forEach((raw, idx) => {
    const subject = groupAt(idx);
    const s = squeeze(raw);
    const lv = s.match(/^(frontend|dsa|software|backend)levels?$/);
    const sub = lv ? SUBJECT_OF[lv[1]] : subject;
    if (!sub) return;
    const slot = (compCols[sub] ??= {});
    if (lv) slot.level = idx;
    else if (s === "overallscore" && subject) slot.score = idx;
    else if (s === "verdictband" && subject) slot.band = idx;
    else if (s === "clearancestatus" && subject) slot.clearance = idx;
  });

  const rows: { row: number; record: AcademyRecord }[] = [];
  const issues: ParseIssue[] = [];
  let rowsRead = 0;
  table.slice(h + 1).forEach((r, k) => {
    if (!r.some((c) => String(c ?? "").trim())) return;
    rowsRead++;
    const row = h + 2 + k;
    const phoneRaw = cell(r, i.phone);
    const phone = normalisePhone(phoneRaw);
    issues.push(...identityIssues(row, phoneRaw, phone));
    const bucketRaw = cell(r, i.oldChecks).match(/bucket\s*-?\s*([abcd])\b/i);
    const yog = num(cell(r, i.yog));
    const active = cell(r, i.active).toLowerCase();
    const rounds: AcademyRound[] = [];
    for (const bucket of ["A", "B", "C"] as const) {
      for (const n of [1, 2] as const) {
        const score = roundCols.find((c) => c.bucket === bucket && c.round === n && c.kind === "score");
        const status = roundCols.find((c) => c.bucket === bucket && c.round === n && c.kind === "status");
        const st = cell(r, status?.idx);
        const sc = num(cell(r, score?.idx));
        if (!st && sc === null) continue;
        // Bucket A TR-1 is graded Strong / Medium / Low Hire: only Strong and Medium went on to TR-2.
        const v = parseVerdict(st);
        const cleared = v ? v === "strong_hire" || v === "medium_hire" : isCleared(st);
        rounds.push({ bucket, round: n, score: sc, status: st, cleared });
      }
    }
    const competency: AcademyCompetency[] = [];
    for (const [subject, c] of Object.entries(compCols) as [CompetencySubject, NonNullable<(typeof compCols)[CompetencySubject]>][]) {
      const levelLabel = cell(r, c.level);
      const clearance = cell(r, c.clearance);
      const score = num(cell(r, c.score));
      const band = cell(r, c.band);
      if (!levelLabel && !clearance && score === null && !band) continue;
      competency.push({
        subject,
        overallScore: score !== null && score >= 0 && score <= 100 ? score : null,
        verdictBand: band,
        clearanceStatus: clearance,
        cleared: isCleared(clearance),
        level: parseLevel(levelLabel),
        levelLabel,
      });
    }
    const dsaOffline = cell(r, i.dsaOffline);
    rows.push({
      row,
      record: {
        product: "academy",
        phone,
        userId: normaliseUserId(cell(r, i.uid)),
        name: cell(r, i.name),
        referenceResumeUrl: link(cell(r, i.resume)),
        yog: yog !== null && yog >= 2000 && yog <= 2100 ? Math.round(yog) : null,
        oldBucket: bucketRaw ? (bucketRaw[1].toUpperCase() as AcademyBucket) : null,
        dsaOfflineStatus: dsaOffline,
        dsaOfflineCleared: isCleared(dsaOffline),
        previousPlacement: cell(r, i.placement),
        studentPreference: cell(r, i.preference).slice(0, 2000),
        activePool: /^(yes|y|true|active)$/.test(active) ? true : /^(no|n|false|inactive)$/.test(active) ? false : null,
        rounds,
        competency,
      },
    });
  });
  const c = collect(rows);
  return { product: "academy", records: c.records, rowsRead, missingColumns: [], issues: [...issues, ...c.issues] };
}

/** Which product a CSV belongs to, from its headers (null = not a pool sheet). */
export function detectProduct(table: Table): Product | null {
  if (findHeader(table, ["Candidate Stage", "phone"]) >= 0) return "edge2";
  if (findHeader(table, ["User ID", "Assesment Selection Status"]) >= 0) return "edge1";
  if (findHeader(table, ["UID", "Number"]) >= 0) return "academy";
  return null;
}

export function parsePool(product: Product, table: Table, reference?: ReturnType<typeof parseResumeReference>): ParsedPool {
  return product === "edge2" ? parseEdge2(table, reference) : product === "edge1" ? parseEdge1(table) : parseAcademy(table);
}
