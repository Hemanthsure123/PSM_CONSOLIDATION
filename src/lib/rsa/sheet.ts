import "server-only";
import { getSheets, getSheetsWriter, withSheetsRetry } from "@/lib/sheets";
import { driveFileId } from "@/lib/mobile/preps/links";

/**
 * The RSA tracking sheet ("Student Level - Interview Feedback Report…" › "> 8 LPA"): one row per
 * RSA document. Columns are found by their header names, never by position. Rows are only ever
 * added (INSERT_ROWS), never overwritten; a document whose link is already in the sheet gets no
 * second row. Override the sheet with RSA_SHEET (id or URL) and RSA_SHEET_TAB.
 */

const DEFAULT_SHEET = "1BRfogq4K7KdGgMoPIRzw3i_lNhtGZYO-Qow5UseyDVU";
const DEFAULT_TAB = "> 8 LPA";
const idFrom = (v: string) => v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1] ?? v.trim();

export function rsaSheet(): { spreadsheetId: string; tab: string } {
  const sheet = process.env.RSA_SHEET?.trim();
  const tab = process.env.RSA_SHEET_TAB?.trim();
  return { spreadsheetId: sheet ? idFrom(sheet) : DEFAULT_SHEET, tab: tab || DEFAULT_TAB };
}

export const RSA_COLUMNS = {
  date: /^date( of entry)?$/i,
  uid: /^(uid|user\s*id)$/i,
  company: /^company( name)?$/i,
  candidate: /^(candidate|student)( name)?$/i,
  mobile: /^(mobile|phone|contact)( numbers?)?$/i,
  resume: /^resume(\s*\(link\)|\s*link)?$/i,
  product: /^product$/i,
  drilldown: /^drill\s*-?\s*down( link)?$/i,
  rsaDoc: /^rsa\s*doc(ument)?( link)?$/i,
} as const;
export type RsaColumn = keyof typeof RSA_COLUMNS;

/** Header names → column index (0-based); -1 when the sheet has no such column. */
export function mapRsaColumns(header: string[]): Record<RsaColumn, number> {
  const norm = header.map((h) => String(h ?? "").replace(/\s+/g, " ").trim());
  return Object.fromEntries(
    (Object.keys(RSA_COLUMNS) as RsaColumn[]).map((k) => [k, norm.findIndex((h) => RSA_COLUMNS[k].test(h))]),
  ) as Record<RsaColumn, number>;
}

export interface RsaSheetEntry {
  date: string;
  uid: string;
  company: string;
  candidate: string;
  mobile: string;
  /** 10-digit numbers in the mobile cell. */
  phones: string[];
  url: string;
  drilldown: string;
  row: number;
}

const phonesIn = (s: string) => [...new Set((s.match(/(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/g) ?? []).map((m) => m.replace(/\D/g, "").slice(-10)))];

/** Grid → entries (pure; the self-test runs it). Header is the first non-empty row. */
export function parseRsaSheet(values: string[][]): { columns: Record<RsaColumn, number>; entries: RsaSheetEntry[]; headerRow: number } {
  const headerRow = Math.max(0, values.findIndex((r) => (r ?? []).filter((c) => String(c ?? "").trim()).length >= 3));
  const columns = mapRsaColumns(values[headerRow] ?? []);
  const at = (r: string[], k: RsaColumn) => (columns[k] >= 0 ? String(r[columns[k]] ?? "").trim() : "");
  const entries: RsaSheetEntry[] = [];
  values.slice(headerRow + 1).forEach((r, i) => {
    const url = at(r ?? [], "rsaDoc");
    if (!/^https?:\/\//i.test(url)) return;
    const mobile = at(r, "mobile");
    entries.push({
      date: at(r, "date"),
      uid: at(r, "uid"),
      company: at(r, "company"),
      candidate: at(r, "candidate"),
      mobile,
      phones: phonesIn(mobile),
      url,
      drilldown: at(r, "drilldown"),
      row: headerRow + 2 + i,
    });
  });
  return { columns, entries, headerRow };
}

const quote = (t: string) => `'${t.replace(/'/g, "''")}'`;

const g = globalThis as unknown as { __rsaSheet?: { at: number; values: string[][] } };
const CACHE_MS = 120_000;

async function readValues(fresh = false): Promise<string[][]> {
  if (!fresh && g.__rsaSheet && Date.now() - g.__rsaSheet.at < CACHE_MS) return g.__rsaSheet.values;
  const { spreadsheetId, tab } = rsaSheet();
  const res = await withSheetsRetry(() => getSheets().spreadsheets.values.get({ spreadsheetId, range: quote(tab), valueRenderOption: "FORMATTED_VALUE" }));
  const values = ((res.data.values ?? []) as unknown[][]).map((r) => r.map((c) => String(c ?? "")));
  g.__rsaSheet = { at: Date.now(), values };
  return values;
}

export async function rsaEntries(fresh = false): Promise<RsaSheetEntry[]> {
  return parseRsaSheet(await readValues(fresh)).entries;
}

/** Same document: the same Google Doc id, else the same link. */
export const sameDoc = (a: string, b: string) => {
  const x = driveFileId(a);
  const y = driveFileId(b);
  return x && y ? x === y : a.trim() === b.trim();
};

/** A candidate's RSA documents in the sheet (by any of their mobile numbers), newest first. */
export async function rsaEntriesForPhone(phone: string): Promise<RsaSheetEntry[]> {
  if (!/^\d{10}$/.test(phone)) return [];
  const entries = await rsaEntries();
  return entries.filter((e) => e.phones.includes(phone)).sort((a, b) => b.row - a.row);
}

export interface RsaRowValues {
  date: string;
  uid: string;
  company: string;
  candidate: string;
  mobile: string;
  resume: string;
  product: string;
  drilldown: string;
  rsaDoc: string;
}

/** The row to add, laid out under the sheet's own headers (pure). Columns the sheet lacks are reported. */
export function rsaRow(header: string[], v: RsaRowValues): { row: string[]; missing: RsaColumn[] } {
  const cols = mapRsaColumns(header);
  const width = Math.max(header.length, ...Object.values(cols).map((i) => i + 1));
  const row = Array.from({ length: width }, () => "");
  const missing: RsaColumn[] = [];
  for (const k of Object.keys(cols) as RsaColumn[]) {
    if (cols[k] < 0) {
      missing.push(k);
      continue;
    }
    row[cols[k]] = v[k];
  }
  return { row, missing };
}

const columnLetter = (i: number) => {
  let out = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
};

/**
 * Fills the Product cell of the document's row when it is EMPTY (rows the app added before the
 * product was known). Nothing else in the row is touched, and a filled cell is never changed.
 */
export async function fillRsaProduct(rsaDoc: string, product: string): Promise<boolean> {
  if (!product.trim()) return false;
  const values = await readValues(true);
  const parsed = parseRsaSheet(values);
  const col = parsed.columns.product;
  const entry = parsed.entries.find((e) => sameDoc(e.url, rsaDoc));
  if (col < 0 || !entry) return false;
  if (String(values[entry.row - 1]?.[col] ?? "").trim()) return false;
  const { spreadsheetId, tab } = rsaSheet();
  await getSheetsWriter().spreadsheets.values.update({
    spreadsheetId,
    range: `${quote(tab)}!${columnLetter(col)}${entry.row}`,
    valueInputOption: "RAW",
    requestBody: { values: [[product]] },
  });
  g.__rsaSheet = undefined;
  return true;
}

/**
 * Adds the document's row unless its link is already there. Never overwrites a row: the sheet
 * inserts a new row after the table. "exists" = a row with this document already exists.
 */
export async function addRsaRow(v: RsaRowValues): Promise<{ status: "added" | "exists"; missing: RsaColumn[] }> {
  const values = await readValues(true);
  const parsed = parseRsaSheet(values);
  if (parsed.columns.rsaDoc < 0) throw new Error(`The RSA sheet has no "RSA Doc" column.`);
  if (parsed.entries.some((e) => sameDoc(e.url, v.rsaDoc))) return { status: "exists", missing: [] };
  const { row, missing } = rsaRow(values[parsed.headerRow] ?? [], v);
  const { spreadsheetId, tab } = rsaSheet();
  // Not retried: a write whose answer was lost may already be in the sheet (the next run sees it).
  await getSheetsWriter().spreadsheets.values.append({
    spreadsheetId,
    range: `${quote(tab)}!A${parsed.headerRow + 1}`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
  g.__rsaSheet = undefined;
  return { status: "added", missing };
}
