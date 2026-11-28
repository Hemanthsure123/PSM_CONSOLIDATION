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

export type MasterField =
  | "company"
  | "role"
  | "jobId"
  | "crpMonth"
  | "crpWeek"
  | "jobType"
  | "openings"
  | "ctc"
  | "jd"
  | "hubspot"
  | "requested"
  | "techStack"
  | "passOut"
  | "interviewProcess"
  | "idStatus"
  | "idMonth"
  | "academySent"
  | "assessedSent"
  | "nonAssessedSent"
  | "ise"
  | "crm"
  | "finalStatus"
  | "stage"
  | "internal"
  | "link";

const MASTER_HEADERS: Record<MasterField, string[]> = {
  company: ["company name", "company"],
  role: ["role", "job role", "designation"],
  jobId: ["job id", "jobid"],
  crpMonth: ["crp month"],
  crpWeek: ["crp week"],
  jobType: ["job type"],
  openings: ["no of openings", "number of openings", "openings", "no of positions"],
  ctc: ["ctc", "ctc lpa", "ctc in lpa"],
  jd: ["jd", "jd link", "job description", "job description link"],
  hubspot: ["hubspot link", "hubspot"],
  requested: ["requested the academy profiles"],
  techStack: ["tech stack"],
  passOut: ["pass out year", "passout year"],
  interviewProcess: ["interview process"],
  idStatus: ["company id status"],
  idMonth: ["id month"],
  academySent: ["total academy pool shared"],
  assessedSent: ["no of assessed academy shared"],
  nonAssessedSent: ["no of non assessed academy profiles shared", "no of non assessed academy shared"],
  ise: ["ise"],
  crm: ["crm"],
  finalStatus: ["final status"],
  stage: ["current stage of interview", "current stage"],
  internal: ["internal sheet link", "internal sheet", "internal link"],
  link: ["company sheet link", "company sheet"],
};

/**
 * One row of the CRPs tab: one company requirement (role) of one CRP. Every value as typed, except
 * the counts and openings (whole numbers, null when blank or not a number). [key] is stable across
 * reads (job id, month, week, sheet), so a tentative start date stays with its requirement.
 */
export interface MasterRequirement {
  key: string;
  /** 1-based row in the CRPs tab. */
  row: number;
  sheetId: string | null;
  company: string;
  role: string;
  jobId: string;
  jobType: string;
  crpMonth: string;
  crpWeek: number | null;
  openings: number | null;
  ctcText: string;
  finalStatus: string;
  stage: string;
  idStatus: string;
  academySent: number | null;
  assessedSent: number | null;
  nonAssessedSent: number | null;
  requested: string;
  techStack: string;
  passOut: string;
  interviewProcess: string;
  ise: string;
  crm: string;
  /** The JD column when it holds a link (the cell's text, or its hyperlink). */
  jdUrl: string | null;
  hubspotUrl: string | null;
  hubspotDealId: string | null;
  /** 1.13.0: the requirement's internal sheet (applicants exported from the platform, application forms). */
  internalSheetId: string | null;
  /** 1.13.0: the month its ID was done ("ID Month", as typed; "" when blank). */
  idMonth: string;
}

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
  /** Every requirement row (with or without a company sheet), in sheet order. */
  requirements: MasterRequirement[];
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

/** A whole number in a typed cell ("2", "10 ", "2-3" → 3), else null. Negative and absurd values are null. */
export function countOf(raw: string): number | null {
  const nums = (raw.replace(/,/g, "").match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  const n = Math.round(Math.max(...nums));
  return n >= 0 && n <= 100_000 ? n : null;
}

/** An http(s) link in a cell ("NA", "-", file names and #REF! are not links). */
export function linkOf(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  if (!/^https?:\/\/[^\s]+$/i.test(t) || t.length > 2000) return null;
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The HubSpot deal id of a record link (".../record/0-3/58635688970/", ".../deal/123"), else null. */
export function hubspotDealIdOf(link: string): string | null {
  const m = link.match(/\/record\/0-3\/(\d{3,20})(?:\/|$|\?)/) ?? link.match(/\/deal\/(\d{3,20})(?:\/|$|\?)/);
  return m ? m[1] : null;
}

export const keyText = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** A requirement's stable key (hex): its sheet, job id (else company and role), CRP month and week, and the n-th duplicate. */
export function requirementKey(r: Pick<MasterRequirement, "sheetId" | "jobId" | "company" | "role" | "crpMonth" | "crpWeek">, dup: number): string {
  const who = r.jobId ? `job:${r.jobId.toLowerCase()}` : `co:${keyText(r.company)}/${keyText(r.role)}`;
  return createHash("sha1")
    .update(`${r.sheetId ?? "-"}|${who}|${keyText(r.crpMonth)}|${r.crpWeek ?? ""}|${dup}`)
    .digest("hex")
    .slice(0, 24);
}

/**
 * The CRPs tab (header row 1, columns by name) → one entry per distinct company sheet, and every
 * requirement row. Company Name is a merged cell over a company's role rows, so a blank one belongs
 * to the row above. [jdLinks]: the JD column's hyperlinks by row index (a cell's text can be a file
 * name that links to the JD).
 */
export function parseCrpsMaster(rows: unknown[][], jdLinks: (string | null)[] = []): MasterParse {
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
  const requirements: MasterRequirement[] = [];
  const dups = new Map<string, number>();
  const end = Math.min(rows.length, MAX_ROWS_PER_TAB + 1);
  for (let i = 1; i < end; i++) {
    const r = rows[i] ?? [];
    if (!r.some((c) => cellText(c))) continue;
    const name = at(r, "company");
    if (name) company = name;
    const link = String(r[col.link!] ?? "").trim();
    const id = link ? sheetIdOf(link) : null;
    const role = at(r, "role");
    // A row is a requirement when it names a role or a CRP month (blank rows under a merged company don't).
    if (role || at(r, "crpMonth") || at(r, "jobId") || id) {
      const hubspotUrl = linkOf(at(r, "hubspot", 2000));
      const base = {
        row: i + 1,
        sheetId: id,
        // NFKC: "𝗕𝗮𝗰𝗸𝗲𝗻𝗱 𝗜𝗻𝘁𝗲𝗿𝗻" (styled letters pasted from a post) reads "Backend Intern".
        company: (company || name).normalize("NFKC").slice(0, 200) || "Company",
        role: role.normalize("NFKC").slice(0, 200),
        jobId: at(r, "jobId", 80),
        jobType: at(r, "jobType", 80),
        crpMonth: at(r, "crpMonth", 40),
        crpWeek: (() => {
          const w = countOf(at(r, "crpWeek", 20));
          return w !== null && w >= 1 && w <= 6 ? w : null;
        })(),
        openings: countOf(at(r, "openings", 40)),
        ctcText: at(r, "ctc", 80),
        finalStatus: at(r, "finalStatus", 200),
        stage: at(r, "stage", 200),
        idStatus: at(r, "idStatus", 200),
        academySent: countOf(at(r, "academySent", 40)),
        assessedSent: countOf(at(r, "assessedSent", 40)),
        nonAssessedSent: countOf(at(r, "nonAssessedSent", 40)),
        requested: at(r, "requested", 200),
        techStack: at(r, "techStack", 200),
        passOut: at(r, "passOut", 80),
        interviewProcess: at(r, "interviewProcess", 200),
        ise: at(r, "ise", 80),
        crm: at(r, "crm", 80),
        jdUrl: linkOf(at(r, "jd", 2000)) ?? linkOf(jdLinks[i]),
        hubspotUrl,
        hubspotDealId: hubspotUrl ? hubspotDealIdOf(hubspotUrl) : null,
        internalSheetId: col.internal === undefined ? null : sheetIdOf(String(r[col.internal] ?? "")),
        idMonth: at(r, "idMonth", 40),
      };
      const probe = requirementKey(base, 0);
      const dup = dups.get(probe) ?? 0;
      dups.set(probe, dup + 1);
      requirements.push({ key: dup ? requirementKey(base, dup) : probe, ...base });
    }
    read++;
    if (!link) {
      noLink++;
      continue;
    }
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
  return { sheets, requirements, rows: read, notSheetLinks, noLink };
}

/** How a requirement stands in the master: still running, paused, or over (closed / nobody selected / filled elsewhere). */
export type MasterState = "open" | "on_hold" | "closed" | "unknown";

const CLOSED_TEXT = /closed|no candidate selected|cancel|not hired|filled|withdrawn|dropped/i;

/**
 * One requirement's state from its master cells: Final Status first (when filled), then Current
 * Stage of Interview, then Company ID Status.
 */
export function requirementState(finalStatus: string, stage = "", idStatus = ""): MasterState {
  const f = finalStatus.trim();
  if (f) {
    if (CLOSED_TEXT.test(f)) return "closed";
    if (/hold/i.test(f)) return "on_hold";
    return "open";
  }
  const s = stage.trim();
  if (s) {
    if (/requirement closed|\bclosed\b/i.test(s)) return "closed";
    if (/hold/i.test(s)) return "on_hold";
    return "open";
  }
  const id = idStatus.trim();
  if (id) {
    if (/requirement closed|id done/i.test(id)) return "closed";
    if (/hold/i.test(id)) return "on_hold";
    return "open";
  }
  return "unknown";
}

/** Several requirements (one sheet): open when any is open (or not known), else on hold when any is, else closed. */
export function combinedState(states: MasterState[]): MasterState {
  if (!states.length) return "unknown";
  if (states.some((s) => s === "open")) return "open";
  if (states.some((s) => s === "unknown")) return "unknown";
  if (states.some((s) => s === "on_hold")) return "on_hold";
  return "closed";
}

/**
 * The master says the requirement is over. [masterFinalStatus] may join several requirements' Final
 * Status with " / " (one sheet, several roles): it is closed only when every part is.
 */
export const masterClosed = (masterFinalStatus: string) => {
  const parts = masterFinalStatus
    .split(" / ")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((p) => requirementState(p) === "closed");
};

// ── CRP period, CTC ─────────────────────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_LABEL = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct", "October", "Oct'26", "Oct 2026" → { month: 9, year: 2026 | null }. Null when no month. */
export function parseCrpMonth(raw: string): { month: number; year: number | null } | null {
  const t = raw.normalize("NFKC").toLowerCase();
  const m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]);
  const y4 = t.match(/\b(20\d{2})\b/);
  const y2 = t.match(/['’]\s?(\d{2})\b/);
  const year = y4 ? Number(y4[1]) : y2 ? 2000 + Number(y2[1]) : null;
  return { month, year };
}

/**
 * The year of a CRP month typed without one: the latest year in which that month starts no later
 * than two months after [now] (so in Nov 2026, "Dec" and "Jan" are upcoming, "Apr" is Apr 2026).
 */
export function inferCrpYear(month: number, now: Date): number {
  const y = now.getUTCFullYear();
  const limit = Date.UTC(y, now.getUTCMonth() + 2, 1);
  for (const year of [y + 1, y]) if (Date.UTC(year, month, 1) <= limit) return year;
  return y - 1;
}

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

/** A CRP's dates: week n = days 7n−6 … 7n (week 5 runs to the month's end); no week = the whole month. */
export function crpPeriod(year: number, month: number, week: number | null): { from: string; to: string } {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  if (!week) return { from: iso(year, month, 1), to: iso(year, month, last) };
  const start = Math.min((week - 1) * 7 + 1, last);
  const end = week >= 5 ? last : Math.min(week * 7, last);
  return { from: iso(year, month, start), to: iso(year, month, end) };
}

export const crpMonthLabel = (year: number, month: number) => `${MONTH_LABEL[month]} ${year}`;

/**
 * A CTC cell in LPA: "8-12" → 8–12, "15" → 15, "7.5–8" → 7.5–8, "50000" (a monthly stipend) → 6,
 * "₹12,00,000" → 12, "50k" → 6. Null when there is no number.
 */
export function parseCtc(raw: string): { min: number; max: number } | null {
  const t = raw.normalize("NFKC").replace(/,/g, "");
  const nums: number[] = [];
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(k\b|l\b|lpa\b|lakhs?\b)?/gi)) {
    let n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const unit = (m[2] ?? "").toLowerCase();
    if (unit === "k") n *= 1000;
    if (n >= 200_000) n /= 100_000; // a yearly amount in rupees
    else if (n >= 1000) n = (n * 12) / 100_000; // a monthly stipend
    nums.push(Math.round(n * 100) / 100);
  }
  const sane = nums.filter((n) => n > 0 && n <= 500);
  if (!sane.length) return null;
  return { min: Math.min(...sane), max: Math.max(...sane) };
}

/** "8–12 LPA", "15 LPA", or the cell as typed when it isn't plain numbers ("50000" → "50000 (≈6 LPA)"). */
export function ctcLabel(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  const c = parseCtc(t);
  if (!c) return t;
  const plain = /^[\d.\s\-–to]+(lpa)?$/i.test(t) && !/\d{4,}/.test(t);
  const range = c.min === c.max ? `${c.min}` : `${c.min}–${c.max}`;
  return plain ? `${range} LPA` : `${t} (≈${range} LPA)`;
}

// ── Company sheet tabs ──────────────────────────────────────────────────────

export interface TabInfo {
  title: string;
  gid: number;
  hidden: boolean;
  rowCount: number;
  columnCount: number;
}

/**
 * A tab of applications rather than profiles we shared: "Applied Users", "Total Applications",
 * "Academy Applied", "Form Responses 1". Its rows are candidates who applied.
 */
export const isApplicationsTab = (title: string) =>
  /\bappl(y|ied|ications?|icants?)\b|\bregistrations?\b|\bform responses?\b|\bresponses?\b/i.test(title.normalize("NFKC"));

/** The tabs worth reading: visible, and not a "Read me". Hidden tabs are raw exports or copies. */
export function pickTabs(tabs: TabInfo[]): TabInfo[] {
  return tabs.filter((t) => !t.hidden && !/^\s*read\s*-?\s*me\b/i.test(t.title) && !/\breadme\b/i.test(t.title));
}

export const PHONE_HEAD = /\b(mobile|phone|contact)\b/;
export const NOT_PHONE_HEAD = /\b(parent|guardian|father|mother|emergency|spoc|poc|recruiter|company|hr|interviewer|panel)\b/;
export const EMAIL_HEAD = /\b(e ?mail|mail id|mail)\b/;
const NAME_HEAD = /^(full name|name|candidate name|student name|candidate|name of the candidate|candidate full name)$/;
export const RESUME_HEAD = /\b(resume|cv)\b/;
export const NOT_RESUME_HEAD = /shortlist|select|screen|round|status|score|feedback|remark|review/;
const FINAL_HEADS = [/^final status$/, /^final result$/, /^final decision$/, /^final outcome$/, /^overall status$/, /^status$/];
const ROUND_HEAD =
  /\bround|\btr ?\d|\btr\b|\bhr\b|\bmr\b|\bgd\b|\br\d\b|assessment|assignment|\btest\b|interview|screening|shortlist|\bcall\b|coding|aptitude|technical|managerial|culture|offline drive|\bdrive\b|case study|\btask\b|evaluation|discussion|presentation/;
const NOT_ROUND_HEAD =
  /read ?only|\bid\b|rating|date ?time|\bdates?\b|\btag\b|\btitle\b|\bpath\b|\breport\b|\bpdf\b|\bupdates?\b|\brate\b|\balignment\b|ability|collaboration|debugging|self intro|problem solving|overall|link|recording|\burl\b|github|deployed|document|\bdoc\b|video|remark|comment|reason|feedback|\bnote|panel|\bspoc\b|\bpoc\b|\btime|timing|slot|\bmeet\b|availab|location|\bstate\b|\bcity\b|portal|skill|summary|score|marks|percentage|cgpa|college|course|department|\byear\b|graduation|degree|branch|e ?mail|\bmail\b|phone|mobile|\bname\b|\bsent\b|registered|attendance|\bmode\b|venue|\bctc\b|notice|experience|company|current|expected|recruiter|interviewer|evaluator|\bby\b|\bsheet\b|\bform\b|willing|\bare you\b|\bdo you\b|\bhave you\b|\bconfirm|challenge|\bwhy\b|\bhow\b|\bwhat\b|describe|explain/;

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
    return columnsAt(head, roundHeads(rows[r] ?? []), r, phones, emails, nameAt, resumeAt);
  }
  if (fallback === null) return null;
  const head = (rows[fallback] ?? []).map(normHead);
  const phones = head.map((h, i) => (h && PHONE_HEAD.test(h) && !NOT_PHONE_HEAD.test(h) ? i : -1)).filter((i) => i >= 0);
  return columnsAt(head, roundHeads(rows[fallback] ?? []), fallback, phones, [], -1, -1);
}

/** Headers for round detection: camelCase split first ("tr1ReportUrl" → "tr1 report url"), so platform exports' data columns aren't rounds. */
const roundHeads = (raw: unknown[]) => raw.map((h) => normHead(String(h ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2")));

function columnsAt(
  head: string[],
  roundHead: string[],
  headerRow: number,
  phones: number[],
  emails: number[],
  nameAt: number,
  resumeAt: number,
): TabColumns | null {
  let finalAt = -1;
  for (const re of FINAL_HEADS) {
    finalAt = head.findIndex((h) => re.test(h));
    if (finalAt >= 0) break;
  }
  const taken = new Set([...phones, ...emails, nameAt, resumeAt, finalAt]);
  const rounds: TabRound[] = [];
  head.forEach((h, i) => {
    if (!h || taken.has(i) || rounds.length >= MAX_ROUNDS) return;
    const rh = roundHead[i] ?? h;
    if (ROUND_HEAD.test(rh) && !NOT_ROUND_HEAD.test(rh)) rounds.push({ index: i, name: "" });
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
  /** 1.13.0: the resume link in the row (the resume the company got), when the cell is a link. */
  resumeUrl: string | null;
}

/** A resume cell's link: the cell when it is one http(s) link of at most 1,000 characters, else null. */
export function resumeLinkOf(raw: unknown): string | null {
  const link = linkOf(String(raw ?? "").trim());
  // Measured after URL normalisation (it can re-encode and grow): the column holds 1,000 characters.
  return link && link.length <= 1000 ? link : null;
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
      resumeUrl: cols.resume === null ? null : resumeLinkOf(r[cols.resume]),
    });
  }
  return out;
}

// ── Outcome, status and stage ───────────────────────────────────────────────

export const SHARE_OUTCOMES = ["selected", "rejected", "in_process", "on_hold", "no_show", "unknown"] as const;
export type ShareOutcome = (typeof SHARE_OUTCOMES)[number];

/** Most advanced first: selected beats in process, which beats rejected. */
export const OUTCOME_RANK: Record<ShareOutcome, number> = { selected: 6, in_process: 5, on_hold: 4, unknown: 3, no_show: 2, rejected: 1 };

/**
 * What the app shows for a candidate at a company (PSM 1.12.0). [outcome] (the 1.10 enum) stays for
 * older apps: awaiting → in_process, closed → rejected, shared / applied → unknown.
 *  - awaiting: a round is done (completed, attempted, attended) and its result isn't out;
 *  - closed:   the requirement is over (closed, filled, "not reached") without this candidate;
 *  - applied:  in an applications tab, nothing filled in yet (not a profile we shared);
 *  - shared:   shared, nothing filled in yet.
 */
export const SHARE_STATUSES = ["selected", "in_process", "awaiting", "on_hold", "shared", "applied", "closed", "no_show", "rejected"] as const;
export type ShareStatus = (typeof SHARE_STATUSES)[number];

/** Most advanced first (a candidate's best status across companies). */
export const STATUS_RANK: Record<ShareStatus, number> = {
  selected: 9,
  in_process: 8,
  awaiting: 7,
  on_hold: 6,
  shared: 5,
  applied: 4,
  closed: 3,
  no_show: 2,
  rejected: 1,
};

export const isShareStatus = (v: unknown): v is ShareStatus => typeof v === "string" && (SHARE_STATUSES as readonly string[]).includes(v);

/** The 1.10 outcome of a status. */
export function outcomeOfStatus(s: ShareStatus): ShareOutcome {
  switch (s) {
    case "selected":
    case "rejected":
    case "no_show":
    case "on_hold":
    case "in_process":
      return s;
    case "awaiting":
      return "in_process";
    case "closed":
      return "rejected";
    default:
      return "unknown";
  }
}

const NO_SHOW =
  /\b(absent|no ?show|did ?n ?'?o?t (join|attend|turn up|show up|appear|attempt)|didnt (join|attend|attempt)|not (joined|attended|appeared|turned up|attempted)|dnj)\b/;
const CLOSED =
  /\b(requirement|position|role|hiring|job|process|opening|openings|drive|vacancy)( is| has been| was| got)? (closed|cancell?ed|filled|stopped|paused|withdrawn)\b|\bnot reached\b|^closed$|\bposition filled\b/;
const NEGATIVE =
  /\b(not|no|non|un) ?(selected|shortlisted|cleared|qualified|interested|a fit|fit|moving forward|moved|progressing|suitable|considered|offer|proceeding|accepted|hired|placed|completed|submitted)\b|\b(did ?n ?'?o?t|didnt) (complete|submit|clear|pass|qualify)\b|\breject|\bfail(ed|s)?\b|\bdisqualif|\bdropped\b|\bdrop ?out\b|\bdeclined\b|\bunsuccessful\b/;
const HOLD = /\bhold\b|\bon ?hold\b|\bparked\b/;
const NEXT = /next round|next stage|\bmoved\b|\bmoving (to|ahead|forward)\b|\bpromoted\b/;
const STRONG_SELECTED = /\b(hired|offer(ed)?|placed|joined|onboarded|accepted)\b|yet to join|joining (date|on)/;
const SELECTED = /\bselect(ed|ion)?\b/;
const CLEARED = /\b(clear(ed)?|shortlist(ed)?|pass(ed)?|qualified|through|go ahead|proceed(ed|ing)?|positive)\b|\br\d ?(clear|pass)/;
/** A round took place, its result isn't known yet. */
const AWAITING =
  /\b(complete(d)?|done|attempted|attended|appeared|submitted|interviewed|await(ing|ed)?|waiting|pending|under review|in review|results? (awaited|pending)|evaluation)\b/;
/** Something is coming up or going on: a round to schedule, scheduled, or the process running. */
const UPCOMING =
  /\b(scheduled|reschedul\w*|yet to|to be|tbd|invited|registered|sent|shared|in ?pro(gress|cess)|ongoing|interviewing|confirmed|planned)\b/;

/** What one cell says. Decisive values decide a candidate's status; weak ones only say a round is on or done. */
export interface CellSignal {
  status: ShareStatus;
  decisive: boolean;
  /** A cleared round (the candidate moves on). */
  cleared?: boolean;
}

const normValue = (raw: string) =>
  String(raw ?? "")
    .normalize("NFKC")
    .replace(/[‘’ʼ`]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** A screening-type round ("Resume Shortlisted", "Screening Round"): "Selected" there is never the offer. */
export const SCREENING_ROUND = /resume|shortlist|screening|application|profile/i;

/**
 * One cell → a signal, or null when it says nothing about the process (a name, a date, a score).
 * [kind] "round": "Selected" means the round was cleared, unless it is the tab's last (non-screening)
 * round; "Yes" / "No" count. "final": the Final Status column, where "Selected" means selected.
 */
export function cellSignal(raw: string, kind: "final" | "round" = "final", lastRound = false): CellSignal | null {
  const s = normValue(raw);
  if (!s) return null;
  if (NO_SHOW.test(s)) return /panel|interviewer/.test(s) ? { status: "in_process", decisive: false } : { status: "no_show", decisive: true };
  if (CLOSED.test(s)) return { status: "closed", decisive: true };
  if (NEGATIVE.test(s)) return { status: "rejected", decisive: true };
  if (HOLD.test(s)) return { status: "on_hold", decisive: true };
  if (NEXT.test(s)) return { status: "in_process", decisive: true, cleared: true };
  if (STRONG_SELECTED.test(s)) return { status: "selected", decisive: true };
  if (SELECTED.test(s)) return kind === "final" || lastRound ? { status: "selected", decisive: true } : { status: "in_process", decisive: true, cleared: true };
  if (CLEARED.test(s)) return { status: "in_process", decisive: true, cleared: true };
  if (AWAITING.test(s)) return { status: "awaiting", decisive: false };
  if (UPCOMING.test(s)) return { status: "in_process", decisive: false };
  if (kind === "round") {
    if (/^(yes|y|ok|okay)$/.test(s)) return { status: "in_process", decisive: true, cleared: true };
    if (/^(no|n)$/.test(s)) return { status: "rejected", decisive: true };
  }
  return null;
}

/** One cell → the 1.10 outcome (kept for the dry-run script and older callers). */
export function outcomeOfValue(raw: string, kind: "final" | "round" = "final", lastRound = false): ShareOutcome {
  const sig = cellSignal(raw, kind, lastRound);
  return sig ? outcomeOfStatus(sig.status) : "unknown";
}

/**
 * The rounds in the order they happen: resume shortlisting / screening first (some sheets put
 * "Resume Shortlisted" after Final Status), then sheet order.
 */
export function logical<T extends { name: string }>(rounds: T[]): T[] {
  return rounds
    .map((r, i) => ({ r, k: SCREENING_ROUND.test(r.name) ? -1 : i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.r);
}

const clipLabel = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const roundLabel = (r: Round) => clipLabel(`${r.name} · ${clipLabel(r.value, 40)}`, 80);

export interface ShareVerdict {
  /** From the candidate's row only (the company's state is applied later: effectiveStatus). */
  status: ShareStatus;
  /** The cell that decided it: "TR Round 1 · Rejected", "HR Round · Yet to Schedule", "Selected", "Shared". */
  stage: string;
}

/**
 * A candidate's status in one company tab.
 *  1. Final Status, when it says something decisive (Selected, Hired, Rejected, Hold, Not reached…).
 *  2. Otherwise the latest decisive round (from the last round back). A weak value after it ("Done",
 *     "Completed & Waiting for Results", "Yet to Schedule") never reopens a rejection or a no show;
 *     after a cleared round it tells what is happening now (awaiting a result / the next round).
 *  3. Only weak values: the latest one. Nothing at all: shared.
 * [lastRoundName]: the tab's last round column, where "Selected" means selected (never a screening round).
 */
export function shareVerdict(rounds: Round[], finalStatus: string, lastRoundName?: string): ShareVerdict {
  const fin = finalStatus ? cellSignal(finalStatus, "final") : null;
  if (fin?.decisive) return { status: fin.status, stage: clipLabel(finalStatus, 60) };
  const ordered = logical(rounds);
  let weak: { r: Round; sig: CellSignal } | null = null;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const r = ordered[i];
    const last = lastRoundName !== undefined && r.name === lastRoundName && !SCREENING_ROUND.test(r.name);
    const sig = cellSignal(r.value, "round", last);
    if (!sig) continue;
    if (!sig.decisive) {
      weak ??= { r, sig };
      continue;
    }
    if (sig.cleared && weak) return { status: weak.sig.status, stage: roundLabel(weak.r) };
    return { status: sig.status, stage: roundLabel(r) };
  }
  if (weak) return { status: weak.sig.status, stage: roundLabel(weak.r) };
  if (fin) return { status: fin.status, stage: clipLabel(finalStatus, 60) };
  if (finalStatus) return { status: "shared", stage: clipLabel(finalStatus, 60) };
  const latest = ordered[ordered.length - 1];
  return { status: "shared", stage: latest ? roundLabel(latest) : "Shared" };
}

/** The 1.10 outcome of a share (Final Status first, then the latest decisive round). */
export function shareOutcome(rounds: Round[], finalStatus: string, lastRoundName?: string): ShareOutcome {
  return outcomeOfStatus(shareVerdict(rounds, finalStatus, lastRoundName).status);
}

/** A short label: "Selected", "TR Round 1 · Rejected", "Assignment Round · Pending", "Shared". */
export function shareStage(rounds: Round[], finalStatus: string, lastRoundName?: string): string {
  return shareVerdict(rounds, finalStatus, lastRoundName).stage;
}

/**
 * The status the app shows: the candidate's own status, then the requirement's state. A candidate
 * still open (in process, awaiting, shared, applied, on hold) at a closed requirement is closed; at
 * a requirement on hold, on hold. An applications-tab row with nothing filled in is "applied".
 */
export function effectiveStatus(own: ShareStatus, kind: "shared" | "applied", company: MasterState): ShareStatus {
  const s: ShareStatus = kind === "applied" && own === "shared" ? "applied" : own;
  const open = s === "in_process" || s === "awaiting" || s === "shared" || s === "applied" || s === "on_hold";
  if (open && company === "closed") return "closed";
  if (open && s !== "on_hold" && company === "on_hold") return "on_hold";
  return s;
}

/** Still going with that company: in process, awaiting a result, on hold, or shared with no result yet. */
export const isActiveStatus = (s: ShareStatus) => s === "in_process" || s === "awaiting" || s === "on_hold" || s === "shared";

/** A finished status: selected, rejected, no show or closed. */
export const isFinalStatus = (s: ShareStatus) => s === "selected" || s === "rejected" || s === "no_show" || s === "closed";

/** The most advanced of several outcomes (null: none). */
export function bestOutcome(outcomes: ShareOutcome[]): ShareOutcome | null {
  let best: ShareOutcome | null = null;
  for (const o of outcomes) if (!best || OUTCOME_RANK[o] > OUTCOME_RANK[best]) best = o;
  return best;
}

/** The most advanced of several statuses (null: none). */
export function bestStatus(statuses: ShareStatus[]): ShareStatus | null {
  let best: ShareStatus | null = null;
  for (const s of statuses) if (!best || STATUS_RANK[s] > STATUS_RANK[best]) best = s;
  return best;
}

/** Still going (1.10 callers): not finished, and the company hasn't closed the requirement. */
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
  /** The candidate's own status in this tab (before the requirement's state). */
  status: ShareStatus;
  hash: string;
  resumeAt: number | null;
  /** 1.13.0: the resume link in the row (null when the cell isn't a link). */
  resumeUrl: string | null;
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
      const verdict = shareVerdict(row.rounds, row.finalStatus, lastRound);
      byUid.set(m.uid, {
        tab,
        gid: Number.isInteger(p.info.gid) ? p.info.gid : null,
        uid: m.uid,
        phone: m.phone,
        company: sheet.company,
        role,
        rounds: row.rounds,
        finalStatus: row.finalStatus,
        stage: verdict.stage,
        outcome: outcomeOfStatus(verdict.status),
        status: verdict.status,
        hash: shareHash(row.rounds, row.finalStatus),
        resumeAt: row.resumeAt,
        resumeUrl: row.resumeUrl,
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
  /** 1.12.0: the chip to show (the candidate's status, then the requirement's state). */
  status: ShareStatus;
  /** 1.12.0: "applied" when the row is in an applications tab. */
  kind: "shared" | "applied";
  /** 1.12.0: the master's Final Status for this requirement ("" when unknown). */
  companyStatus: string;
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
  /** Migration 022: the candidate's own status as computed at the last read (null before it). */
  status?: string | null;
  first_seen_at: Date;
  changed_at: Date;
}

/** The requirement a share belongs to, for its company state. */
export interface ShareCompany {
  state: MasterState;
  statusText: string;
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

/**
 * The candidate's own status of a stored row: the one stored at the last read (current rules), else
 * worked out again from its rounds (rows read before migration 022; "Selected" in the tab's last
 * round was stored as selected, so a stored selected stays selected).
 */
export function ownStatusOf(r: Pick<ShareRowLike, "rounds" | "final_status" | "outcome" | "status">): { status: ShareStatus; stage: string | null } {
  if (isShareStatus(r.status)) return { status: r.status, stage: null };
  const rounds = roundsOf(r.rounds);
  const lastName = r.outcome === "selected" ? logical(rounds).at(-1)?.name : undefined;
  const v = shareVerdict(rounds, r.final_status, lastName);
  return { status: v.status, stage: v.stage };
}

export function shareDto(r: ShareRowLike, company?: ShareCompany): ShareDto {
  const own = ownStatusOf(r);
  const kind = isApplicationsTab(r.tab) ? "applied" : "shared";
  const status = effectiveStatus(own.status, kind, company?.state ?? "unknown");
  return {
    id: String(r.id),
    company: r.company,
    role: r.role,
    tab: r.tab,
    sheetUrl: sheetUrl(r.sheet_id, r.tab_gid),
    sharedOn: dayOf(r.first_seen_at),
    rounds: roundsOf(r.rounds),
    finalStatus: r.final_status,
    stage: own.stage ?? r.stage,
    outcome: own.stage !== null ? outcomeOfStatus(own.status) : isOutcome(r.outcome) ? r.outcome : "unknown",
    status,
    kind,
    companyStatus: company?.statusText ?? "",
    updatedAt: r.changed_at.toISOString(),
  };
}

/**
 * The requirement of a sheet that a share's tab belongs to, when the sheet serves several: the one
 * whose role words the tab title (or the share's role) holds best (at least half of them), and that
 * is the only best match. Null when it can't be told; the caller then uses the whole sheet.
 */
export function pickRequirement<T extends { role: string; crpMonth: string }>(share: { tab: string; role: string }, reqs: T[]): T | null {
  if (reqs.length === 1) return reqs[0];
  if (!reqs.length) return null;
  const words = (s: string) => new Set(keyText(s).split(" ").filter((w) => w.length > 1 && !["jd", "batch", "intern", "the", "and", "of"].includes(w)));
  const hay = words(`${share.tab} ${share.role}`);
  const tabMonth = parseCrpMonth(share.tab)?.month ?? null;
  let best: { r: T; score: number } | null = null;
  let tie = false;
  for (const r of reqs) {
    const want = [...words(r.role)];
    if (!want.length) continue;
    let score = want.filter((w) => hay.has(w)).length / want.length;
    if (score < 0.5) continue;
    if (tabMonth !== null && parseCrpMonth(r.crpMonth)?.month === tabMonth) score += 0.25;
    if (!best || score > best.score) {
      best = { r, score };
      tie = false;
    } else if (score === best.score) tie = true;
  }
  return best && !tie ? best.r : null;
}

/** Newest activity first. */
export const byActivity = (a: Pick<ShareRowLike, "changed_at" | "first_seen_at">, b: Pick<ShareRowLike, "changed_at" | "first_seen_at">) =>
  Math.max(b.changed_at.getTime(), b.first_seen_at.getTime()) - Math.max(a.changed_at.getTime(), a.first_seen_at.getTime());
