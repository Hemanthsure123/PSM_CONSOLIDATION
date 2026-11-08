import "server-only";
import type { sheets_v4 } from "googleapis";
import { withSheetsRetry } from "@/lib/automation/control-sheet";
import { env } from "@/lib/env";
import { UserError } from "@/lib/mobile/http";
import { dayOf, findPrepColumns, identityOf, IST_OFFSET_MS, type PrepColumns, type PrepRow, rowsToPreps } from "@/lib/mobile/preps/parse";
import { getSheetsWriter } from "@/lib/sheets";

/**
 * Reads and writes the drill-down tab (A..Z only).
 *
 * The EDGE sheet's "Edge Team drill down" tab is an IMPORTRANGE mirror of the coordination
 * sheet's tab: writing into it breaks the import (#REF! for the whole tab). So the server follows
 * the IMPORTRANGE in A1 to its SOURCE and reads and writes there — the same rows, without the
 * import delay. A tab that isn't an import is used as is.
 *
 * Reads are cached for 30 s, so phones refreshing together and the minute ticker read Sheets
 * once. Writes re-read the target row first and refuse when it no longer holds the same prep, and
 * only write values the source's dropdowns allow.
 */

export interface PrepSnapshot {
  spreadsheetId: string;
  tab: string;
  columns: PrepColumns;
  preps: PrepRow[];
  byKey: Map<string, PrepRow>;
  readAt: Date;
}

export interface PrepSource {
  spreadsheetId: string;
  tab: string;
  /** True when [spreadsheetId] is the source behind an IMPORTRANGE mirror. */
  viaImport: boolean;
}

const CACHE_MS = 30_000;
const SOURCE_TTL_MS = 10 * 60_000;
const g = globalThis as unknown as {
  __prepSnap?: { at: number; snap: PrepSnapshot };
  __prepSnapLoading?: Promise<PrepSnapshot>;
  __prepSheetId?: { key: string; id: number };
  __prepSource?: { at: number; source: PrepSource };
  __prepDropdowns?: { at: number; key: string; v: Dropdowns };
  __prepHeader?: { key: string; row: unknown[] };
  __prepNotMirror?: { key: string; at: number };
};
const q = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

/** Where the app is configured to look: the EDGE sheet's drill-down tab (possibly a mirror). */
export function prepTarget(): { spreadsheetId: string; tab: string } {
  return { spreadsheetId: env.mobile.controlSpreadsheetId, tab: process.env.MOBILE_PREP_TAB?.trim() || "Edge Team drill down" };
}

/** `=IMPORTRANGE("https://…/d/<id>/edit", "'Tab'!A:ZZ")` → the source's id and tab, else null. */
export function parseImportRange(formula: string): { spreadsheetId: string; tab: string } | null {
  const m = formula.match(/IMPORTRANGE\(\s*"([^"]+)"\s*[,;]\s*"([^"]+)"\s*\)/i);
  if (!m) return null;
  const id = m[1].match(/\/d\/([\w-]{20,})/)?.[1] ?? (/^[\w-]{20,}$/.test(m[1].trim()) ? m[1].trim() : null);
  if (!id) return null;
  const range = m[2];
  const bang = range.lastIndexOf("!");
  if (bang < 0) return null;
  const tab = range.slice(0, bang).replace(/^'|'$/g, "").replace(/''/g, "'");
  return tab ? { spreadsheetId: id, tab } : null;
}

/** The tab that holds the data (follows an IMPORTRANGE in A1 to its source), cached 10 min. */
export async function prepSource(): Promise<PrepSource> {
  const hit = g.__prepSource;
  if (hit && Date.now() - hit.at < SOURCE_TTL_MS) return hit.source;
  const target = prepTarget();
  if (!target.spreadsheetId) throw new UserError(503, "The EDGE sheet isn't configured on the server.", "sheets_unavailable");
  let source: PrepSource = { ...target, viaImport: false };
  const res = await withSheetsRetry(() =>
    getSheetsWriter().spreadsheets.values.get({ spreadsheetId: target.spreadsheetId, range: `${q(target.tab)}!A1`, valueRenderOption: "FORMULA" }),
  ).catch(() => null);
  const formula = String(res?.data.values?.[0]?.[0] ?? "");
  const imported = parseImportRange(formula);
  if (imported) source = { ...imported, viaImport: true };
  g.__prepSource = { at: Date.now(), source };
  return source;
}

export async function readPrepSnapshot(fresh = false): Promise<PrepSnapshot> {
  const hit = g.__prepSnap;
  if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return hit.snap;
  // One read at a time: concurrent callers share it.
  if (g.__prepSnapLoading) return g.__prepSnapLoading;
  g.__prepSnapLoading = (async () => {
    const { spreadsheetId, tab } = await prepSource();
    const res = await withSheetsRetry(() =>
      getSheetsWriter().spreadsheets.values.get({
        spreadsheetId,
        range: `${q(tab)}!A1:Z`,
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "SERIAL_NUMBER",
      }),
    );
    const rows = (res.data.values ?? []) as unknown[][];
    if (!rows.length) throw new UserError(503, `The "${tab}" tab is empty.`, "sheets_unavailable");
    let columns: PrepColumns;
    try {
      columns = findPrepColumns(rows[0]);
    } catch (err) {
      // The source moved or its header broke: look the source up again next time.
      g.__prepSource = undefined;
      throw new UserError(503, err instanceof Error ? err.message : "The drill-down tab's header can't be read.", "sheets_unavailable");
    }
    const refYear = new Date(Date.now() + IST_OFFSET_MS).getUTCFullYear();
    const preps = rowsToPreps(rows, columns, refYear, dayOf(new Date()));
    const snap: PrepSnapshot = { spreadsheetId, tab, columns, preps, byKey: new Map(preps.map((p) => [p.key, p])), readAt: new Date() };
    g.__prepSnap = { at: Date.now(), snap };
    g.__prepHeader = { key: `${spreadsheetId}|${tab}`, row: rows[0] };
    return snap;
  })();
  try {
    return await g.__prepSnapLoading;
  } finally {
    g.__prepSnapLoading = undefined;
  }
}

export function forgetPrepSnapshot(): void {
  g.__prepSnap = undefined;
}

async function sheetIdOf(spreadsheetId: string, tab: string): Promise<number> {
  const key = `${spreadsheetId}|${tab}`;
  if (g.__prepSheetId?.key === key) return g.__prepSheetId.id;
  const meta = await withSheetsRetry(() => getSheetsWriter().spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" }));
  const id = meta.data.sheets?.find((s) => s.properties?.title === tab)?.properties?.sheetId;
  if (id == null) throw new UserError(503, `The "${tab}" tab wasn't found.`, "sheets_unavailable");
  g.__prepSheetId = { key, id };
  return id;
}

// ── Dropdowns ────────────────────────────────────────────────────────────────

export interface Dropdowns {
  /** "Prep Given" options, as in the sheet (null = no dropdown: any text). */
  prepGiven: string[] | null;
  /** "Candidate's Status" options, as in the sheet (null = no dropdown). */
  candidateStatus: string[] | null;
}

/** The dropdown values of "Prep Given" and "Candidate's Status" (first data row), cached 10 min. */
export async function readDropdowns(snap: PrepSnapshot): Promise<Dropdowns> {
  const key = `${snap.spreadsheetId}|${snap.tab}`;
  const hit = g.__prepDropdowns;
  if (hit && hit.key === key && Date.now() - hit.at < SOURCE_TTL_MS) return hit.v;
  const col = (n: number) => String.fromCharCode(64 + n);
  const ranges = [snap.columns.prepGiven, snap.columns.candidateStatus].map((c) => (c ? `${q(snap.tab)}!${col(c)}2` : null));
  const listOf = async (range: string | null): Promise<string[] | null> => {
    if (!range) return null;
    const res = await withSheetsRetry(() =>
      getSheetsWriter().spreadsheets.get({ spreadsheetId: snap.spreadsheetId, ranges: [range], includeGridData: true, fields: "sheets.data.rowData.values.dataValidation" }),
    ).catch(() => null);
    const rule = res?.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0]?.dataValidation;
    if (rule?.condition?.type !== "ONE_OF_LIST") return null;
    const values = (rule.condition.values ?? []).map((v) => String(v.userEnteredValue ?? "")).filter((v) => v.trim());
    return values.length ? values : null;
  };
  const [prepGiven, candidateStatus] = await Promise.all([listOf(ranges[0]), listOf(ranges[1])]);
  const v: Dropdowns = { prepGiven, candidateStatus };
  g.__prepDropdowns = { at: Date.now(), key, v };
  return v;
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** A cell the app writes: text, or a date / time with the team's display format. */
export type CellWrite =
  | { col: number; text: string }
  | { col: number; date: { serial: number; pattern: string; type: "DATE" | "TIME" } };

/**
 * Writes cells of one prep's row in the SOURCE tab, after checking the row still holds that prep
 * (the team may have sorted, inserted or edited rows). Never writes into an IMPORTRANGE mirror.
 * Returns the row written.
 */
export async function writePrepCells(key: string, cells: CellWrite[], patch?: (p: PrepRow) => PrepRow): Promise<number> {
  // Fast path: the cached read (≤ 30 s old) and a one-row check. Only when that row no longer
  // holds the prep (rows sorted / inserted) is the whole tab read again to find it.
  let snap = await readPrepSnapshot();
  let prep = snap.byKey.get(key);
  if (!prep || !(await rowStillHolds(snap, prep))) {
    snap = await readPrepSnapshot(true);
    prep = snap.byKey.get(key);
    if (!prep || !(await rowStillHolds(snap, prep))) {
      forgetPrepSnapshot();
      throw new UserError(409, "This row changed or left the drill-down sheet while you were working. Refresh and try again.", "row_moved");
    }
  }
  await assertNotMirror(snap);
  const sheets = getSheetsWriter();
  const sheetId = await sheetIdOf(snap.spreadsheetId, snap.tab);
  const requests: sheets_v4.Schema$Request[] = cells
    .filter((c) => c.col > 0 && c.col <= 26)
    .map((c) => ({
      updateCells: {
        range: { sheetId, startRowIndex: prep.row - 1, endRowIndex: prep.row, startColumnIndex: c.col - 1, endColumnIndex: c.col },
        rows: [
          {
            values: [
              "text" in c
                ? { userEnteredValue: { stringValue: c.text } }
                : {
                    userEnteredValue: { numberValue: c.date.serial },
                    userEnteredFormat: { numberFormat: { type: c.date.type, pattern: c.date.pattern } },
                  },
            ],
          },
        ],
        fields: "text" in c ? "userEnteredValue" : "userEnteredValue,userEnteredFormat.numberFormat",
      },
    }));
  if (!requests.length) return prep.row;
  // A write is never retried blindly (a lost response may have applied); these are idempotent
  // "set cell" writes, so one retry on a transient error is safe.
  await withSheetsRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId: snap.spreadsheetId, requestBody: { requests } }), 2);
  if (patch) {
    // Show the change at once without re-reading the tab; the next read (≤ 1 min) confirms it.
    const updated = patch(prep);
    const i = snap.preps.indexOf(prep);
    if (i >= 0) snap.preps[i] = updated;
    snap.byKey.set(key, updated);
  } else {
    forgetPrepSnapshot();
  }
  return prep.row;
}

/** The columns the app adds at the end of the drill-down tab for prep-call results. */
/**
 * Columns the server adds after the last used column of the drill-down source tab (past Z): the
 * prep calls (phone and Google Meet) and the messages sent. The sheet is the only place call
 * transcripts, summaries and messages are kept — the database stores durations and status only.
 */
export const PREP_CALL_HEADERS = {
  recording: "Prep Call Recording",
  transcript: "Prep Call Transcript",
  summary: "Prep Call Summary",
  duration: "Prep Call Duration",
  messages: "Prep Messages",
} as const;

/** The current text of extra columns (past Z) in the prep's row, found by header ("" when absent). */
export async function readPrepExtraCells(key: string, names: string[]): Promise<Record<string, string>> {
  let snap = await readPrepSnapshot();
  let prep = snap.byKey.get(key);
  if (!prep || !(await rowStillHolds(snap, prep))) {
    snap = await readPrepSnapshot(true);
    prep = snap.byKey.get(key);
    if (!prep || !(await rowStillHolds(snap, prep))) throw new UserError(409, "This row changed or left the drill-down sheet. Refresh and try again.", "row_moved");
  }
  const sheets = getSheetsWriter();
  const res = await withSheetsRetry(() =>
    sheets.spreadsheets.values.batchGet({ spreadsheetId: snap.spreadsheetId, ranges: [`${q(snap.tab)}!A1:ZZ1`, `${q(snap.tab)}!A${prep.row}:ZZ${prep.row}`] }),
  );
  const header = ((res.data.valueRanges?.[0]?.values?.[0] ?? []) as unknown[]).map((h) => String(h ?? "").trim().toLowerCase().replace(/\s+/g, " "));
  const row = (res.data.valueRanges?.[1]?.values?.[0] ?? []) as unknown[];
  return Object.fromEntries(
    names.map((n) => {
      const i = header.indexOf(n.toLowerCase().replace(/\s+/g, " ").trim());
      return [n, i >= 0 ? String(row[i] ?? "") : ""];
    }),
  );
}

/**
 * Writes cells in columns past Z, found by header text; a missing header is added after the last
 * used column (once). Same row checks as writePrepCells. Returns the row written.
 */
export async function writePrepExtraCells(key: string, values: Record<string, string>): Promise<number> {
  let snap = await readPrepSnapshot();
  let prep = snap.byKey.get(key);
  if (!prep || !(await rowStillHolds(snap, prep))) {
    snap = await readPrepSnapshot(true);
    prep = snap.byKey.get(key);
    if (!prep || !(await rowStillHolds(snap, prep))) throw new UserError(409, "This row changed or left the drill-down sheet. Refresh and try again.", "row_moved");
  }
  await assertNotMirror(snap);
  const sheets = getSheetsWriter();
  const head = await withSheetsRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: snap.spreadsheetId, range: `${q(snap.tab)}!A1:ZZ1` }));
  const header = ((head.data.values?.[0] ?? []) as unknown[]).map((h) => String(h ?? "").trim());
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  let last = header.reduce((acc, h, i) => (h ? i + 1 : acc), 0);
  const sheetId = await sheetIdOf(snap.spreadsheetId, snap.tab);
  const requests: sheets_v4.Schema$Request[] = [];
  const cell = (row: number, col: number, text: string): sheets_v4.Schema$Request => ({
    updateCells: {
      range: { sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: col - 1, endColumnIndex: col },
      rows: [{ values: [{ userEnteredValue: { stringValue: text } }] }],
      fields: "userEnteredValue",
    },
  });
  for (const [name, text] of Object.entries(values)) {
    let col = header.findIndex((h) => norm(h) === norm(name)) + 1;
    if (!col) {
      col = Math.max(last, 26) + 1;
      last = col;
      header[col - 1] = name;
      requests.push(cell(1, col, name));
    }
    requests.push(cell(prep.row, col, text.slice(0, 45_000)));
  }
  if (!requests.length) return prep.row;
  // Make room when the grid is narrower than the new columns.
  const need = Math.max(...Object.keys(values).map((n) => header.findIndex((h) => norm(h) === norm(n)) + 1));
  const meta = await withSheetsRetry(() => sheets.spreadsheets.get({ spreadsheetId: snap.spreadsheetId, fields: "sheets.properties(sheetId,gridProperties.columnCount)" }));
  const width = meta.data.sheets?.find((s) => s.properties?.sheetId === sheetId)?.properties?.gridProperties?.columnCount ?? 0;
  if (width && need > width) requests.unshift({ appendDimension: { sheetId, dimension: "COLUMNS", length: need - width } });
  await withSheetsRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId: snap.spreadsheetId, requestBody: { requests } }), 2);
  return prep.row;
}

/** Re-reads one row and checks it still holds [prep] (someone may have edited or moved it). */
async function rowStillHolds(snap: PrepSnapshot, prep: PrepRow): Promise<boolean> {
  const header = g.__prepHeader?.key === `${snap.spreadsheetId}|${snap.tab}` ? g.__prepHeader.row : null;
  if (!header) return false;
  const check = await withSheetsRetry(() =>
    getSheetsWriter().spreadsheets.values.get({
      spreadsheetId: snap.spreadsheetId,
      range: `${q(snap.tab)}!A${prep.row}:Z${prep.row}`,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "SERIAL_NUMBER",
    }),
  );
  const now = rowsToPreps(
    [header, (check.data.values?.[0] ?? []) as unknown[]],
    snap.columns,
    new Date(Date.now() + IST_OFFSET_MS).getUTCFullYear(),
    dayOf(new Date()),
  )[0];
  return Boolean(now && sameIdentity(now, prep));
}

/** Refuse to write when the tab we'd write to is itself an IMPORTRANGE (its cells must stay empty). Checked once per 10 min. */
async function assertNotMirror(snap: PrepSnapshot): Promise<void> {
  const key = `${snap.spreadsheetId}|${snap.tab}`;
  if (g.__prepNotMirror && g.__prepNotMirror.key === key && Date.now() - g.__prepNotMirror.at < SOURCE_TTL_MS) return;
  const res = await withSheetsRetry(() =>
    getSheetsWriter().spreadsheets.values.get({ spreadsheetId: snap.spreadsheetId, range: `${q(snap.tab)}!A1`, valueRenderOption: "FORMULA" }),
  );
  if (parseImportRange(String(res.data.values?.[0]?.[0] ?? ""))) {
    g.__prepSource = undefined;
    throw new UserError(503, "The drill-down tab is a copy of another sheet; the server will write to the original. Try again in a moment.", "sheets_unavailable");
  }
  g.__prepNotMirror = { key, at: Date.now() };
}

/**
 * The row still holds the same prep: same candidate (phone and name), job, round and entry day.
 * Strict on purpose — when in doubt the write is refused and the user refreshes.
 */
function sameIdentity(a: PrepRow, b: PrepRow): boolean {
  const name = (p: PrepRow) => p.candidate.toLowerCase().replace(/\s+/g, " ").trim();
  return identityOf(a) === identityOf(b) && name(a) === name(b) && a.phone === b.phone;
}

/** Today in IST as a Sheets serial (days since 1899-12-30) and the time of day as a fraction. */
export function istSerialNow(now = new Date()): { day: number; time: number } {
  const ist = now.getTime() + IST_OFFSET_MS;
  const day = Math.floor(ist / 86_400_000) + 25_569;
  // Whole minutes, rounded down (23:59:40 stays 11:59 PM, never rolls over to midnight).
  const minutes = Math.floor((ist % 86_400_000) / 60_000);
  return { day, time: minutes / 1440 };
}
