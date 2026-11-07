import "server-only";
import { createHash } from "node:crypto";
import { env } from "@/lib/env";
import { getSheetsWriter } from "@/lib/sheets";
import { withSheetsRetry } from "@/lib/automation/control-sheet";

/**
 * The coordination sheet's control tab as tasks for the app: every row with a company. The sheet
 * is the source of truth; the app's database only adds who acknowledged what and which pushes
 * went out (app.assignments). Columns are found by header text, so the team can move them.
 */

export interface ControlColumns {
  headerRow: number;
  date: number;
  jobId: number;
  product: number;
  company: number;
  pc: number;
  crm: number;
  techStack: number;
  hubspot: number;
  remarks: number;
  internalSheet: number;
  jd: number;
  assignedAt: number;
  deadline: number;
  openings: number;
  profilesRequired: number;
  mechanism: number;
  mentor: number;
  subsheets: number;
  instructions: number;
  github: number;
  dsa: number;
  experience: number;
  trigger: number;
  status: number;
  details: number;
}

export interface ControlTask {
  taskId: string;
  /** 1-based sheet row (rows can move; taskId is what stays stable). */
  row: number;
  company: string;
  product: string;
  pc: string;
  crm: string;
  techStack: string;
  hubspotUrl: string;
  remarks: string;
  internalSheetUrl: string;
  jdUrl: string;
  openings: string;
  profilesRequired: number;
  mechanism: string;
  mentor: string;
  assignedAt: Date | null;
  deadline: Date | null;
  deadlineInferred: boolean;
  trigger: string;
  automationStatus: string;
  automationDetails: string;
}

export interface ControlSnapshot {
  spreadsheetId: string;
  tab: string;
  columns: ControlColumns;
  tasks: ControlTask[];
  readAt: Date;
}

const CACHE_MS = 20_000;
const g = globalThis as unknown as { __mobileControl?: { at: number; snap: ControlSnapshot } };
const squeeze = (v: unknown) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const q = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

export function controlTarget(): { spreadsheetId: string; tab: string } {
  return { spreadsheetId: env.mobile.controlSpreadsheetId, tab: env.mobile.controlTab };
}

/** Header row (the one with "Mentor" or "Screening Instructions" in the first 6 rows) → columns (1-based, 0 = missing). */
export function findColumns(rows: unknown[][]): ControlColumns {
  const idx = rows.slice(0, 6).findIndex((r) => r.some((c) => ["mentor", "screening instructions"].includes(squeeze(c))));
  if (idx < 0) throw new Error('The control tab has no "Mentor" / "Screening Instructions" header in its first 6 rows.');
  const head = rows[idx].map(squeeze);
  const find = (re: RegExp) => head.findIndex((h) => re.test(h)) + 1;
  return {
    headerRow: idx + 1,
    date: find(/^date$/),
    jobId: find(/^job ?id$/),
    product: find(/^product$/),
    company: find(/^company name/),
    pc: find(/^pc$/),
    crm: find(/^crm$/),
    techStack: find(/^tech stack/),
    hubspot: find(/^hubspot/),
    remarks: find(/^company remarks|shortlisting remarks/),
    internalSheet: find(/^internal sheets?\b/),
    jd: find(/^jd$/),
    assignedAt: find(/^assigned date/),
    deadline: find(/^expected deadline/),
    openings: find(/^no\.? of openings/),
    profilesRequired: find(/profiles required/),
    mechanism: find(/^proposed shortlisting mechanism/),
    mentor: find(/^mentor$|^psm assignee$/),
    subsheets: find(/^sub ?-?sheets?/),
    instructions: find(/^screening instructions$/),
    github: find(/^git ?hub/),
    dsa: find(/^dsa/),
    experience: find(/experience.*(?:domain|screening)/),
    trigger: find(/^trigger$/),
    status: find(/^automation status$/),
    details: find(/^automation details$/),
  };
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * A date cell as an instant. Sheets serial numbers (days since 1899-12-30, wall time in the
 * spreadsheet's zone, IST here) and text like "10/15/2026 3:00:00" / "10/15/2026 3:00 PM"
 * (month first, as the sheet shows them).
 */
export function parseSheetDate(value: unknown): { at: Date; explicitMeridiem: boolean } | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 20_000) {
    return { at: new Date(Math.round((value - 25_569) * 86_400_000) - IST_OFFSET_MS), explicitMeridiem: false };
  }
  const s = String(value ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?)?$/i);
  if (m) {
    let hour = Number(m[4] ?? 0);
    const meridiem = m[7]?.toLowerCase().replace(/\./g, "");
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    const utc = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), hour, Number(m[5] ?? 0), Number(m[6] ?? 0));
    return { at: new Date(utc - IST_OFFSET_MS), explicitMeridiem: Boolean(meridiem) };
  }
  const iso = Date.parse(s);
  return Number.isFinite(iso) ? { at: new Date(iso), explicitMeridiem: true } : null;
}

/**
 * The deadline, fixing the common sheet slip of a 12-hour time typed without AM/PM: a same-day
 * deadline earlier than the assignment ("12:30" → "3:00") is read as PM and flagged as inferred.
 */
export function resolveDeadline(assigned: Date | null, deadline: { at: Date; explicitMeridiem: boolean } | null) {
  if (!deadline) return { deadline: null, inferred: false };
  if (!assigned || deadline.explicitMeridiem || deadline.at > assigned) return { deadline: deadline.at, inferred: false };
  const pm = new Date(deadline.at.getTime() + 12 * 3_600_000);
  const sameDay = (a: Date, b: Date) =>
    new Date(a.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10) === new Date(b.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
  const hourIst = new Date(deadline.at.getTime() + IST_OFFSET_MS).getUTCHours();
  if (hourIst < 12 && sameDay(deadline.at, assigned) && pm > assigned) return { deadline: pm, inferred: true };
  return { deadline: deadline.at, inferred: false };
}

/** Stable across row moves: the same company + assignment time + job id is the same task. */
export function taskIdFor(spreadsheetId: string, tab: string, parts: unknown[]): string {
  return createHash("sha256").update([spreadsheetId, tab, ...parts.map((p) => String(p ?? "").trim())].join("|")).digest("hex").slice(0, 24);
}

/**
 * "10-15" → 15, "20+" → 20, "12" → 12. Read from the cell as displayed: Sheets turns "10-15" into
 * a date, whose raw value would be a serial number like 46310.
 */
export function parseCount(display: string): number {
  const nums = (display.match(/\d+/g) ?? []).map(Number).filter((n) => n > 0 && n < 100_000);
  return nums.length ? Math.max(...nums) : 0;
}

/**
 * [display] is the same grid as shown in the sheet (FORMATTED_VALUE), used for the count columns;
 * [rows] holds raw values (dates as serial numbers).
 */
export function rowsToTasks(spreadsheetId: string, tab: string, rows: unknown[][], c: ControlColumns, display?: unknown[][]): ControlTask[] {
  const at = (r: unknown[], col: number) => (col ? r[col - 1] : undefined);
  const text = (r: unknown[], col: number) => String(at(r, col) ?? "").trim();
  const shown = (i: number, col: number) => (display ? text(display[i] ?? [], col) : text(rows[i] ?? [], col));
  const tasks: ControlTask[] = [];
  for (let i = c.headerRow; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const company = text(r, c.company);
    if (!company) continue;
    const assigned = parseSheetDate(at(r, c.assignedAt));
    const { deadline, inferred } = resolveDeadline(assigned?.at ?? null, parseSheetDate(at(r, c.deadline)));
    tasks.push({
      taskId: taskIdFor(spreadsheetId, tab, [company, at(r, c.assignedAt), at(r, c.jobId), at(r, c.date)]),
      row: i + 1,
      company,
      product: text(r, c.product),
      pc: text(r, c.pc),
      crm: text(r, c.crm),
      techStack: text(r, c.techStack),
      hubspotUrl: text(r, c.hubspot),
      remarks: text(r, c.remarks),
      internalSheetUrl: text(r, c.internalSheet),
      jdUrl: text(r, c.jd),
      openings: shown(i, c.openings),
      profilesRequired: parseCount(shown(i, c.profilesRequired)),
      mechanism: text(r, c.mechanism),
      mentor: text(r, c.mentor),
      assignedAt: assigned?.at ?? null,
      deadline,
      deadlineInferred: inferred,
      trigger: text(r, c.trigger),
      automationStatus: text(r, c.status),
      automationDetails: text(r, c.details),
    });
  }
  return tasks;
}

/** The control tab, cached for 20 s (several phones refreshing at once read Sheets once). */
export async function readControlSnapshot(fresh = false): Promise<ControlSnapshot> {
  const hit = g.__mobileControl;
  if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return hit.snap;
  const { spreadsheetId, tab } = controlTarget();
  const sheets = getSheetsWriter();
  const range = `${q(tab)}!A1:BZ`;
  const [raw, formatted] = await Promise.all([
    withSheetsRetry(() =>
      sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER" }),
    ),
    withSheetsRetry(() => sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: "FORMATTED_VALUE" })),
  ]);
  const rows = (raw.data.values ?? []) as unknown[][];
  const display = (formatted.data.values ?? []) as unknown[][];
  const columns = findColumns(rows);
  if (!columns.mentor) throw new Error('The control tab has no "Mentor" column.');
  const tasks = rowsToTasks(spreadsheetId, tab, rows, columns, display);
  const snap: ControlSnapshot = { spreadsheetId, tab, columns, tasks, readAt: new Date() };
  g.__mobileControl = { at: Date.now(), snap };
  return snap;
}

export function forgetControlSnapshot(): void {
  g.__mobileControl = undefined;
}
