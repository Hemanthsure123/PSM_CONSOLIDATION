import ExcelJS from "exceljs";
import { type CompanyFull, type CompanySort, type CompanyState, countsText, exportRows, type RequirementFull } from "@/lib/mobile/pool/companies-model";

/**
 * Companies' Excel file (PSM 1.12.0): the export (one row per requirement, the screen's filters and
 * sort) and the import of its "Tentative start date" column. Pure apart from exceljs (no network,
 * no database): tested in scripts/companies-selftest.ts by writing a file and reading it back.
 */

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const START_HEADER = "Tentative start date";
export const REF_HEADER = "Ref (do not edit)";
const MAX_IMPORT_ROWS = 5000;

const STATE_LABEL: Record<CompanyState, string> = { in_progress: "In progress", waiting: "Waiting for update", on_hold: "On hold", done: "Done" };

export interface ExportMeta {
  generatedAt: Date;
  generatedBy: string;
  filters: string;
  sharesSyncedAt: string | null;
  masterReadAt: string | null;
  hubspotReadAt: string | null;
}

const ist = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })
    : "never";

/** A YYYY-MM-DD day as an Excel date (midnight UTC, shown as a date with no time). */
const excelDay = (day: string) => new Date(`${day}T00:00:00.000Z`);

const link = (url: string | null, text: string) => (url ? { text, hyperlink: url } : "");

interface Col {
  header: string;
  key: string;
  width: number;
  value: (c: CompanyFull, r: RequirementFull) => ExcelJS.CellValue;
  numFmt?: string;
  wrap?: boolean;
}

const COLUMNS: Col[] = [
  { header: "Company", key: "company", width: 26, value: (c) => c.company },
  { header: "Role", key: "role", width: 32, value: (_c, r) => r.role },
  { header: "Job type", key: "jobType", width: 16, value: (_c, r) => r.jobType },
  { header: "CRP month", key: "crpMonth", width: 11, value: (_c, r) => r.crpMonth ?? "" },
  { header: "CRP week", key: "crpWeek", width: 9, value: (_c, r) => r.crpWeek ?? "" },
  { header: "CTC (LPA)", key: "ctc", width: 16, value: (_c, r) => r.ctcText },
  { header: "Openings", key: "openings", width: 9, value: (_c, r) => r.openings ?? "" },
  { header: "Academy profiles sent (master)", key: "academySent", width: 14, value: (_c, r) => r.academySent ?? "" },
  { header: "Assessed academy sent (master)", key: "assessedSent", width: 14, value: (_c, r) => r.assessedSent ?? "" },
  { header: "Non-assessed academy sent (master)", key: "nonAssessedSent", width: 14, value: (_c, r) => r.nonAssessedSent ?? "" },
  { header: "Assessed academy found in company sheet (verified)", key: "verified", width: 16, value: (_c, r) => r.verifiedAssessed ?? "" },
  { header: "Check", key: "check", width: 40, value: (_c, r) => r.check, wrap: true },
  {
    header: "Academy outcome in company sheet",
    key: "outcome",
    width: 40,
    value: (c) => (!c.sheetUrl ? "No company sheet in the master" : c.counts.candidates ? countsText(c.counts) : "No Academy assessed candidate found in the sheet"),
    wrap: true,
  },
  { header: "Company progress (Academy)", key: "state", width: 16, value: (c) => STATE_LABEL[c.state] },
  { header: "Final status (master)", key: "finalStatus", width: 26, value: (_c, r) => r.finalStatus },
  { header: "Current stage (master)", key: "stage", width: 22, value: (_c, r) => r.stage },
  { header: "JD link", key: "jd", width: 14, value: (_c, r) => link(r.jdUrl, "Open JD") },
  { header: "Nurturing remarks (HubSpot, when no JD link)", key: "remarks", width: 60, value: (_c, r) => r.remarksFull ?? "", wrap: true },
  {
    header: "JD / remarks source",
    key: "source",
    width: 22,
    value: (_c, r) => (r.jdSource === "master" ? "CRPs master (JD column)" : r.jdSource === "hubspot" ? "HubSpot deal" : r.remarksFull ? "HubSpot deal (remarks)" : r.hubspotNote || "Not available"),
  },
  { header: "HubSpot deal", key: "hubspot", width: 14, value: (_c, r) => link(r.hubspotUrl, "Open deal") },
  { header: "Company sheet", key: "sheet", width: 14, value: (c) => link(c.sheetUrl, "Open sheet") },
  { header: "ISE", key: "ise", width: 14, value: (c) => c.ise },
  { header: START_HEADER, key: "start", width: 16, value: (_c, r) => (r.tentativeStart ? excelDay(r.tentativeStart.date) : ""), numFmt: "dd-mmm-yyyy" },
  { header: "Tentative start set by", key: "startBy", width: 18, value: (_c, r) => (r.tentativeStart ? r.tentativeStart.by : "") },
  { header: REF_HEADER, key: "ref", width: 26, value: (_c, r) => r.key },
];

/** The workbook: "Companies" (one row per requirement) and "About" (sources, definitions, how to import). */
export async function companiesWorkbook(
  list: CompanyFull[],
  sort: CompanySort,
  meta: ExportMeta,
  period: { from?: string | null; to?: string | null } = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "PSM";
  wb.created = meta.generatedAt;
  const ws = wb.addWorksheet("Companies", { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.alignment = { vertical: "middle", wrapText: true };
  head.height = 48;
  head.eachCell((cell, n) => {
    const editable = COLUMNS[n - 1].header === START_HEADER;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: editable ? "FF1E7B4F" : "FF1F3A5F" } };
  });
  const rows = exportRows(list, sort, period);
  for (const { company, req } of rows) {
    const row = ws.addRow(Object.fromEntries(COLUMNS.map((c) => [c.key, c.value(company, req)])));
    COLUMNS.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      if (c.numFmt) cell.numFmt = c.numFmt;
      cell.alignment = { vertical: "top", wrapText: Boolean(c.wrap) };
      if (cell.value && typeof cell.value === "object" && "hyperlink" in cell.value) cell.font = { color: { argb: "FF1155CC" }, underline: true };
      if (c.header === START_HEADER) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF6EE" } };
        cell.dataValidation = {
          type: "date",
          operator: "between",
          allowBlank: true,
          showErrorMessage: true,
          errorTitle: "Not a date",
          error: "Type a date, for example 03-Dec-2026.",
          formulae: [new Date(Date.UTC(2020, 0, 1)), new Date(Date.UTC(2100, 11, 31))],
        };
      }
      if (c.key === "check" && req.check) cell.font = { color: { argb: "FF9A5B00" } };
    });
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };

  const about = wb.addWorksheet("About");
  about.columns = [
    { header: "", key: "a", width: 34 },
    { header: "", key: "b", width: 110 },
  ];
  const lines: [string, string][] = [
    ["Academy companies", ""],
    ["Generated", `${ist(meta.generatedAt.toISOString())} IST by ${meta.generatedBy}`],
    ["Filters", meta.filters],
    ["Rows", `${rows.length} requirement(s) in ${list.length} hiring drive(s)`],
    ["CRPs master last read", `${ist(meta.masterReadAt)} IST (">8 LPA Companies" sheet, tab CRPs; read every hour)`],
    ["Company sheets last synced", `${ist(meta.sharesSyncedAt)} IST (every hour)`],
    ["HubSpot last read", `${ist(meta.hubspotReadAt)} IST (read-only; each deal at most once a day)`],
    ["", ""],
    ["Where each column comes from", ""],
    ["Company … Current stage (master)", "Typed by the team in the CRPs master sheet, copied as they are."],
    ["Academy / assessed / non-assessed sent (master)", "The master's counts, typed by the team. Not changed by the app."],
    [
      "Assessed academy found in company sheet (verified)",
      "Academy assessed candidates actually present in the company sheet (profile tabs, or an applications tab with a round filled in), matched to the \"> 8LPA Assessed Pool\" by phone, then email. Blank when the sheet serves several requirements and the tabs don't say which.",
    ],
    ["Check", "Shown when the master and the company sheet disagree, or the master's total isn't assessed + non-assessed. Fix the master if it is behind."],
    ["Non-assessed academy", "Only the master knows this number: the app has no list of non-assessed Academy students to check it against."],
    ["Academy outcome in company sheet", "Each Academy assessed candidate's status in the company sheet: the latest decisive round (rejected, selected, cleared…), with the requirement's master status (closed / on hold) applied."],
    ["Company progress (Academy)", "In progress: an Academy candidate is in process or awaiting a result. Waiting for update: shared, nothing filled in yet. On hold. Done: the requirement closed, or every Academy candidate finished."],
    ["JD link", "The master's JD column when it holds a link, else the HubSpot deal's JD link."],
    ["Nurturing remarks (HubSpot, when no JD link)", "The HubSpot deal's \"Nurturing Team Remarks\", only when there is no JD link. The deal is the master's Hubspot link."],
    ["", ""],
    ["Tentative start date", "Fill the green column (a date) and import this file in the app: Pool → Companies → ⋮ → Import dates from Excel. Each date shows in the Calendar as the requirement's tentative start. An empty cell changes nothing; to remove a date, clear it in the app."],
    ["Ref (do not edit)", "Identifies the requirement when the file is imported. Rows without it are skipped."],
  ];
  for (const [a, b] of lines) about.addRow({ a, b });
  about.getRow(1).font = { bold: true, size: 14 };
  about.getRow(9).font = { bold: true };
  about.getColumn(1).font = { bold: true };
  about.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── Import ──────────────────────────────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => {
  const t = Date.UTC(y, m - 1, d);
  const s = new Date(t).toISOString().slice(0, 10);
  return s === `${y}-${pad(m)}-${pad(d)}` ? s : null;
};

/**
 * A typed date → YYYY-MM-DD: an Excel date, an Excel serial number, "2026-12-03", "03-12-2026" /
 * "03/12/2026" (day first, as in India), "3 Dec 2026", "03-Dec-2026", "Dec 3, 2026". Null otherwise.
 */
export function dayOfCell(v: ExcelJS.CellValue): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    if (v < 20_000 || v > 80_000) return null; // 1954 … 2119
    return new Date(Math.round((v - 25_569) * 86_400_000)).toISOString().slice(0, 10);
  }
  if (typeof v === "object") {
    const o = v as { result?: ExcelJS.CellValue; text?: string; richText?: { text: string }[] };
    if ("result" in o) return dayOfCell(o.result ?? null);
    if (o.richText) return dayOfCell(o.richText.map((t) => t.text).join(""));
    if (typeof o.text === "string") return dayOfCell(o.text);
    return null;
  }
  const t = String(v).trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/, "$1");
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return ymd(+m[3], +m[2], +m[1]);
  m = t.match(/^(\d{1,2})[\s-]+([a-z]{3})[a-z]*[\s,-]+(\d{4})$/);
  if (m && MONTHS.includes(m[2])) return ymd(+m[3], MONTHS.indexOf(m[2]) + 1, +m[1]);
  m = t.match(/^([a-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && MONTHS.includes(m[1])) return ymd(+m[3], MONTHS.indexOf(m[1]) + 1, +m[2]);
  return null;
}

const cellString = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && !(v instanceof Date)) {
    const o = v as { result?: ExcelJS.CellValue; text?: string; richText?: { text: string }[] };
    if ("result" in o) return cellString(o.result ?? null);
    if (o.richText) return o.richText.map((t) => t.text).join("");
    if (typeof o.text === "string") return o.text;
  }
  return String(v);
};

export interface ImportRow {
  /** 1-based sheet row. */
  row: number;
  ref: string;
  day: string;
}

export interface ImportRead {
  rows: ImportRow[];
  invalid: { row: number; reason: string }[];
  /** Rows with a Ref and an empty date (nothing to change). */
  empty: number;
}

/** Reads the "Tentative start date" and Ref columns of an exported file (headers found by name in the first 5 rows). */
export async function readStartsWorkbook(bytes: Buffer): Promise<ImportRead> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new Error("not_xlsx");
  }
  const sheets = [wb.getWorksheet("Companies"), ...wb.worksheets].filter((s): s is ExcelJS.Worksheet => Boolean(s));
  for (const ws of sheets) {
    let headRow = 0;
    let refCol = 0;
    let dayCol = 0;
    for (let r = 1; r <= Math.min(5, ws.rowCount); r++) {
      const row = ws.getRow(r);
      row.eachCell((cell, c) => {
        const h = cellString(cell.value).trim().toLowerCase();
        if (h === REF_HEADER.toLowerCase() || h === "ref") refCol = c;
        if (h === START_HEADER.toLowerCase()) dayCol = c;
      });
      if (refCol && dayCol) {
        headRow = r;
        break;
      }
      refCol = 0;
      dayCol = 0;
    }
    if (!headRow) continue;
    const out: ImportRead = { rows: [], invalid: [], empty: 0 };
    const last = Math.min(ws.rowCount, headRow + MAX_IMPORT_ROWS);
    for (let r = headRow + 1; r <= last; r++) {
      const row = ws.getRow(r);
      const ref = cellString(row.getCell(refCol).value).trim().toLowerCase();
      const raw = row.getCell(dayCol).value;
      const rawText = cellString(raw).trim();
      if (!ref) {
        if (rawText) out.invalid.push({ row: r, reason: "No Ref in this row" });
        continue;
      }
      if (!/^[0-9a-f]{24}$/.test(ref)) {
        out.invalid.push({ row: r, reason: "The Ref was changed" });
        continue;
      }
      if (!rawText && !(raw instanceof Date)) {
        out.empty++;
        continue;
      }
      const day = dayOfCell(raw);
      if (!day) {
        out.invalid.push({ row: r, reason: `"${rawText.slice(0, 30)}" is not a date` });
        continue;
      }
      out.rows.push({ row: r, ref, day });
    }
    return out;
  }
  throw new Error("no_columns");
}
