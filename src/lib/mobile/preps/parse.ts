import { createHash } from "node:crypto";

/**
 * The "Edge Team drill down" tab as interview preps, for the app's Calendar (docs/mobile-api.yaml,
 * /preps). Pure and client-safe: no network, no database — tested in scripts/prep-selftest.ts.
 *
 * Only columns A..Z are read. Columns are found by their header text (row 1), so the team can
 * reorder them. The tab is typed by hand, so every cell is read defensively:
 *   - dates are Sheets serial numbers OR text such as "Jan 16th , 2026", "Feb2 , 2026",
 *     "March 3 , 2026", "06-10-2026" (day first), with typo years ("Jun 25, 0206");
 *   - interview timings are serial fractions OR text such as "15:00", "9:30 am", "16:00- 17:00",
 *     "12:30- 1:00", "3:00 - 3:20" (a 12-hour time without AM/PM; 1–7 o'clock is afternoon).
 * Every time is wall-clock time in India (IST, UTC+5:30), the spreadsheet's zone.
 */

export const IST_OFFSET_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;

// ── Columns ──────────────────────────────────────────────────────────────────

export interface PrepColumns {
  product: number;
  entryDate: number;
  interviewDate: number;
  interviewTime: number;
  jobId: number;
  company: number;
  candidate: number;
  mobile: number;
  resume: number;
  round: number;
  process: number;
  candidateStatus: number;
  prepGiven: number;
  prepBy: number;
  prepDate: number;
  prepTime: number;
  prepDocument: number;
  remarks: number;
  hubspot: number;
  mode: number;
  meetingLink: number;
  recording: number;
  transcript: number;
  drilldown: number;
  completion: number;
}

/** Columns past Z are never read (the team keeps scratch columns there). */
export const LAST_COLUMN = 26;

const squeeze = (v: unknown) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Header row 1 → 1-based column numbers (0 = the tab has no such column). */
export function findPrepColumns(header: unknown[]): PrepColumns {
  const head = header.slice(0, LAST_COLUMN).map(squeeze);
  const find = (re: RegExp) => head.findIndex((h) => re.test(h)) + 1;
  const cols: PrepColumns = {
    product: find(/^product$/),
    entryDate: find(/^date of entry/),
    interviewDate: find(/^interview date/),
    interviewTime: find(/^interview tim/),
    jobId: find(/^job ?id$/),
    company: find(/^company name$/),
    candidate: find(/^candidate name$/),
    mobile: find(/^candidate mobile|^mobile/),
    resume: find(/^candidate resume|^resume/),
    round: find(/^round category$|^round$/),
    process: find(/^interview process$/),
    candidateStatus: find(/^candidate'?s? status$/),
    prepGiven: find(/^prep given$/),
    prepBy: find(/^prep given by$/),
    prepDate: find(/^prep date$/),
    prepTime: find(/^prep time$/),
    prepDocument: find(/^prep document/),
    remarks: find(/^remarks$/),
    hubspot: find(/^hubspot/),
    mode: find(/interview mode$/),
    meetingLink: find(/^meeting link/),
    recording: find(/recording/),
    transcript: find(/^transcript/),
    drilldown: find(/^drill ?down link/),
    completion: find(/^completion date/),
  };
  const missing = (["company", "candidate", "mobile", "interviewDate", "prepBy"] as const).filter((k) => !cols[k]);
  if (missing.length) throw new Error(`The drill-down tab is missing these columns: ${missing.join(", ")}.`);
  return cols;
}

// ── Dates and times ──────────────────────────────────────────────────────────

/** A calendar day in IST, "YYYY-MM-DD". */
export type Day = string;

export const dayOf = (instant: Date | number): Day => new Date(Number(instant) + IST_OFFSET_MS).toISOString().slice(0, 10);
export const addDays = (day: Day, n: number): Day => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** The instant at [minutes] past midnight IST on [day]. */
export const atIst = (day: Day, minutes: number): Date => new Date(Date.parse(`${day}T00:00:00Z`) + minutes * 60_000 - IST_OFFSET_MS);
export const isDay = (v: unknown): v is Day => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`));

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function validDay(y: number, m: number, d: number): Day | null {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return back.toISOString().slice(0, 10);
}

/**
 * A date cell → IST day. [refYear] fixes typo years: a year that is missing or more than one year
 * away from it (0206, 2028 from a drag-fill) is replaced by it.
 */
export function parseDay(value: unknown, refYear?: number, nearDay?: Day | null): Day | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 20_000 || value > 80_000) return null;
    return new Date(Math.floor(value) * DAY_MS - 25_569 * DAY_MS).toISOString().slice(0, 10);
  }
  const s = String(value ?? "").trim().toLowerCase();
  if (!s) return null;
  const fixYear = (y: number | null) => {
    const ref = refYear ?? null;
    if (y === null || !Number.isFinite(y)) return ref;
    if (y < 100) y += 2000;
    if (ref !== null && Math.abs(y - ref) > 1) return ref;
    return y;
  };
  // No year typed ("Jan 5"): the year that puts the date nearest [nearDay] (an interview typed in
  // December for early January is next year's).
  const yearless = (month: number, day: number): Day | null => {
    if (!nearDay) {
      const year = fixYear(null);
      return year === null ? null : validDay(year, month, day);
    }
    const y = Number(nearDay.slice(0, 4));
    const near = Date.parse(`${nearDay}T00:00:00Z`);
    const options = [y - 1, y, y + 1].map((yy) => validDay(yy, month, day)).filter((d): d is Day => d !== null);
    options.sort((a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - near) - Math.abs(Date.parse(`${b}T00:00:00Z`) - near));
    return options[0] ?? null;
  };
  // "Jan 16th , 2026", "Feb2 , 2026", "March 3 , 2026", "OCt 5", "Sep 24 2026"
  let m = s.match(/^([a-z]{3,9})\.?\s*(\d{1,2})(?:st|nd|rd|th)?\b\s*(?:,|\s)?\s*(\d{2,4})?/);
  if (m) {
    const month = MONTHS.indexOf(m[1].slice(0, 3)) + 1;
    if (month > 0 && !m[3]) return yearless(month, Number(m[2]));
    const year = fixYear(Number(m[3]));
    if (month > 0 && year !== null) return validDay(year, month, Number(m[2]));
  }
  // "16 Jan 2026"
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s*(\d{2,4})?/);
  if (m) {
    const month = MONTHS.indexOf(m[2].slice(0, 3)) + 1;
    if (month > 0 && !m[3]) return yearless(month, Number(m[1]));
    const year = fixYear(Number(m[3]));
    if (month > 0 && year !== null) return validDay(year, month, Number(m[1]));
  }
  // "06-10-2026" / "06/10/26" — day first (the team's prep-date format) …
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const year = fixYear(Number(m[3]));
    if (year === null) return null;
    // … unless that can't be a date and month-first can ("10/15/2026").
    return validDay(year, Number(m[2]), Number(m[1])) ?? validDay(year, Number(m[1]), Number(m[2]));
  }
  // "2026-11-07"
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return validDay(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

export interface TimeRange {
  /** Minutes after midnight, IST. */
  start: number;
  end: number | null;
}

/** One clock time; [meridiem] when the cell says AM/PM. */
function clock(h: number, min: number, meridiem: string | undefined): number | null {
  if (!(h >= 0 && h <= 24 && min >= 0 && min < 60)) return null;
  if (meridiem === "pm" && h < 12) h += 12;
  if (meridiem === "am" && h === 12) h = 0;
  return h * 60 + min;
}

/**
 * Interview / prep timings → minutes after midnight. A 12-hour time typed without AM/PM is read
 * as an office-hours time: 1–7 o'clock is afternoon ("3:00 - 3:20" = 3 PM), 8–11 morning.
 * An end before its start moves to the afternoon ("12:30- 1:00" ends at 1 PM).
 */
export function parseTimeRange(value: unknown): TimeRange | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const frac = value - Math.floor(value);
    if (value >= 1 && frac === 0) return null; // a date, no time
    return { start: Math.round(frac * 1440) % 1440, end: null };
  }
  const s = String(value ?? "").toLowerCase().replace(/\s*:\s*/g, ":").replace(/\./g, ":").trim();
  if (!s || /finali[sz]|tbd|to be/.test(s)) return null;
  const re = /(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm|a:m:|p:m:)?/g;
  const parts: { h: number; m: number; mer?: string; hasMinutes: boolean }[] = [];
  for (const m of s.matchAll(re)) {
    const mer = m[3]?.replace(/:/g, "") as "am" | "pm" | undefined;
    parts.push({ h: Number(m[1]), m: Number(m[2] ?? 0), mer, hasMinutes: m[2] !== undefined });
    if (parts.length === 2) break;
  }
  if (!parts.length) return null;
  // A bare number with no minutes and no AM/PM ("4") is too vague unless it's a range ("4-5").
  if (parts.length === 1 && !parts[0].hasMinutes && !parts[0].mer) return null;
  // "8:00PM-9:00PM": a meridiem on the end applies to the start when the start has none.
  const shared = parts[1]?.mer;
  const read = (p: (typeof parts)[number], fallbackMer?: string) => {
    if (p.mer || p.h > 12 || p.h === 0) return clock(p.h, p.m, p.mer);
    if (fallbackMer) return clock(p.h, p.m, fallbackMer);
    if (p.h >= 1 && p.h <= 7) return clock(p.h + 12, p.m, undefined);
    return clock(p.h, p.m, undefined);
  };
  const start = read(parts[0], shared);
  if (start === null) return null;
  let end = parts[1] ? read(parts[1]) : null;
  if (end !== null && end <= start && end + 720 > start && end + 720 < 1440) end += 720;
  if (end !== null && (end <= start || end - start > 6 * 60)) end = null;
  return { start: start % 1440, end };
}

// ── Values ───────────────────────────────────────────────────────────────────

export type Category = "academy" | "edge" | "external";
export type EdgeVersion = "1.0" | "2.0";

export type PrepStatus = "pending" | "done" | "missed" | "not_needed" | "not_informed" | "no_response" | "rescheduled" | "cancelled" | "other";

/** "Prep Given" (column M) → status. Empty = still to do. */
export function prepStatusOf(raw: string): PrepStatus {
  const s = squeeze(raw);
  if (!s) return "pending";
  if (/^(yes|done|given|completed?)\b/.test(s)) return "done";
  if (/^missed/.test(s)) return "missed";
  if (/^not needed|^no need|^na$|^n\/a$/.test(s)) return "not_needed";
  if (/not informed/.test(s)) return "not_informed";
  if (/^dnp|busy|not (picking|responding|reachable)|no response/.test(s)) return "no_response";
  if (/resched/.test(s)) return "rescheduled";
  if (/cancel|cancled/.test(s)) return "cancelled";
  return "other";
}

/** The values the app writes to "Prep Given", in the team's spelling. */
export const PREP_STATUS_LABEL: Record<Exclude<PrepStatus, "pending" | "other">, string> = {
  done: "Yes",
  missed: "Missed",
  not_needed: "Not needed",
  not_informed: "Not informed to PSM priorly",
  no_response: "DNP",
  rescheduled: "Rescheduled",
  cancelled: "Cancelled",
};

export type InterviewState =
  | "scheduled"
  | "completed"
  | "rescheduled"
  | "cancelled"
  | "no_show"
  | "next_round"
  | "selected"
  | "rejected"
  | "hold"
  | "other";

/** "Candidate's Status" (column L) → interview state. */
export function interviewStateOf(raw: string): InterviewState {
  const s = squeeze(raw);
  if (!s || /^to be interviewed|^scheduled|^yet to/.test(s)) return "scheduled";
  if (/next round|selected for (the )?(tr|next|hr|mr)|for the tr/.test(s)) return "next_round";
  if (/^(selected|hired|placed|offer)/.test(s)) return "selected";
  if (/reject/.test(s)) return "rejected";
  if (/hold/.test(s)) return "hold";
  if (/resched/.test(s)) return "rescheduled";
  if (/cancel/.test(s)) return "cancelled";
  if (/didn'?t join|did not join|no show|not join|absent/.test(s)) return "no_show";
  if (/complet|attended|waiting|done/.test(s)) return "completed";
  return "other";
}

/** The usual "Candidate's Status" values, in the order the app offers them (the sheet's dropdown wins). */
export const INTERVIEW_STATUS_OPTIONS = [
  "To be interviewed",
  "completed and waiting for results",
  "Attended waiting for results",
  "Selected for Next round",
  "Selected",
  "Rejected",
  "Hold",
  "Rescheduled",
  "Interview cancelled",
  "Panel Didn't Join",
] as const;

const norm = (v: string) => v.trim().toLowerCase();

/**
 * What the app offers for "Candidate's Status": the sheet's dropdown values (exact spellings), the
 * usual ones first; without a dropdown, the usual list.
 */
export function interviewOptions(dropdown: string[] | null): string[] {
  if (!dropdown?.length) return [...INTERVIEW_STATUS_OPTIONS];
  const preferred = INTERVIEW_STATUS_OPTIONS.map((p) => dropdown.find((o) => norm(o) === norm(p))).filter((o): o is string => Boolean(o));
  return [...preferred, ...dropdown.filter((o) => !preferred.includes(o))];
}

/**
 * The "Prep Given" value to write for a status: the dropdown's own spelling ("Cancled" stays
 * "Cancled"), else the team's usual word. Null when the dropdown has nothing for it.
 */
export function prepGivenValue(status: Exclude<PrepStatus, "pending" | "other">, dropdown: string[] | null): string | null {
  const wanted = PREP_STATUS_LABEL[status];
  if (!dropdown?.length) return wanted;
  return dropdown.find((o) => norm(o) === norm(wanted)) ?? dropdown.find((o) => prepStatusOf(o) === status) ?? null;
}

/** A 10-digit Indian mobile number from a cell ("+91 93474 39963", "9347439963"), or "". */
export function phone10(raw: unknown): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < 10) return "";
  const last = digits.slice(-10);
  return /^[6-9]/.test(last) ? last : "";
}

export const isUrl = (v: string) => /^https?:\/\/\S+$/i.test(v.trim());

/** "TR 3 " → "TR3", "Screening/Telphonic Round" stays readable. */
export function normRound(raw: string): string {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  const tr = s.match(/^tr\s*-?\s*(\d)$/i);
  return tr ? `TR${tr[1]}` : s;
}

/** "HEMANTH, RAKESH" → ["HEMANTH", "RAKESH"]. */
export function splitNames(raw: string): string[] {
  return String(raw ?? "")
    .split(/\s*(?:,|\/|&|\+|\band\b|\n)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "TR1, TR2, HR" → steps, in order. */
export function processSteps(raw: string): string[] {
  return String(raw ?? "")
    .split(/\s*(?:,|→|->|\n)\s*/)
    .map((s) => normRound(s))
    .filter(Boolean);
}

/** A Google Doc / Drive file id from a link, for de-duplicating links that differ only in suffix. */
export function docKey(url: string): string {
  const m = url.match(/\/d\/([\w-]{20,})/) ?? url.match(/[?&]id=([\w-]{20,})/);
  return m ? m[1] : url.trim().replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface PrepRow {
  /** Stable id: candidate phone + job + round (+ #n for exact duplicates). Survives row moves. */
  key: string;
  /** 1-based sheet row at read time. */
  row: number;
  product: string;
  entryDay: Day | null;
  interviewDay: Day | null;
  /** The interview date cell says "to be finalised". */
  interviewTbd: boolean;
  interviewTime: TimeRange | null;
  /** The timings cell as typed (shown when it couldn't be read). */
  interviewTimeText: string;
  jobId: string;
  company: string;
  candidate: string;
  phone: string;
  phoneRaw: string;
  resumeUrl: string;
  round: string;
  process: string[];
  candidateStatus: string;
  interviewState: InterviewState;
  prepGivenRaw: string;
  prepStatus: PrepStatus;
  prepBy: string[];
  prepByRaw: string;
  prepDay: Day | null;
  prepTime: TimeRange | null;
  prepDocument: string;
  remarks: string;
  hubspotUrl: string;
  mode: string;
  meetingUrl: string;
  recordingUrl: string;
  recordingNote: string;
  transcriptUrl: string;
  drilldownUrl: string;
  completion: string;
}

const text = (r: unknown[], col: number) => (col ? String(r[col - 1] ?? "").trim() : "");
const raw = (r: unknown[], col: number) => (col ? r[col - 1] : undefined);

/** What identifies a row: candidate (phone, else name), job (id, else company), round and entry day. */
export function identityOf(p: Pick<PrepRow, "phone" | "candidate" | "jobId" | "company" | "round" | "entryDay">): string {
  return [
    p.phone || p.candidate.toLowerCase().replace(/\s+/g, " ").trim(),
    p.jobId || p.company.toLowerCase().trim(),
    p.round.toLowerCase(),
    p.entryDay ?? "",
  ].join("|");
}

export function prepKey(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

/**
 * Raw rows (UNFORMATTED_VALUE, dates as serial numbers; row 0 = header) → preps. Rows without a
 * candidate and company are skipped. [refYear] fixes typo years in text dates.
 */
export function rowsToPreps(rows: unknown[][], cols: PrepColumns, refYear: number, today?: Day): PrepRow[] {
  const refDay: Day | null = today ?? null;
  const out: PrepRow[] = [];
  const seen = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    const r = (rows[i] ?? []).slice(0, LAST_COLUMN);
    const company = text(r, cols.company);
    const candidate = text(r, cols.candidate);
    if (!company || !candidate) continue;
    const phoneRaw = text(r, cols.mobile);
    const phone = phone10(phoneRaw);
    const jobId = text(r, cols.jobId).toLowerCase();
    const round = normRound(text(r, cols.round));
    let entryDay = parseDay(raw(r, cols.entryDate), refYear, refDay);
    // A row can't have been entered in a later year than now (drag-filled "2027"s).
    if (entryDay && Number(entryDay.slice(0, 4)) > refYear) entryDay = `${refYear}${entryDay.slice(4)}`;
    const yearHint = entryDay ? Number(entryDay.slice(0, 4)) : refYear;
    const interviewRaw = raw(r, cols.interviewDate);
    let interviewDay = parseDay(interviewRaw, yearHint, entryDay ?? refDay);
    // A typed interview date months after the entry is a year typo: use the entry's year.
    if (interviewDay && entryDay && typeof interviewRaw === "string" && interviewDay > addDays(entryDay, 120)) {
      interviewDay = parseDay(interviewRaw.replace(/\b\d{4}\b/, String(yearHint)), yearHint) ?? interviewDay;
    }
    const timeRaw = raw(r, cols.interviewTime);
    // The key includes the entry day, so a rescheduled copy of a row (same candidate, job, round)
    // keeps its own key however the team sorts the sheet. Only truly identical rows get "#n".
    const base = identityOf({ phone, candidate, jobId, company, round, entryDay });
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const recording = text(r, cols.recording);
    const prepByRaw = text(r, cols.prepBy);
    const prepGivenRaw = text(r, cols.prepGiven);
    const meeting = text(r, cols.meetingLink);
    out.push({
      key: prepKey(n === 1 ? [base] : [base, `#${n}`]),
      row: i + 1,
      product: text(r, cols.product),
      entryDay,
      interviewDay,
      interviewTbd: !interviewDay && /finali[sz]|tbd|to be/i.test(String(interviewRaw ?? "")),
      interviewTime: parseTimeRange(timeRaw),
      interviewTimeText: typeof timeRaw === "number" ? "" : String(timeRaw ?? "").trim(),
      jobId,
      company,
      candidate,
      phone,
      phoneRaw,
      resumeUrl: isUrl(text(r, cols.resume)) ? text(r, cols.resume) : "",
      round,
      process: processSteps(text(r, cols.process)),
      candidateStatus: text(r, cols.candidateStatus),
      interviewState: interviewStateOf(text(r, cols.candidateStatus)),
      prepGivenRaw,
      prepStatus: prepStatusOf(prepGivenRaw),
      prepBy: splitNames(prepByRaw),
      prepByRaw,
      prepDay: parseDay(raw(r, cols.prepDate), yearHint, entryDay ?? refDay),
      prepTime: parseTimeRange(raw(r, cols.prepTime)),
      prepDocument: text(r, cols.prepDocument),
      remarks: text(r, cols.remarks),
      hubspotUrl: isUrl(text(r, cols.hubspot)) ? text(r, cols.hubspot) : "",
      mode: text(r, cols.mode),
      meetingUrl: isUrl(meeting) ? meeting : "",
      recordingUrl: isUrl(recording) ? recording : "",
      recordingNote: isUrl(recording) ? "" : recording,
      transcriptUrl: isUrl(text(r, cols.transcript)) ? text(r, cols.transcript) : "",
      drilldownUrl: isUrl(text(r, cols.drilldown)) ? text(r, cols.drilldown) : "",
      completion: text(r, cols.completion),
    });
  }
  return out;
}

// ── Interview time and the prep SLA ─────────────────────────────────────────

/** Interviews typed without a time are placed at 10:00 IST for SLA maths (never shown as a time). */
export const DEFAULT_INTERVIEW_MINUTES = 10 * 60;
/** Interviews without an end time last an hour in the calendar. */
export const DEFAULT_INTERVIEW_LENGTH_MIN = 60;
/** PSM's SLA for an interview on the next day (or sooner): prep within 45 minutes of the row's entry. */
export const MANDATORY_SLA_MIN = 45;
/** ISE / PC's SLA: tell PSM at least 24 hours before the interview. Also PSM's target for later interviews. */
export const INFORM_BEFORE_MS = 24 * 3_600_000;

export function interviewStart(p: Pick<PrepRow, "interviewDay" | "interviewTime">): Date | null {
  if (!p.interviewDay) return null;
  return atIst(p.interviewDay, p.interviewTime?.start ?? DEFAULT_INTERVIEW_MINUTES);
}

export type SlaKind = "mandatory" | "before_interview" | "none";

export interface Sla {
  kind: SlaKind;
  /** When the prep must be done by; null = no deadline we can measure. */
  dueAt: Date | null;
  /** ISE / PC put the row in less than 24 hours before the interview. */
  informedLate: boolean;
}

/**
 * When a prep is due, from when the row first appeared in the sheet ([firstSeenAt]):
 *   - interview today or tomorrow (as of entry) → mandatory, within 45 minutes of entry;
 *   - interview later → 24 hours before the interview (it can be given any time before that);
 *   - no interview date, or the row was already there when tracking began ([baseline]) → none.
 */
export function slaFor(p: Pick<PrepRow, "interviewDay" | "interviewTime">, firstSeenAt: Date | null, baseline: boolean): Sla {
  const start = interviewStart(p);
  if (!start || !p.interviewDay || !firstSeenAt) return { kind: "none", dueAt: null, informedLate: false };
  const informedLate = firstSeenAt.getTime() > start.getTime() - INFORM_BEFORE_MS;
  if (baseline) return { kind: "none", dueAt: null, informedLate: false };
  const seenDay = dayOf(firstSeenAt);
  if (p.interviewDay <= addDays(seenDay, 1)) {
    return { kind: "mandatory", dueAt: new Date(firstSeenAt.getTime() + MANDATORY_SLA_MIN * 60_000), informedLate };
  }
  return { kind: "before_interview", dueAt: new Date(start.getTime() - INFORM_BEFORE_MS), informedLate };
}

/** A prep still to be given: no "Prep Given" value and the interview hasn't passed. */
export function isOpen(p: Pick<PrepRow, "prepStatus" | "interviewDay">, today: Day): boolean {
  return p.prepStatus === "pending" && (p.interviewDay === null || p.interviewDay >= today);
}

// ── Category from the sheet (the pool lookup overrides it; see enrich.ts) ─────

export function categoryFromSheet(product: string): { category: Category; edgeVersion: EdgeVersion | null; note: string } {
  const s = squeeze(product);
  if (/academy/.test(s)) return { category: "academy", edgeVersion: null, note: "" };
  if (/edge\s*2/.test(s)) return { category: "edge", edgeVersion: "2.0", note: "" };
  if (/edge\s*1/.test(s)) return { category: "edge", edgeVersion: "1.0", note: "" };
  if (/edge/.test(s)) return { category: "edge", edgeVersion: null, note: "" };
  if (/niat/.test(s)) return { category: "external", edgeVersion: null, note: "NIAT" };
  return { category: "external", edgeVersion: null, note: "" };
}

/** Academy first, then Edge, then External (the order the team gives preps in). */
export const CATEGORY_ORDER: Record<Category, number> = { academy: 0, edge: 1, external: 2 };
