import type {
  AcBucket,
  AcCandidate,
  AcColumn,
  AcCompetency,
  AcDataset,
  AcEligibility,
  AcInterview,
  AcOldBucket,
  AcOldRound,
  AcPlacementInfo,
} from "@/lib/academy/types";

/**
 * Academy bucketing — reading the three sheets into one row per candidate.
 * Pure (no I/O): the grids come from a read-only server action, and the same
 * code runs in the self-test.
 *
 *  - Sheet 1's header row is found, not assumed (the master tab has a group row
 *    above it). Headers that repeat ("Overall Score (out of 100)" four times,
 *    "TR1 recording" three times) are named by their group — the label above them
 *    or the TR round before them — so every column keeps its own name.
 *  - Sheet 2 (competency interviews) and sheet 3 (old process) are joined by UID,
 *    falling back to email (sheet 2) or mobile then email (sheet 3). A candidate
 *    with several interviews in one tab gets the latest completed one.
 *  - Columns that repeat what sheet 1 already holds (name, email, mobile, UID,
 *    level, verdict, clearance) are not repeated: they only fill sheet 1's blanks.
 * Eligibility is read from sheet 1 alone.
 */

export interface AcGrid {
  name: string;
  values: string[][];
}

export interface AcRawSources {
  s1: { url: string; title: string; tab: AcGrid };
  s2: { url: string; title: string; tabs: AcGrid[] };
  s3: { url: string; title: string; tab: AcGrid | null };
}

const norm = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
const lc = (v: unknown) => norm(v).toLowerCase();
const mobileKey = (v: unknown) => norm(v).replace(/\D/g, "").slice(-10);
const num = (v: unknown): number | null => {
  const s = norm(v).replace(/[,%]/g, "");
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
};

/** A1-style column letters for an index (0 → A, 26 → AA). */
export function columnLetter(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** The header row among the first rows: the fullest one, strongly preferring one that names a UID / email column. */
export function detectHeaderRow(values: string[][], scan = 8): number {
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(scan, values.length); i++) {
    const cells = (values[i] ?? []).map(norm);
    const filled = cells.filter(Boolean).length;
    const keyed = cells.some((c) => /^(uid|user\s*id)$/i.test(c)) ? 100 : cells.some((c) => /e-?mail/i.test(c)) ? 50 : 0;
    if (filled + keyed > bestScore) {
      bestScore = filled + keyed;
      best = i;
    }
  }
  return best;
}

/**
 * One unique, readable label per column. A repeated header is prefixed with its
 * group: the label in the row above (e.g. "Frontend" over the competency block),
 * else the TR round it follows ("Bucket A TR 1 · TR1 recording").
 */
export function columnLabels(values: string[][], headerRow: number): { base: string[]; labels: string[] } {
  const header = values[headerRow] ?? [];
  const width = Math.max(header.length, ...values.slice(headerRow + 1).map((r) => (r ?? []).length), 0);
  const base = Array.from({ length: width }, (_, i) => norm(header[i]));
  const above = headerRow > 0 ? values[headerRow - 1] ?? [] : [];
  const group: string[] = [];
  let g = "";
  for (let i = 0; i < width; i++) {
    const a = norm(above[i]);
    if (a) g = a.replace(/\s*\(.*$/, "").trim();
    group.push(g);
  }
  const count = new Map<string, number>();
  for (const b of base) if (b) count.set(b.toLowerCase(), (count.get(b.toLowerCase()) ?? 0) + 1);

  const labels: string[] = [];
  const used = new Set<string>();
  let roundPrefix = "";
  for (let i = 0; i < width; i++) {
    const b = base[i];
    const repeated = b ? (count.get(b.toLowerCase()) ?? 0) > 1 : false;
    let label = b;
    if (!b) label = `Untitled column ${columnLetter(i)}${i > 0 && base[i - 1] ? ` (after ${base[i - 1]})` : ""}`;
    else if (repeated) label = group[i] ? `${group[i]} · ${b}` : roundPrefix ? `${roundPrefix} · ${b}` : b;
    if (b && !repeated) {
      const m = b.match(/^(.*?\bTR\s*\d+)\b/i);
      if (m) roundPrefix = m[1].trim();
    }
    let unique = label;
    for (let n = 2; used.has(unique.toLowerCase()); n++) unique = `${label} (${n})`;
    used.add(unique.toLowerCase());
    labels.push(unique);
  }
  return { base, labels };
}

const findCol = (base: string[], re: RegExp, from = 0) => {
  for (let i = from; i < base.length; i++) if (re.test(base[i])) return i;
  return -1;
};

/** "Frontend Levels" → Frontend; competency → the bucket it speaks for (DSA / SE speak for none). */
export function competencyName(raw: string): string {
  const s = raw.trim();
  if (/front/i.test(s)) return "Frontend";
  if (/back/i.test(s)) return "Backend";
  if (/^dsa|problem solving/i.test(s)) return "DSA";
  if (/soft|^se\b|fundamental/i.test(s)) return "SE Fundamentals";
  if (/full\s*stack/i.test(s)) return "Full Stack";
  if (/gen\s*ai|generative|\bai\b|\bml\b|machine|data/i.test(s)) return s.replace(/\b\w/g, (c) => c.toUpperCase());
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function competencyBucket(name: string): AcBucket | null {
  if (/^frontend$/i.test(name)) return "frontend";
  if (/^backend$/i.test(name)) return "backend";
  if (/^full stack$/i.test(name)) return "fullstack";
  if (/gen\s*ai|generative|\bai\b|\bml\b|machine|data/i.test(name)) return "aiml";
  return null;
}

/** L3 / L4 (not "Below L3"). */
export const isHighLevel = (level: string) => /^l\s*[34]\b/i.test(norm(level));

export function readEligibility(competencies: AcCompetency[], dsaOffline: string, oldBucket: AcOldBucket): AcEligibility {
  const levels = competencies.filter((c) => isHighLevel(c.level)).map((c) => `${c.name} ${norm(c.level).toUpperCase().replace(/\s+/g, "")}`);
  const off = norm(dsaOffline);
  const offScore = num(off);
  const dsaOff = (/cleared/i.test(off) && !/not\s*cleared/i.test(off)) || (offScore !== null && offScore >= 50);
  const bucketA = oldBucket === "A";
  const via = [...levels, ...(dsaOff ? ["DSA Offline cleared"] : []), ...(bucketA ? ["Old process Bucket A"] : [])];
  return { levels, dsaOffline: dsaOff, bucketA, eligible: via.length > 0, via };
}

export function oldBucketOf(v: string): AcOldBucket {
  const m = norm(v).match(/bucket\s*[-–—:]?\s*([abcd])\b/i) ?? norm(v).match(/^([abcd])$/i);
  return m ? (m[1].toUpperCase() as AcOldBucket) : "";
}

export function placementOf(v: string): AcPlacementInfo {
  const s = lc(v);
  if (/not\s*placed|unplaced/.test(s)) return "not-placed";
  if (/placed/.test(s)) return "placed";
  return "unknown";
}

const S2_SKIP = /^(uid|user\s*id|candidate name|name|candidate email|e-?mail.*|template|program|overall score \(out of 100\)|verdict band|clearance status|levels?)$/i;
const CARD_TEXT = /^card\s*\d+\s*[—–-]/i;

/** Sheet 3 columns that hold the same thing as a sheet 1 column: they only fill its blanks. */
const S3_INTO_S1: [RegExp, RegExp][] = [
  [/^(user\s*id|uid)$/i, /^uid$/i],
  [/^(student name|name|candidate name)$/i, /^name$/i],
  [/^(mobile( number)?|phone( number)?|number)$/i, /^number$/i],
  [/^(email( id)?|email address)$/i, /^email address$/i],
  [/^yog$/i, /^yog$/i],
  [/^college$/i, /college name/i],
  [/^bach\.? degree$/i, /highest graduation/i],
  [/^bach\.? department$/i, /course name/i],
  [/^placed through$/i, /placement source/i],
];

interface S2Tab {
  name: string;
  columns: { i: number; key: string; label: string }[];
  attemptsKey: string;
  statusCol: number;
  nameCol: number;
  /** Columns the trust agent reads: level, integrity score / note, overall remarks (-1 = none). */
  levelCol: number;
  integrityCol: number;
  integrityNoteCol: number;
  remarksCol: number;
  byUid: Map<string, string[][]>;
  byEmail: Map<string, string[][]>;
}

function readS2Tab(grid: AcGrid): S2Tab | null {
  const hr = detectHeaderRow(grid.values);
  const { base, labels } = columnLabels(grid.values, hr);
  const uidCol = findCol(base, /^uid$/i);
  if (uidCol < 0) return null;
  // A competency tab: it has an interview template or an overall score (Readme / Levels / helper tabs don't).
  if (findCol(base, /^template$/i) < 0 && findCol(base, /overall score/i) < 0) return null;
  const emailCol = findCol(base, /e-?mail/i);
  const statusCol = findCol(base, /^status$/i);
  const rows = grid.values.slice(hr + 1).filter((r) => (r ?? []).some((c) => norm(c)));
  const columns: S2Tab["columns"] = [];
  for (let i = 0; i < base.length; i++) {
    if (i === uidCol || i === emailCol || S2_SKIP.test(base[i])) continue;
    const filled = rows.map((r) => norm(r[i])).filter(Boolean);
    // The rubric text of a card ("Card 1 — HTML & CSS: 4 - Solid on …") repeats its rating column.
    if (filled.length && filled.filter((v) => CARD_TEXT.test(v)).length / filled.length >= 0.6) continue;
    columns.push({ i, key: `s2:${grid.name}:${i}`, label: `${grid.name} · ${labels[i]}` });
  }
  const byUid = new Map<string, string[][]>();
  const byEmail = new Map<string, string[][]>();
  for (const r of rows) {
    const u = lc(r[uidCol]);
    const e = emailCol >= 0 ? lc(r[emailCol]) : "";
    if (u) byUid.set(u, [...(byUid.get(u) ?? []), r]);
    if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), r]);
  }
  const nameCol = findCol(base, /^(candidate name|name)$/i);
  const integrityCol = findCol(base, /^integrity score$/i);
  // The integrity note is "Interview Integrity – Remarks", or an unnamed column right after the score.
  let integrityNoteCol = findCol(base, /integrity\s*[–—-]\s*remarks/i);
  if (integrityNoteCol < 0 && integrityCol >= 0 && !base[integrityCol + 1]) integrityNoteCol = integrityCol + 1;
  return {
    name: grid.name,
    columns,
    attemptsKey: `s2:${grid.name}:attempts`,
    statusCol,
    nameCol,
    levelCol: findCol(base, /^levels?$/i),
    integrityCol,
    integrityNoteCol,
    remarksCol: findCol(base, /^overall (remarks|feedback)$/i),
    byUid,
    byEmail,
  };
}

/** The latest completed interview (sheet order = entry order), else the latest of any status. */
function latestInterview(rows: string[][], statusCol: number): string[] {
  if (statusCol >= 0) {
    for (let k = rows.length - 1; k >= 0; k--) if (/completed/i.test(norm(rows[k][statusCol]))) return rows[k];
  }
  return rows[rows.length - 1];
}

/** Read and join the three sheets. Never throws on messy data; problems come back as warnings. */
export function buildDataset(src: AcRawSources, loadedAt = new Date().toISOString()): AcDataset {
  const warnings: string[] = [];
  const g1 = src.s1.tab.values;
  const hr = detectHeaderRow(g1);
  const { base, labels } = columnLabels(g1, hr);
  const col = (re: RegExp) => findCol(base, re);
  const C = {
    uid: col(/^(uid|user\s*id)$/i),
    name: col(/^(name|student name|candidate name)$/i),
    email: col(/e-?mail/i),
    mobile: col(/^(number|mobile( number)?|phone( number)?|contact( number)?)$/i),
    resume: col(/^resume/i),
    active: col(/active\s*pool/i),
    placement: col(/placement info|placement status|placed\b/i),
    preference: col(/preference/i),
    dsaOffline: col(/^dsa offline/i),
    oldBucket: col(/old assessment/i),
  };
  if (C.uid < 0 && C.email < 0) warnings.push(`Sheet 1 "${src.s1.tab.name}" has no UID or email column — rows can't be joined.`);
  if (C.active < 0) warnings.push(`Sheet 1 has no "Active Pool" column — nobody counts as active.`);
  if (C.resume < 0) warnings.push(`Sheet 1 has no "Resume" column — candidates are bucketed from assessments and preference only.`);

  // Competency blocks: "<Name> Levels" with its Overall Score / Verdict Band / Clearance Status just before it.
  const comp: { name: string; level: number; score: number; verdict: number; clearance: number }[] = [];
  base.forEach((b, i) => {
    const m = b.match(/^(.+?)\s+levels?$/i);
    if (!m || /eligib/i.test(b)) return;
    const near = (re: RegExp) => {
      for (let k = i - 1; k >= Math.max(0, i - 5); k--) {
        if (/\slevels?$/i.test(base[k])) break;
        if (re.test(base[k])) return k;
      }
      return -1;
    };
    comp.push({ name: competencyName(m[1]), level: i, score: near(/overall score/i), verdict: near(/verdict/i), clearance: near(/clearance/i) });
  });
  // Old-process rounds: "<prefix> Score" + "<prefix> Status" (Bucket A TR 1, Bucket B TR 2, C Bucket TR 1).
  const rounds: { label: string; score: number; status: number }[] = [];
  base.forEach((b, i) => {
    const m = b.match(/^(.*\bTR\s*\d+)\s+score$/i);
    if (!m) return;
    const prefix = m[1].trim();
    rounds.push({ label: prefix, score: i, status: base.findIndex((x) => x.toLowerCase() === `${prefix.toLowerCase()} status`) });
  });

  const columns: AcColumn[] = labels.map((label, i) => ({ key: `s1:${i}`, label, source: "s1" as const }));

  // Sheet 2.
  const s2Tabs = src.s2.tabs.map(readS2Tab).filter((t): t is S2Tab => Boolean(t));
  if (src.s2.tabs.length && !s2Tabs.length) warnings.push("Sheet 2 has no competency interview tab (a tab with UID and Template / Overall Score columns).");
  for (const t of s2Tabs) {
    columns.push({ key: t.attemptsKey, label: `${t.name} · Interview attempts`, source: "s2" });
    for (const c of t.columns) columns.push({ key: c.key, label: c.label, source: "s2" });
  }

  // Sheet 3.
  const s3 = src.s3.tab;
  const s3Base = s3 ? columnLabels(s3.values, detectHeaderRow(s3.values)) : null;
  const s3Hr = s3 ? detectHeaderRow(s3.values) : 0;
  const s3Rows = s3 ? s3.values.slice(s3Hr + 1).filter((r) => (r ?? []).some((c) => norm(c))) : [];
  const s3Col = (re: RegExp) => (s3Base ? findCol(s3Base.base, re) : -1);
  const S3 = {
    uid: s3Col(/^(user\s*id|uid)$/i),
    mobile: s3Col(/mobile|phone/i),
    email: s3Col(/e-?mail/i),
    bucket: s3Col(/^bucket$/i),
    overall: s3Col(/overall_candidate_score|overall candidate score/i),
    coding: s3Col(/coding exam/i),
  };
  const s3Merge: { s3: number; s1: number }[] = [];
  const s3Out: { i: number; key: string }[] = [];
  if (s3Base) {
    s3Base.base.forEach((b, i) => {
      const pair = S3_INTO_S1.find(([re]) => re.test(b));
      const target = pair ? findCol(base, pair[1]) : -1;
      if (pair && target >= 0) s3Merge.push({ s3: i, s1: target });
      else if (!pair && i !== S3.bucket) {
        const key = `s3:${i}`;
        s3Out.push({ i, key });
        columns.push({ key, label: `Old process · ${s3Base.labels[i]}`, source: "s3" });
      }
    });
    if (S3.bucket >= 0) columns.push({ key: "s3:bucket", label: "Old process · Bucket (where sheet 1 has none)", source: "s3" });
  }
  const s3ByUid = new Map<string, string[]>();
  const s3ByMobile = new Map<string, string[]>();
  const s3ByEmail = new Map<string, string[]>();
  for (const r of s3Rows) {
    if (S3.uid >= 0 && lc(r[S3.uid])) s3ByUid.set(lc(r[S3.uid]), s3ByUid.get(lc(r[S3.uid])) ?? r);
    if (S3.mobile >= 0 && mobileKey(r[S3.mobile]).length === 10) s3ByMobile.set(mobileKey(r[S3.mobile]), s3ByMobile.get(mobileKey(r[S3.mobile])) ?? r);
    if (S3.email >= 0 && lc(r[S3.email])) s3ByEmail.set(lc(r[S3.email]), s3ByEmail.get(lc(r[S3.email])) ?? r);
  }

  const candidates: AcCandidate[] = [];
  const seen = new Set<string>();
  let dupes = 0;
  let noId = 0;
  g1.slice(hr + 1).forEach((raw, idx) => {
    const r = raw ?? [];
    if (!r.some((c) => norm(c))) return;
    const cell = (i: number) => (i >= 0 ? norm(r[i]) : "");
    const uid = cell(C.uid);
    const email = cell(C.email);
    const id = lc(uid) || lc(email);
    if (!id) {
      noId++;
      return;
    }
    if (seen.has(id)) {
      dupes++;
      return;
    }
    seen.add(id);

    const values: Record<string, string> = {};
    labels.forEach((_, i) => {
      values[`s1:${i}`] = cell(i);
    });

    const competencies: AcCompetency[] = comp.map((c) => ({
      name: c.name,
      bucket: competencyBucket(c.name),
      level: cell(c.level),
      score: num(cell(c.score)),
      verdict: cell(c.verdict),
      clearance: cell(c.clearance),
    }));
    const oldRounds: AcOldRound[] = rounds
      .map((x) => ({ label: x.label, score: cell(x.score), status: cell(x.status) }))
      .filter((x) => x.score || x.status);
    const oldBucket = oldBucketOf(cell(C.oldBucket));
    const dsaOffline = cell(C.dsaOffline);

    // Sheet 2 — the latest interview per competency tab.
    const s2Hit: string[] = [];
    const interviews: AcInterview[] = [];
    for (const t of s2Tabs) {
      const rows = (uid && t.byUid.get(lc(uid))) || (email && t.byEmail.get(lc(email))) || null;
      if (!rows?.length) continue;
      s2Hit.push(t.name);
      const pick = latestInterview(rows, t.statusCol);
      for (const c of t.columns) values[c.key] = norm(pick[c.i]);
      const at = (i: number) => (i >= 0 ? norm(pick[i]) : "");
      interviews.push({
        tab: t.name,
        status: at(t.statusCol),
        level: at(t.levelCol),
        integrityScore: at(t.integrityCol),
        integrityNote: at(t.integrityNoteCol).slice(0, 300),
        remarks: at(t.remarksCol).slice(0, 400),
      });
      const statuses = t.statusCol >= 0 ? rows.map((x) => norm(x[t.statusCol]) || "?") : [];
      values[t.attemptsKey] = rows.length === 1 ? `1${statuses[0] ? ` (${statuses[0]})` : ""}` : `${rows.length} (${statuses.join(", ")}) — latest completed shown`;
    }
    // A name missing in sheet 1 comes from sheet 2 when it has one.
    if (C.name >= 0 && !values[`s1:${C.name}`]) {
      for (const t of s2Tabs) {
        const rows = (uid && t.byUid.get(lc(uid))) || (email && t.byEmail.get(lc(email))) || null;
        if (rows?.[0] && t.nameCol >= 0 && norm(rows[0][t.nameCol])) {
          values[`s1:${C.name}`] = norm(rows[0][t.nameCol]);
          break;
        }
      }
    }

    // Sheet 3 — UID, then mobile, then email.
    let s3Row: string[] | undefined;
    let s3Match: AcCandidate["s3Match"] = "";
    if (uid && (s3Row = s3ByUid.get(lc(uid)))) s3Match = "uid";
    else if (cell(C.mobile) && (s3Row = s3ByMobile.get(mobileKey(cell(C.mobile))))) s3Match = "mobile";
    else if (email && (s3Row = s3ByEmail.get(lc(email)))) s3Match = "email";
    if (s3Row) {
      for (const m of s3Merge) if (!values[`s1:${m.s1}`]) values[`s1:${m.s1}`] = norm(s3Row[m.s3]);
      for (const o of s3Out) values[o.key] = norm(s3Row[o.i]);
      if (S3.bucket >= 0 && !oldBucket) values["s3:bucket"] = norm(s3Row[S3.bucket]);
    }

    candidates.push({
      id,
      uid,
      name: values[`s1:${C.name}`] ?? "",
      email,
      mobile: cell(C.mobile) || (C.mobile >= 0 ? values[`s1:${C.mobile}`] ?? "" : ""),
      resumeUrl: /^https?:\/\//i.test(cell(C.resume)) ? cell(C.resume) : "",
      activePool: /^yes\b/i.test(cell(C.active)),
      activePoolRaw: cell(C.active),
      placement: placementOf(cell(C.placement)),
      placementRaw: cell(C.placement),
      preference: cell(C.preference),
      dsaOffline,
      oldBucket,
      competencies,
      oldRounds,
      oldOverall: s3Row && S3.overall >= 0 ? num(s3Row[S3.overall]) : null,
      oldCoding: s3Row && S3.coding >= 0 ? num(s3Row[S3.coding]) : null,
      eligibility: readEligibility(competencies, dsaOffline, oldBucket),
      values,
      s2Tabs: s2Hit,
      interviews,
      s3Match,
      sheetRow: hr + 2 + idx,
    });
  });
  if (dupes) warnings.push(`${dupes} repeated UID row${dupes === 1 ? "" : "s"} in sheet 1 skipped (the first row of each UID is used).`);
  if (noId) warnings.push(`${noId} sheet 1 row${noId === 1 ? "" : "s"} with no UID or email skipped.`);
  if (!s3) warnings.push("Sheet 3 has no old-process tab (a tab with Bucket and overall_candidate_score columns) — old-process scores are blank.");

  return {
    loadedAt,
    sources: {
      s1: { url: src.s1.url, title: src.s1.title, tabs: [src.s1.tab.name] },
      s2: { url: src.s2.url, title: src.s2.title, tabs: s2Tabs.map((t) => t.name) },
      s3: { url: src.s3.url, title: src.s3.title, tabs: s3 ? [s3.name] : [] },
    },
    columns,
    candidates,
    warnings,
  };
}

// ── Picking the tabs ─────────────────────────────────────────────────────────

export interface AcTabPreview {
  name: string;
  rows: string[][];
}

const headerOf = (t: AcTabPreview) => (t.rows[detectHeaderRow(t.rows)] ?? []).map(norm);

/** Sheet 1: "Sahana Working New Criteria" when present, else the first tab with UID and Active Pool. */
export function pickMasterTab(tabs: AcTabPreview[]): string {
  const named = tabs.find((t) => /sahana working new criteria/i.test(t.name));
  if (named) return named.name;
  const fit = tabs.find((t) => {
    const h = headerOf(t);
    return h.some((x) => /^(uid|user\s*id)$/i.test(x)) && h.some((x) => /active\s*pool/i.test(x));
  });
  return (fit ?? tabs[0])?.name ?? "";
}

/** Sheet 2: every competency interview tab. */
export function pickCompetencyTabs(tabs: AcTabPreview[]): string[] {
  return tabs
    .filter((t) => {
      const h = headerOf(t);
      return h.some((x) => /^uid$/i.test(x)) && h.some((x) => /^template$/i.test(x) || /overall score/i.test(x));
    })
    .map((t) => t.name);
}

/** Sheet 3: the old-process tab (Bucket + overall_candidate_score), "Offline Attended - Old Process" first. */
export function pickOldProcessTab(tabs: AcTabPreview[]): string {
  const fits = tabs.filter((t) => {
    const h = headerOf(t);
    return h.some((x) => /^bucket$/i.test(x)) && h.some((x) => /overall_candidate_score|overall candidate score/i.test(x));
  });
  return (fits.find((t) => /old process/i.test(t.name)) ?? fits[0])?.name ?? "";
}
