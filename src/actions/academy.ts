"use server";

import { getSheets, extractSpreadsheetId } from "@/lib/sheets";
import { coerceCell } from "@/lib/utils";
import type { ActionResult } from "@/lib/types";

/**
 * Academy bucketing — reading the three Google Sheets. READ ONLY: the service
 * account's Sheets scope is spreadsheets.readonly and nothing here writes.
 * Values come as displayed in the sheet (FORMATTED_VALUE), every row kept as a
 * raw grid so the browser can find the header row itself (the master tab has a
 * group row above its header).
 */

export interface AcademySheetPreview {
  spreadsheetId: string;
  title: string;
  /** Every tab with its first rows (to recognise which tab is which). */
  tabs: { name: string; rowCount: number; rows: string[][] }[];
}

const quote = (tab: string) => `'${tab.replace(/'/g, "''")}'`;
const grid = (values: unknown[][] | null | undefined): string[][] => (values ?? []).map((r) => (r ?? []).map((c) => coerceCell(c)));

export async function previewAcademySheet(url: string): Promise<ActionResult<AcademySheetPreview>> {
  const spreadsheetId = extractSpreadsheetId(url);
  if (!spreadsheetId) return { ok: false, error: "That doesn't look like a Google Sheets link. Paste the full URL." };
  try {
    const sheets = getSheets();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "properties.title,sheets.properties(title,gridProperties(rowCount))",
    });
    const tabs = (meta.data.sheets ?? []).map((t) => ({ name: t.properties?.title ?? "", rowCount: t.properties?.gridProperties?.rowCount ?? 0 })).filter((t) => t.name);
    const heads = tabs.length
      ? await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges: tabs.map((t) => `${quote(t.name)}!1:4`), valueRenderOption: "FORMATTED_VALUE" })
      : { data: { valueRanges: [] } };
    const ranges = heads.data.valueRanges ?? [];
    return {
      ok: true,
      data: {
        spreadsheetId,
        title: meta.data.properties?.title ?? "Untitled",
        tabs: tabs.map((t, i) => ({ ...t, rows: grid(ranges[i]?.values as unknown[][]) })),
      },
    };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

export async function readAcademyTabs(url: string, tabs: string[]): Promise<ActionResult<{ title: string; grids: { name: string; values: string[][] }[] }>> {
  const spreadsheetId = extractSpreadsheetId(url);
  if (!spreadsheetId) return { ok: false, error: "Invalid Google Sheets link." };
  if (!tabs.length) return { ok: true, data: { title: "", grids: [] } };
  try {
    const sheets = getSheets();
    const [meta, res] = await Promise.all([
      sheets.spreadsheets.get({ spreadsheetId, fields: "properties.title" }),
      sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges: tabs.map(quote), valueRenderOption: "FORMATTED_VALUE" }),
    ]);
    const ranges = res.data.valueRanges ?? [];
    return {
      ok: true,
      data: { title: meta.data.properties?.title ?? "Untitled", grids: tabs.map((name, i) => ({ name, values: grid(ranges[i]?.values as unknown[][]) })) },
    };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

function describe(err: unknown): string {
  console.error("[academy-sheets] error:", err);
  const message = err instanceof Error ? err.message : String(err);
  if (/permission|forbidden|403|does not have access|caller does not/i.test(message)) {
    return "The service account can't open this sheet. Share it with the service-account email (Viewer access) and try again.";
  }
  if (/not found|404|unable to parse range/i.test(message)) return "Sheet or tab not found — check the link and that the tab still exists.";
  if (/invalid_grant|invalid.?jwt|account not found/i.test(message)) return "Google authentication failed — check the service-account credentials in .env.local.";
  return `Could not read the sheet: ${message}`;
}
