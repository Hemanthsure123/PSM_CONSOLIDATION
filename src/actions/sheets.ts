"use server";

import { getSheets, extractSpreadsheetId } from "@/lib/sheets";
import { coerceCell } from "@/lib/utils";
import type { ActionResult } from "@/lib/types";

export interface SubsheetMeta {
  /** Tab title. */
  name: string;
  /** Header row (first row) of the tab. */
  headers: string[];
  /** Number of data rows (excluding the header). */
  rowCount: number;
}

export interface SpreadsheetMeta {
  spreadsheetId: string;
  title: string;
  subsheets: SubsheetMeta[];
}

/** A single subsheet's full contents: headers + data rows. */
export interface SubsheetData {
  name: string;
  headers: string[];
  /** Each row is a record keyed by header value. */
  rows: Record<string, string>[];
}

/**
 * Inspect a Google Sheets URL: validate access and return every tab (subsheet)
 * with its header row, so the UI can let the user pick a subsheet and columns.
 */
export async function listSubsheets(
  spreadsheetUrl: string,
): Promise<ActionResult<SpreadsheetMeta>> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetUrl);
  if (!spreadsheetId) {
    return { ok: false, error: "That doesn't look like a Google Sheets link. Paste the full URL." };
  }

  try {
    const sheets = getSheets();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "properties.title,sheets.properties(title,gridProperties(rowCount))",
    });

    const title = meta.data.properties?.title ?? "Untitled";
    const tabs = meta.data.sheets ?? [];

    // Batch-read just the first row of every tab to get headers.
    const ranges = tabs
      .map((t) => t.properties?.title)
      .filter((t): t is string => Boolean(t))
      .map((t) => `'${t.replace(/'/g, "''")}'!1:1`);

    const headerRes = ranges.length
      ? await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges })
      : { data: { valueRanges: [] } };

    // valueRanges come back in the same order as the requested ranges (which is
    // tab order, since every tab has a title).
    const valueRanges = headerRes.data.valueRanges ?? [];
    const subsheets: SubsheetMeta[] = tabs.map((t, i) => {
      const name = t.properties?.title ?? `Sheet${i + 1}`;
      const headers = (valueRanges[i]?.values?.[0] ?? []).map((c) => coerceCell(c));
      const totalRows = t.properties?.gridProperties?.rowCount ?? 0;
      return {
        name,
        headers: headers.filter((h) => h !== ""),
        rowCount: Math.max(0, totalRows - 1),
      };
    });

    return { ok: true, data: { spreadsheetId, title, subsheets } };
  } catch (err) {
    return { ok: false, error: describeSheetsError(err) };
  }
}

/**
 * Read the full contents of one subsheet (tab) as header-keyed rows.
 * Blank rows are dropped.
 */
export async function readSubsheet(
  spreadsheetUrl: string,
  sheetName: string,
): Promise<ActionResult<SubsheetData>> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetUrl);
  if (!spreadsheetId) {
    return { ok: false, error: "Invalid Google Sheets link." };
  }

  try {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName.replace(/'/g, "''")}'`,
      valueRenderOption: "FORMATTED_VALUE",
    });

    const matrix = (res.data.values ?? []) as unknown[][];
    if (matrix.length < 1) {
      return { ok: false, error: `Subsheet "${sheetName}" is empty.` };
    }

    const headers = (matrix[0] ?? []).map((c) => coerceCell(c));
    const rows: Record<string, string>[] = [];
    for (let r = 1; r < matrix.length; r++) {
      const raw = matrix[r] ?? [];
      const rec: Record<string, string> = {};
      let any = false;
      headers.forEach((h, i) => {
        if (!h) return;
        const v = coerceCell(raw[i]);
        rec[h] = v;
        if (v) any = true;
      });
      if (any) rows.push(rec);
    }

    return { ok: true, data: { name: sheetName, headers: headers.filter(Boolean), rows } };
  } catch (err) {
    return { ok: false, error: describeSheetsError(err) };
  }
}

function describeSheetsError(err: unknown): string {
  console.error("[sheets] error:", err);
  const message = err instanceof Error ? err.message : String(err);

  if (/permission|forbidden|403|does not have access|caller does not/i.test(message)) {
    return (
      "The service account can't open this sheet. Share the Google Sheet with the " +
      "service-account email (Viewer access) and try again."
    );
  }
  if (/not found|404|unable to parse range/i.test(message)) {
    return "Sheet or tab not found — check the link and that the tab still exists.";
  }
  if (/invalid_grant|invalid.?jwt|account not found/i.test(message)) {
    return "Google authentication failed — check the service-account credentials in .env.local.";
  }
  return `Could not read the sheet: ${message}`;
}
