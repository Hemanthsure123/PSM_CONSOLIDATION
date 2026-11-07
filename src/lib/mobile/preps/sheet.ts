import "server-only";
import type { sheets_v4 } from "googleapis";
import { withSheetsRetry } from "@/lib/automation/control-sheet";
import { env } from "@/lib/env";
import { UserError } from "@/lib/mobile/http";
import { dayOf, findPrepColumns, identityOf, IST_OFFSET_MS, type PrepColumns, type PrepRow, rowsToPreps } from "@/lib/mobile/preps/parse";
import { getSheetsWriter } from "@/lib/sheets";

/**
 * Reads and writes the drill-down tab (A..Z only). Reads are cached for 30 s, so phones
 * refreshing together and the minute ticker read Sheets once. Writes always re-read the target
 * row first and refuse when it no longer holds the same prep (rows can be sorted or deleted by
 * the team while the app has them open).
 */

export interface PrepSnapshot {
  spreadsheetId: string;
  tab: string;
  columns: PrepColumns;
  preps: PrepRow[];
  byKey: Map<string, PrepRow>;
  readAt: Date;
}

const CACHE_MS = 30_000;
const g = globalThis as unknown as { __prepSnap?: { at: number; snap: PrepSnapshot }; __prepSnapLoading?: Promise<PrepSnapshot>; __prepSheetId?: number };
const q = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

export function prepTarget(): { spreadsheetId: string; tab: string } {
  return { spreadsheetId: env.mobile.controlSpreadsheetId, tab: process.env.MOBILE_PREP_TAB?.trim() || "Edge Team drill down" };
}

export async function readPrepSnapshot(fresh = false): Promise<PrepSnapshot> {
  const hit = g.__prepSnap;
  if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return hit.snap;
  // One read at a time: concurrent callers share it.
  if (g.__prepSnapLoading) return g.__prepSnapLoading;
  g.__prepSnapLoading = (async () => {
    const { spreadsheetId, tab } = prepTarget();
    if (!spreadsheetId) throw new UserError(503, "The EDGE sheet isn't configured on the server.", "sheets_unavailable");
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
    const columns = findPrepColumns(rows[0]);
    const refYear = new Date(Date.now() + IST_OFFSET_MS).getUTCFullYear();
    const preps = rowsToPreps(rows, columns, refYear, dayOf(new Date()));
    const snap: PrepSnapshot = { spreadsheetId, tab, columns, preps, byKey: new Map(preps.map((p) => [p.key, p])), readAt: new Date() };
    g.__prepSnap = { at: Date.now(), snap };
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
  if (g.__prepSheetId !== undefined) return g.__prepSheetId;
  const meta = await withSheetsRetry(() => getSheetsWriter().spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" }));
  const id = meta.data.sheets?.find((s) => s.properties?.title === tab)?.properties?.sheetId;
  if (id == null) throw new UserError(503, `The "${tab}" tab wasn't found in the EDGE sheet.`, "sheets_unavailable");
  g.__prepSheetId = id;
  return id;
}

/** A cell the app writes: text, or a date / time with the team's display format. */
export type CellWrite =
  | { col: number; text: string }
  | { col: number; date: { serial: number; pattern: string; type: "DATE" | "TIME" } };

/**
 * Writes cells of one prep's row, after checking the row still holds that prep. If the row moved
 * (the team sorted or inserted rows), the prep is found again by its key. Returns the row written.
 */
export async function writePrepCells(key: string, cells: CellWrite[]): Promise<number> {
  const snap = await readPrepSnapshot(true);
  const prep = snap.byKey.get(key);
  if (!prep) throw new UserError(409, "This row is no longer in the drill-down sheet (it was changed or deleted). Refresh and try again.", "row_moved");
  const sheets = getSheetsWriter();
  // Re-check the exact row just before writing: someone may have edited it since the read.
  const check = await withSheetsRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: snap.spreadsheetId,
      range: `${q(snap.tab)}!A${prep.row}:Z${prep.row}`,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "SERIAL_NUMBER",
    }),
  );
  const header = await headerRow(snap);
  const now = rowsToPreps(
    [header, (check.data.values?.[0] ?? []) as unknown[]],
    snap.columns,
    new Date(Date.now() + IST_OFFSET_MS).getUTCFullYear(),
    dayOf(new Date()),
  )[0];
  if (!now || !sameIdentity(now, prep)) {
    forgetPrepSnapshot();
    throw new UserError(409, "The drill-down sheet changed while you were working. Refresh and try again.", "row_moved");
  }
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
  forgetPrepSnapshot();
  return prep.row;
}

const g2 = globalThis as unknown as { __prepHeader?: unknown[] };
async function headerRow(snap: PrepSnapshot): Promise<unknown[]> {
  if (g2.__prepHeader) return g2.__prepHeader;
  const res = await withSheetsRetry(() =>
    getSheetsWriter().spreadsheets.values.get({ spreadsheetId: snap.spreadsheetId, range: `${q(snap.tab)}!A1:Z1` }),
  );
  g2.__prepHeader = (res.data.values?.[0] ?? []) as unknown[];
  return g2.__prepHeader;
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
