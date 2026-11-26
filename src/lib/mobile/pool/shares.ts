import { createHash } from "node:crypto";
import { addDays, dayOf, type PrepRow } from "@/lib/mobile/preps/parse";

/**
 * Academy candidates shared with companies (PSM 1.10.0) — the pure part: reading the master
 * ">8 LPA Companies" sheet's CRPs tab and each company sheet, matching rows to the Academy assessed
 * pool, turning round / final-status cells into an outcome and a stage, finding what changed since
 * the last read, and the notification texts and dedupe keys. No network, no database: tested in
 * scripts/academy-shares-selftest.ts. The I/O is in shares-sync.ts.
 *
 * Everything here is typed by hand in Google Sheets, so every cell is read defensively: headers are
 * found by name (case, spacing and line breaks ignored), merged cells read blank, formula errors
 * (#REF!, #N/A …) read blank, and every tab is capped at MAX_ROWS_PER_TAB rows.
 */

// ── Shared helpers ──────────────────────────────────────────────────────────

export const MAX_ROWS_PER_TAB = 20_000;
export const MAX_ROUNDS = 20;
export const MAX_VALUE = 120;

const FORMULA_ERROR = /^#(REF!|N\/A|VALUE!|ERROR!|NAME\?|DIV\/0!|NULL!|NUM!)/i;

/** A cell as text: trimmed, spaces collapsed, formula errors blank. */
export function cellText(v: unknown, max = MAX_VALUE): string {
  const t = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!t || FORMULA_ERROR.test(t)) return "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A header cell, normalised for matching: lower case, curly quotes straightened, punctuation → space. */
export const normHead = (v: unknown) =>
  String(v ?? "")
    .normalize("NFKC")
    .replace(/[‘’ʼ`]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/'/g, "")
    .trim();

/** The last 10 digits of a cell when they form an Indian mobile number, else null. */
export function lastTen(raw: string): string | null {
  const d = raw.replace(/\D+/g, "");
  if (d.length < 10) return null;
  const ten = d.slice(-10);
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

/** Every mobile number in a cell ("9000000001 / +91 90000 00002"). */
export function phonesIn(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[\/,;|&\n]|\bor\b/i)) {
    const p = lastTen(part);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const cleanEmail = (raw: string): string | null => {
  const e = raw.trim().toLowerCase();
  return EMAIL.test(e) && e.length <= 254 ? e : null;
};

/** The spreadsheet id of a Google Sheets link, else null (Drive files, portals and text are not sheets). */
export function sheetIdOf(link: string): string | null {
  const m = link.match(/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]{20,})/i);
  return m ? m[1] : null;
}

export const sheetUrl = (id: string, gid?: number | null) =>
  `https://docs.google.com/spreadsheets/d/${id}/edit${gid != null && gid >= 0 ? `#gid=${gid}` : ""}`;

// ── The CRPs master ─────────────────────────────────────────────────────────

export type MasterField = "company" | "role" | "jobId" | "crpMonth" | "ise" | "crm" | "finalStatus" | "stage" | "link";

const MASTER_HEADERS: Record<MasterField, string[]> = {
  company: ["company name", "company"],
  role: ["role", "job role", "designation"],
  jobId: ["job id", "jobid"],
  crpMonth: ["crp month"],
  ise: ["ise"],
  crm: ["crm"],
  finalStatus: ["final status"],
  stage: ["current stage of interview", "current stage"],
  link: ["company sheet link", "company sheet"],
};

export interface MasterSheet {
  sheetId: string;
  company: string;
  roles: string[];
  jobIds: string[];
  crpMonths: string[];
  ise: string;
  crm: string;
  masterFinalStatus: string;
  masterStage: string;
  /** How many CRP rows point at this sheet. */
  rows: number;
}

export interface MasterParse {
  sheets: MasterSheet[];
  /** Data rows read (non-empty). */
  rows: number;
  /** Rows with a Company Sheet Link that isn't a Google Sheet (a portal page, a Drive file). */
  notSheetLinks: number;
  /** Rows with no Company Sheet Link at all. */
  noLink: number;
}

const pushDistinct = (list: string[], v: string, max = 20) => {
  if (v && list.length < max && !list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(v);
};

/**
 * The CRPs tab (header row 1, columns by name) → one entry per distinct company sheet. Company Name is
 * a merged cell over a company's role rows, so a blank one belongs to the row above.
 */
export function parseCrpsMaster(rows: unknown[][]): MasterParse {
  const head = (rows[0] ?? []).map(normHead);
  const col: Partial<Record<MasterField, number>> = {};
  for (const f of Object.keys(MASTER_HEADERS) as MasterField[]) {
    const at = head.findIndex((h) => MASTER_HEADERS[f].includes(h));
    if (at >= 0) col[f] = at;
  }
  if (col.company === undefined || col.link === undefined) {
    throw new Error('The CRPs tab has no "Company Name" or "Company Sheet Link" column in row 1.');
  }
  const at = (r: unknown[], f: MasterField, max = 200) => (col[f] === undefined ? "" : cellText(r[col[f]!], max));
  const bySheet = new Map<string, MasterSheet & { statuses: string[]; stages: string[]; ises: string[]; crms: string[] }>();
  let company = "";
  let read = 0;
  let notSheetLinks = 0;
  let noLink = 0;
  const end = Math.min(rows.length, MAX_ROWS_PER_TAB + 1);
  for (let i = 1; i < end; i++) {
    const r = rows[i] ?? [];
    if (!r.some((c) => cellText(c))) continue;
    read++;
    const name = at(r, "company");
    if (name) company = name;
    const link = String(r[col.link!] ?? "").trim();
    if (!link) {
      noLink++;
      continue;
    }
    const id = sheetIdOf(link);
    if (!id) {
      notSheetLinks++;
      continue;
    }
    const s =
      bySheet.get(id) ??
      { sheetId: id, company: company || name, roles: [], jobIds: [], crpMonths: [], ise: "", crm: "", masterFinalStatus: "", masterStage: "", rows: 0, statuses: [], stages: [], ises: [], crms: [] };
    if (!s.company) s.company = company || name;
    s.rows++;
    pushDistinct(s.roles, at(r, "role"));
    pushDistinct(s.jobIds, at(r, "jobId", 80));
    pushDistinct(s.crpMonths, at(r, "crpMonth", 40));
    pushDistinct(s.ises, at(r, "ise", 80), 5);
    pushDistinct(s.crms, at(r, "crm", 80), 5);
    pushDistinct(s.statuses, at(r, "finalStatus", 120), 5);
    pushDistinct(s.stages, at(r, "stage", 120), 5);
    bySheet.set(id, s);
  }
  const join = (l: string[]) => l.join(" / ").slice(0, 200);
  const sheets = [...bySheet.values()].map(({ statuses, stages, ises, crms, ...s }) => ({
    ...s,
    company: s.company.slice(0, 200) || "Company",
    ise: join(ises),
    crm: join(crms),
    masterFinalStatus: join(statuses),
    masterStage: join(stages),
  }));
  return { sheets, rows: read, notSheetLinks, noLink };
}

/** The master says the requirement is over (closed / nobody selected): its shares are no longer active. */
export const masterClosed = (masterFinalStatus: string) => /closed|no candidate selected|cancel/i.test(masterFinalStatus);

// ── Company sheet tabs ──────────────────────────────────────────────────────

export interface TabInfo {
  title: string;
  gid: number;
  hidden: boolean;
  rowCount: number;
  columnCount: number;
}

/** The tabs worth reading: visible, and not a "Read me". Hidden tabs are raw exports or copies. */
export function pickTabs(tabs: TabInfo[]): TabInfo[] {
  return tabs.filter((t) => !t.hidden && !/^\s*read\s*-?\s*me\b/i.test(t.title) && !/\breadme\b/i.test(t.title));
}

const PHONE_HEAD = /\b(mobile|phone|contact)\b/;
const NOT_PHONE_HEAD = /\b(parent|guardian|father|mother|emergency|spoc|poc|recruiter|company|hr|interviewer|panel)\b/;
const EMAIL_HEAD = /\b(e ?mail|mail id|mail)\b/;
const NAME_HEAD = /^(full name|name|candidate name|student name|candidate|name of the candidate|candidate full name)$/;
const RESUME_HEAD = /\b(resume|cv)\b/;
const NOT_RESUME_HEAD = /shortlist|select|screen|round|status|score|feedback|remark|review/;
const FINAL_HEADS = [/^final status$/, /^final result$/, /^final decision$/, /^final outcome$/, /^overall status$/, /^status$/];
const ROUND_HEAD =
  /\bround|\btr ?\d|\btr\b|\bhr\b|\bmr\b|\bgd\b|\br\d\b|assessment|assignment|\btest\b|interview|screening|shortlist|\bcall\b|coding|aptitude|technical|managerial|culture|offline drive|\bdrive\b|case study|\btask\b|evaluation|discussion|presentation/;
const NOT_ROUND_HEAD =
  /link|recording|\burl\b|github|deployed|document|\bdoc\b|video|remark|comment|reason|feedback|\bnote|panel|\bspoc\b|\bpoc\b|\btime|timing|slot|\bdate\b|\bmeet\b|availab|location|\bstate\b|\bcity\b|portal|skill|summary|score|marks|percentage|cgpa|college|course|department|\byear\b|graduation|degree|branch|e ?mail|\bmail\b|phone|mobile|\bname\b|\bsent\b|registered|attendance|\bmode\b|venue|\bctc\b|notice|experience|company|current|expected|recruiter|interviewer|evaluator|\bby\b|\bsheet\b|\bform\b|willing|\bare you\b|\bdo you\b|\bhave you\b|\bconfirm|challenge|\bwhy\b|\bhow\b|\bwhat\b|describe|explain/;

export interface TabRound {
  index: number;
  name: string;
}

export interface TabColumns {
  /** 0-based header row (within the first 6 rows). */
  headerRow: number;
  phones: number[];
  emails: number[];
  name: number | null;
  resume: number | null;
  finalStatus: number | null;
  /** Round columns in sheet order. */
  rounds: TabRound[];
}

/**
 * The header row (within the first 6 rows) and its columns: phone(s), email(s), name, resume, round
 * columns and Final Status. Null when the tab has no phone header or nothing about a process (a
 * "Selected Candidates" list with only name and number): such tabs are not shares.
 */
export function findTabColumns(rows: unknown[][]): TabColumns | null {
  const limit = Math.min(rows.length, 6);
  let fallback: number | null = null;
  for (let r = 0; r < limit; r++) {
    const head = (rows[r] ?? []).map(normHead);
    const phones = head.map((h, i) => (h && PHONE_HEAD.test(h) && !NOT_PHONE_HEAD.test(h) ? i : -1)).filter((i) => i >= 0);
    if (!phones.length) continue;
    const emails = head.map((h, i) => (h && EMAIL_HEAD.test(h) && !/parent|guardian/.test(h) && !phones.includes(i) ? i : -1)).filter((i) => i >= 0);
    const nameAt = head.findIndex((h) => NAME_HEAD.test(h));
    const resumeAt = head.findIndex((h) => RESUME_HEAD.test(h) && !NOT_RESUME_HEAD.test(h));
    const looksLikeHeader = emails.length > 0 || nameAt >= 0 || resumeAt >= 0;
    if (!looksLikeHeader) {
      if (fallback === null && head.filter(Boolean).length >= 3) fallback = r;
      continue;
    }
    return columnsAt(head, r, phones, emails, nameAt, resumeAt);
  }
  if (fallback === null) return null;
  const head = (rows[fallback] ?? []).map(normHead);
  const phones = head.map((h, i) => (h && PHONE_HEAD.test(h) && !NOT_PHONE_HEAD.test(h) ? i : -1)).filter((i) => i >= 0);
  return columnsAt(head, fallback, phones, [], -1, -1);
}

function columnsAt(head: string[], headerRow: number, phones: number[], emails: number[], nameAt: number, resumeAt: number): TabColumns | null {
  let finalAt = -1;
  for (const re of FINAL_HEADS) {
    finalAt = head.findIndex((h) => re.test(h));
    if (finalAt >= 0) break;
  }
  const taken = new Set([...phones, ...emails, nameAt, resumeAt, finalAt]);
  const rounds: TabRound[] = [];
  head.forEach((h, i) => {
    if (!h || taken.has(i) || rounds.length >= MAX_ROUNDS) return;
    if (ROUND_HEAD.test(h) && !NOT_ROUND_HEAD.test(h)) rounds.push({ index: i, name: "" });
  });
  if (resumeAt < 0 && finalAt < 0 && !rounds.length) return null;
  return { headerRow, phones, emails, name: nameAt >= 0 ? nameAt : null, resume: resumeAt >= 0 ? resumeAt : null, finalStatus: finalAt >= 0 ? finalAt : null, rounds };
}

/** findTabColumns with the round names as typed (the header row's own text). */
export function tabColumns(rows: unknown[][]): TabColumns | null {
  const cols = findTabColumns(rows);
  if (!cols) return null;
  const raw = rows[cols.headerRow] ?? [];
  return { ...cols, rounds: cols.rounds.map((r) => ({ index: r.index, name: cellText(raw[r.index], 60) || `Round ${r.index + 1}` })) };
}

export interface Round {
  name: string;
  value: string;
}

export interface TabRow {
  /** 1-based sheet row. */
  sheetRow: number;
  phones: string[];
  email: string | null;
  rounds: Round[];
  finalStatus: string;
  /** When the resume was uploaded (the 13-digit ms stamp in form-upload links), if the link has one. */
  resumeAt: number | null;
}

const RESUME_STAMP = /(?<!\d)(1[5-9]\d{11})(?!\d)/;

/** The upload moment in a resume link ("…/1730000000000_resume.pdf"), when plausible. */
export function resumeStamp(link: string, now = Date.now()): number | null {
  const m = link.match(RESUME_STAMP);
  if (!m) return null;
  const t = Number(m[1]);
  return t >= Date.UTC(2019, 0, 1) && t <= now + 86_400_000 ? t : null;
}

/** The data rows of a tab (header found by [tabColumns]), at most MAX_ROWS_PER_TAB. Rows with no phone and no email are skipped. */
export function readTabRows(rows: unknown[][], cols: TabColumns, now = Date.now()): TabRow[] {
  const out: TabRow[] = [];
  const end = Math.min(rows.length, cols.headerRow + 1 + MAX_ROWS_PER_TAB);
  for (let i = cols.headerRow + 1; i < end; i++) {
    const r = rows[i] ?? [];
    const phones: string[] = [];
    for (const c of cols.phones) for (const p of phonesIn(String(r[c] ?? ""))) if (!phones.includes(p)) phones.push(p);
    let email: string | null = null;
    for (const c of cols.emails) {
      email = cleanEmail(String(r[c] ?? ""));
      if (email) break;
    }
    if (!phones.length && !email) continue;
    const rounds: Round[] = [];
    for (const rc of cols.rounds) {
      const value = cellText(r[rc.index]);
      if (value) rounds.push({ name: rc.name, value });
    }
    out.push({
      sheetRow: i + 1,
      phones,
      email,
      rounds,
      finalStatus: cols.finalStatus === null ? "" : cellText(r[cols.finalStatus]),
      resumeAt: cols.resume === null ? null : resumeStamp(String(r[cols.resume] ?? ""), now),
    });
  }
  return out;
}

// ── Outcome and stage ───────────────────────────────────────────────────────

export const SHARE_OUTCOMES = ["selected", "rejected", "in_process", "on_hold", "no_show", "unknown"] as const;
export type ShareOutcome = (typeof SHARE_OUTCOMES)[number];

/** Most advanced first: selected beats in process, which beats rejected. */
export const OUTCOME_RANK: Record<ShareOutcome, number> = { selected: 6, in_process: 5, on_hold: 4, unknown: 3, no_show: 2, rejected: 1 };

const NO_SHOW =
  /\b(absent|no ?show|did ?n ?'?o?t (join|attend|turn up|show up|appear|attempt)|didnt (join|attend|attempt)|not (joined|attended|appeared|turned up|attempted)|dnj)\b/;
const NEGATIVE =
  /\b(not|no|non|un) ?(selected|shortlisted|cleared|qualified|interested|a fit|fit|moving forward|moved|progressing|suitable|considered|offer|proceeding|accepted|hired|placed|completed|submitted)\b|\b(did ?n ?'?o?t|didnt) (complete|submit|clear|pass|qualify)\b|\breject|\bfail(ed|s)?\b|\bdisqualif|\bdropped\b|\bdrop ?out\b|\bdeclined\b|\bunsuccessful\b|\b(requirement|position|role|hiring|job|process|opening)( is| has been| was)? (closed|cancelled|canceled)\b/;
const HOLD = /\bhold\b|\bon ?hold\b|\bparked\b/;
const NEXT = /next round|next stage|\bmoved\b|\bmoving (to|ahead|forward)\b|\bpromoted\b/;
const STRONG_SELECTED = /\b(hired|offer(ed)?|placed|joined|onboarded|accepted)\b|yet to join|joining (date|on)/;
const SELECTED = /\bselect(ed|ion)?\b/;
const IN_PROCESS =
  /\b(clear(ed)?|shortlist(ed)?|pass(ed)?|qualified|through|scheduled|reschedul\w*|pending|await(ing|ed)?|waiting|in ?pro(gress|cess)|ongoing|yet to|to be|tbd|under review|in review|submitted|attempted|complete(d)?|done|interview(ed|ing)|attended|registered|invited|sent|shared|go ahead|proceed(ed|ing)?|positive)\b|\br\d ?(clear|pass)/;

/**
 * One cell → an outcome. [kind] "round": "Selected" in a round column means the round was cleared
 * (in process), unless it is the tab's last round; "Yes"/"No" count there too. "final": the Final
 * Status column, where "Selected" means selected.
 */
export function outcomeOfValue(raw: string, kind: "final" | "round" = "final", lastRound = false): ShareOutcome {
  const s = String(raw ?? "")
    .normalize("NFKC")
    .replace(/[‘’ʼ`]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "unknown";
  if (NO_SHOW.test(s)) return /panel|interviewer/.test(s) ? "in_process" : "no_show";
  if (NEGATIVE.test(s)) return "rejected";
  if (HOLD.test(s)) return "on_hold";
  if (NEXT.test(s)) return "in_process";
  if (STRONG_SELECTED.test(s)) return "selected";
  if (SELECTED.test(s)) return kind === "final" || lastRound ? "selected" : "in_process";
  if (IN_PROCESS.test(s)) return "in_process";
  if (kind === "round") {
    if (/^(yes|y|ok|okay)$/.test(s)) return "in_process";
    if (/^(no|n)$/.test(s)) return "rejected";
  }
  return "unknown";
}

const SCREENING_ROUND = /resume|shortlist|screening|application|profile/i;

/**
 * The rounds in the order they happen: resume shortlisting / screening first (some sheets put
 * "Resume Shortlisted" after Final Status), then sheet order.
 */
function logical<T extends { name: string }>(rounds: T[]): T[] {
  return rounds
    .map((r, i) => ({ r, k: SCREENING_ROUND.test(r.name) ? -1 : i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.r);
}

/**
 * The share's outcome: from Final Status first, otherwise from the latest non-empty round (the
 * latest one that says something, when the last one is a typed name or a note). [lastRoundName] is
 * the tab's last round column, where "Selected" means selected.
 */
export function shareOutcome(rounds: Round[], finalStatus: string, lastRoundName?: string): ShareOutcome {
  if (finalStatus) {
    const f = outcomeOfValue(finalStatus, "final");
    if (f !== "unknown") return f;
  }
  const ordered = logical(rounds);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const r = ordered[i];
    const o = outcomeOfValue(r.value, "round", lastRoundName !== undefined && r.name === lastRoundName);
    if (o !== "unknown") return o;
  }
  return "unknown";
}

const clipLabel = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A short label: "Selected", "TR Round 1 · Cleared", "Assignment Round · Pending", "Shared". */
export function shareStage(rounds: Round[], finalStatus: string): string {
  if (finalStatus && outcomeOfValue(finalStatus, "final") !== "unknown") return clipLabel(finalStatus, 60);
  const ordered = logical(rounds);
  const latest = ordered[ordered.length - 1];
  if (latest) return clipLabel(`${latest.name} · ${clipLabel(latest.value, 40)}`, 80);
  if (finalStatus) return clipLabel(finalStatus, 60);
  return "Shared";
}

/** The most advanced of several outcomes (null: none). */
export function bestOutcome(outcomes: ShareOutcome[]): ShareOutcome | null {
  let best: ShareOutcome | null = null;
  for (const o of outcomes) if (!best || OUTCOME_RANK[o] > OUTCOME_RANK[best]) best = o;
  return best;
}

/** Still going: not finished (selected / rejected / no show), and the company hasn't closed the requirement. */
export const isActiveShare = (outcome: ShareOutcome, masterFinalStatus: string) =>
  (outcome === "in_process" || outcome === "on_hold" || outcome === "unknown") && !masterClosed(masterFinalStatus);

/** What a change is compared by: the rounds and the final status. */
export function shareHash(rounds: Round[], finalStatus: string): string {
  return createHash("sha1").update(JSON.stringify([rounds.map((r) => [r.name.toLowerCase(), r.value.toLowerCase()]), finalStatus.toLowerCase()])).digest("hex").slice(0, 16);
}

// ── Matching and building shares ────────────────────────────────────────────

export interface PoolIndex {
  byPhone: Map<string, string>;
  byEmail: Map<string, string>;
}

export function poolIndex(candidates: { uid: string; phone: string | null; email: string | null }[]): PoolIndex {
  const byPhone = new Map<string, string>();
  const byEmail = new Map<string, string>();
  for (const c of candidates) {
    if (c.phone && !byPhone.has(c.phone)) byPhone.set(c.phone, c.uid);
    if (c.email && !byEmail.has(c.email)) byEmail.set(c.email, c.uid);
  }
  return { byPhone, byEmail };
}

/** The pool candidate a company-sheet row is: last 10 digits of any phone, then email. Null: not Academy assessed (never stored). */
export function matchRow(row: Pick<TabRow, "phones" | "email">, idx: PoolIndex): { uid: string; phone: string | null } | null {
  for (const p of row.phones) {
    const uid = idx.byPhone.get(p);
    if (uid) return { uid, phone: p };
  }
  if (row.email) {
    const uid = idx.byEmail.get(row.email);
    if (uid) return { uid, phone: row.phones[0] ?? null };
  }
  return null;
}

export interface ShareRecord {
  tab: string;
  gid: number | null;
  uid: string;
  phone: string | null;
  company: string;
  role: string;
  rounds: Round[];
  finalStatus: string;
  stage: string;
  outcome: ShareOutcome;
  hash: string;
  resumeAt: number | null;
}

export interface SheetTab {
  info: TabInfo;
  rows: unknown[][];
}

export interface BuiltSheet {
  shares: ShareRecord[];
  /** Tabs that had a candidate header (read as share lists). */
  tabsRead: number;
  /** Rows matched to the Academy assessed pool (before de-duplication). */
  academyRows: number;
  /** Rows with a phone or email in candidate tabs. */
  rowsSeen: number;
}

/**
 * Every Academy assessed candidate in a company sheet's tabs. A candidate listed twice in a tab
 * keeps the row that got furthest (most round values). Role = the tab title, or the master Role
 * when the sheet has a single candidate tab.
 */
export function buildShares(sheet: Pick<MasterSheet, "company" | "roles">, tabs: SheetTab[], idx: PoolIndex, now = Date.now()): BuiltSheet {
  const parsed = pickTabs(tabs.map((t) => t.info))
    .map((info) => {
      const t = tabs.find((x) => x.info.gid === info.gid && x.info.title === info.title)!;
      const cols = tabColumns(t.rows);
      return cols ? { info, cols, rows: readTabRows(t.rows, cols, now) } : null;
    })
    .filter((x): x is { info: TabInfo; cols: TabColumns; rows: TabRow[] } => x !== null);
  const single = parsed.length === 1;
  const masterRole = sheet.roles.join(" / ").slice(0, 200);
  const shares: ShareRecord[] = [];
  let academyRows = 0;
  let rowsSeen = 0;
  for (const p of parsed) {
    const tab = p.info.title.slice(0, 200);
    const role = (single && masterRole ? masterRole : p.info.title.trim()).slice(0, 200) || masterRole || "—";
    const lastRound = logical(p.cols.rounds).at(-1)?.name;
    const byUid = new Map<string, ShareRecord>();
    for (const row of p.rows) {
      rowsSeen++;
      const m = matchRow(row, idx);
      if (!m) continue;
      academyRows++;
      const prev = byUid.get(m.uid);
      if (prev && prev.rounds.length + (prev.finalStatus ? 1 : 0) >= row.rounds.length + (row.finalStatus ? 1 : 0)) continue;
      byUid.set(m.uid, {
        tab,
        gid: Number.isInteger(p.info.gid) ? p.info.gid : null,
        uid: m.uid,
        phone: m.phone,
        company: sheet.company,
        role,
        rounds: row.rounds,
        finalStatus: row.finalStatus,
        stage: shareStage(row.rounds, row.finalStatus),
        outcome: shareOutcome(row.rounds, row.finalStatus, lastRound),
        hash: shareHash(row.rounds, row.finalStatus),
        resumeAt: row.resumeAt,
      });
    }
    shares.push(...byUid.values());
  }
  return { shares, tabsRead: parsed.length, academyRows, rowsSeen };
}

/**
 * When a share found at a sheet's first read (the baseline) was most likely made: not before the
 * sheet existed, and not before the candidate's resume was uploaded; never in the future.
 */
export function baselineSharedAt(resumeAt: number | null, sheetCreatedAt: number | null, now: number): number {
  const floor = Math.max(resumeAt ?? 0, sheetCreatedAt ?? 0);
  return floor > 0 && floor <= now ? floor : now;
}

// ── Change detection ────────────────────────────────────────────────────────

export interface StoredShare {
  id: string;
  tab: string;
  uid: string;
  rounds: Round[];
  finalStatus: string;
  outcome: ShareOutcome;
  hash: string;
  firstSeenAt: number;
  changedAt: number;
  removed: boolean;
}

export type ShareEvent =
  | { type: "new"; share: ShareRecord }
  | { type: "status"; share: ShareRecord; prev: Pick<StoredShare, "rounds" | "finalStatus" | "outcome" | "id"> };

export interface ShareWrite extends ShareRecord {
  /** The stored row this one continues (same tab, or the same candidate under a renamed tab). */
  from: StoredShare | null;
  changed: boolean;
  outcomeChanged: boolean;
}

export interface ShareDiff {
  writes: ShareWrite[];
  /** Stored, still-active rows that are no longer in the sheet (their keys). */
  removed: StoredShare[];
  events: ShareEvent[];
}

const keyOf = (tab: string, uid: string) => `${tab}\u0000${uid}`;

/**
 * Compares a fresh read of one sheet with what is stored for it.
 *  - new key → "new" (a share), unless the same candidate just left another tab of this sheet or
 *    was removed earlier (a renamed / restored tab is not a new share);
 *  - same key, other rounds or final status → "status";
 *  - stored rows not in the read → removed.
 * [baseline] (the sheet's first read) records everything and reports no events.
 */
export function diffShares(stored: StoredShare[], next: ShareRecord[], baseline: boolean): ShareDiff {
  const byKey = new Map(stored.map((s) => [keyOf(s.tab, s.uid), s]));
  const nextKeys = new Set(next.map((n) => keyOf(n.tab, n.uid)));
  // Rows of each candidate that this read no longer has (left a tab now, or removed before).
  const leftovers = new Map<string, StoredShare[]>();
  for (const s of stored) {
    if (nextKeys.has(keyOf(s.tab, s.uid))) continue;
    const l = leftovers.get(s.uid) ?? [];
    l.push(s);
    leftovers.set(s.uid, l);
  }
  for (const l of leftovers.values()) l.sort((a, b) => Number(a.removed) - Number(b.removed) || b.changedAt - a.changedAt);
  const writes: ShareWrite[] = [];
  const events: ShareEvent[] = [];
  for (const n of next) {
    let from = byKey.get(keyOf(n.tab, n.uid)) ?? null;
    if (!from) from = leftovers.get(n.uid)?.shift() ?? null;
    const changed = !from || from.hash !== n.hash;
    const outcomeChanged = !from || from.outcome !== n.outcome;
    writes.push({ ...n, from, changed, outcomeChanged });
    if (baseline) continue;
    if (!from) events.push({ type: "new", share: n });
    else if (from.hash !== n.hash) events.push({ type: "status", share: n, prev: from });
  }
  const removed = stored.filter((s) => !s.removed && !nextKeys.has(keyOf(s.tab, s.uid)));
  return { writes, removed, events };
}

// ── Notifications ───────────────────────────────────────────────────────────

/** "TR Round 1: Cleared · Final status: Selected" — what changed (at most 3 items, then "+n more"). */
export function statusChangeText(prev: { rounds: Round[]; finalStatus: string } | null, next: { rounds: Round[]; finalStatus: string; stage: string }): string {
  const was = new Map((prev?.rounds ?? []).map((r) => [r.name.toLowerCase(), r.value]));
  const items: string[] = [];
  if (next.finalStatus && next.finalStatus.toLowerCase() !== (prev?.finalStatus ?? "").toLowerCase()) items.push(`Final status: ${next.finalStatus}`);
  for (const r of [...next.rounds].reverse()) {
    if ((was.get(r.name.toLowerCase()) ?? "").toLowerCase() !== r.value.toLowerCase()) items.push(`${r.name}: ${r.value}`);
  }
  if (!items.length) return `Now: ${next.stage}`;
  const shown = items.slice(0, 3).join(" · ");
  return items.length > 3 ? `${shown} · +${items.length - 3} more` : shown;
}

/** At most [cap] pushes per person per run: the first cap-1 as they are, the rest in one summary. */
export function capPushes<T>(items: T[], cap = 30): { send: T[]; summarised: T[] } {
  if (items.length <= cap) return { send: items, summarised: [] };
  return { send: items.slice(0, cap - 1), summarised: items.slice(cap - 1) };
}

export interface DigestCounts {
  today: number;
  todayMine: number;
  tomorrow: number;
  tomorrowMine: number;
  sharedYesterday: number;
  selectedThisWeek: number;
}

/**
 * "Academy interviews today 5 (2 yours) · tomorrow 3 · shared yesterday 12 · selected this week 1".
 * Zero parts are left out; null when every number is zero (no digest that day).
 */
export function digestText(c: DigestCounts): string | null {
  const mine = (n: number) => (n > 0 ? ` (${n} yours)` : "");
  const iv = [c.today > 0 ? `today ${c.today}${mine(c.todayMine)}` : "", c.tomorrow > 0 ? `tomorrow ${c.tomorrow}${mine(c.tomorrowMine)}` : ""].filter(Boolean);
  const rest = [c.sharedYesterday > 0 ? `shared yesterday ${c.sharedYesterday}` : "", c.selectedThisWeek > 0 ? `selected this week ${c.selectedThisWeek}` : ""].filter(Boolean);
  if (!iv.length && !rest.length) return null;
  if (iv.length) return [`Academy interviews ${iv[0]}`, ...iv.slice(1), ...rest].join(" · ");
  return `Academy: ${rest.join(" · ")}`;
}

/** "today", "tomorrow" or "Thu 28 Nov" for an IST day. */
export function dayLabel(day: string, today: string): string {
  if (day === today) return "today";
  const t = Date.parse(`${today}T00:00:00Z`);
  const d = Date.parse(`${day}T00:00:00Z`);
  if (d - t === 86_400_000) return "tomorrow";
  return new Date(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
}

const clock = (m: number) => {
  const h = Math.floor(m / 60) % 24;
  return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

/** "4:00 PM – 5:00 PM", or the cell's text when it couldn't be read. */
export function interviewTimeLabel(p: Pick<PrepRow, "interviewTime" | "interviewTimeText">): string {
  if (p.interviewTime) return [clock(p.interviewTime.start), p.interviewTime.end != null ? clock(p.interviewTime.end) : null].filter(Boolean).join(" – ");
  return p.interviewTimeText.slice(0, 40);
}

/** What a change of time is compared by: the minutes, else the typed text. */
export function interviewTimeKey(p: Pick<PrepRow, "interviewTime" | "interviewTimeText">): string {
  if (p.interviewTime) return `${p.interviewTime.start}-${p.interviewTime.end ?? ""}`;
  return p.interviewTimeText.toLowerCase().replace(/\s+/g, "").slice(0, 40);
}

/** A drill-down row that counts as an Academy interview: dated, not cancelled or moved to another row. */
export const isLiveInterview = (p: Pick<PrepRow, "interviewDay" | "interviewState">) =>
  p.interviewDay !== null && p.interviewState !== "cancelled" && p.interviewState !== "rescheduled";

/** The Monday (IST) of [day]'s week. */
export function weekStart(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

const keyPart = (s: string) => s.replace(/[^\w@.+-]+/g, "_").slice(0, 80);

/** The dedupe keys of the 1.10.0 pushes (one push per key, ever). */
export const poolDedupe = {
  assigned: (uid: string, email: string) => `pool:assigned:${uid}:${email}`,
  shared: (shareId: string, email: string) => `pool:shared:${shareId}:${email}`,
  status: (shareId: string, hash: string, email: string) => `pool:status:${shareId}:${hash}:${email}`,
  interview: (prepKey: string, day: string, time: string, email: string) => `pool:iv:${prepKey}:${day}:${keyPart(time) || "-"}:${email}`,
  meeting: (meetingId: string, email: string) => `pool:meet:${meetingId}:${email}`,
  digest: (day: string, email: string) => `academy:digest:${day}:${email}`,
  /** The "n updates for your candidates" push of one run. */
  summary: (run: string, email: string) => `pool:summary:${keyPart(run)}:${email}`,
};

// ── What the app reads ──────────────────────────────────────────────────────

export interface ShareDto {
  id: string;
  company: string;
  role: string;
  tab: string;
  sheetUrl: string;
  /** first_seen date, YYYY-MM-DD IST. */
  sharedOn: string;
  rounds: Round[];
  finalStatus: string;
  stage: string;
  outcome: ShareOutcome;
  updatedAt: string;
}

export interface ShareRowLike {
  id: string;
  sheet_id: string;
  tab: string;
  tab_gid: number | null;
  company: string;
  role: string;
  rounds: unknown;
  final_status: string;
  stage: string;
  outcome: string;
  first_seen_at: Date;
  changed_at: Date;
}

const isOutcome = (v: string): v is ShareOutcome => (SHARE_OUTCOMES as readonly string[]).includes(v);

/** Rounds from the jsonb column, defensively (only {name, value} strings). */
export function roundsOf(raw: unknown): Round[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is { name: unknown; value: unknown } => typeof r === "object" && r !== null)
    .map((r) => ({ name: String(r.name ?? ""), value: String(r.value ?? "") }))
    .filter((r) => r.name && r.value)
    .slice(0, MAX_ROUNDS);
}

export function shareDto(r: ShareRowLike): ShareDto {
  return {
    id: String(r.id),
    company: r.company,
    role: r.role,
    tab: r.tab,
    sheetUrl: sheetUrl(r.sheet_id, r.tab_gid),
    sharedOn: dayOf(r.first_seen_at),
    rounds: roundsOf(r.rounds),
    finalStatus: r.final_status,
    stage: r.stage,
    outcome: isOutcome(r.outcome) ? r.outcome : "unknown",
    updatedAt: r.changed_at.toISOString(),
  };
}

/** Newest activity first. */
export const byActivity = (a: Pick<ShareRowLike, "changed_at" | "first_seen_at">, b: Pick<ShareRowLike, "changed_at" | "first_seen_at">) =>
  Math.max(b.changed_at.getTime(), b.first_seen_at.getTime()) - Math.max(a.changed_at.getTime(), a.first_seen_at.getTime());
