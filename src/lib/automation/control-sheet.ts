import "server-only";
import { getSheetsWriter } from "@/lib/sheets";
import { columnLetter } from "@/lib/automation/delivery-rules";
import { detailsText, statusLabel, type DetailsInput } from "@/lib/automation/sheet-text";
import type { ControlRequest } from "@/lib/automation/types";

/**
 * The control row in the coordination sheet: reading a request, and writing "Automation
 * Status" / "Automation Details" back. Columns are found by their header text, so the team can
 * move or add columns freely. A status write never throws — the job carries on and the next
 * write (or the sheet's own check-in) catches the row up.
 */

export const CONTROL_HEADERS = {
  instructions: "Screening Instructions",
  trigger: "Trigger",
  status: "Automation Status",
  details: "Automation Details",
} as const;

interface Layout {
  headerRow: number;
  /** 1-based columns (0 = not found). */
  instructions: number;
  trigger: number;
  status: number;
  details: number;
  internalSheet: number;
  profilesRequired: number;
  companyName: number;
}

const q = (tab: string) => `'${tab.replace(/'/g, "''")}'`;
const squeeze = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

const layoutCache = new Map<string, { at: number; layout: Layout }>();

/** Find the header row (the one with "Screening Instructions", within the first 6 rows) and the columns. */
export async function controlLayout(spreadsheetId: string, tab: string, fresh = false): Promise<Layout> {
  const key = `${spreadsheetId}|${tab}`;
  const hit = layoutCache.get(key);
  if (hit && !fresh && Date.now() - hit.at < 5 * 60_000) return hit.layout;
  const res = await getSheetsWriter().spreadsheets.values.get({ spreadsheetId, range: `${q(tab)}!1:6` });
  const rows = (res.data.values ?? []) as unknown[][];
  const idx = rows.findIndex((r) => r.some((c) => squeeze(c) === squeeze(CONTROL_HEADERS.instructions)));
  if (idx < 0) throw new Error(`The "${tab}" tab has no "${CONTROL_HEADERS.instructions}" column — run setup in the sheet's Apps Script.`);
  const head = rows[idx].map(squeeze);
  const find = (re: RegExp) => head.findIndex((h) => re.test(h)) + 1;
  const layout: Layout = {
    headerRow: idx + 1,
    instructions: head.indexOf(squeeze(CONTROL_HEADERS.instructions)) + 1,
    trigger: head.indexOf(squeeze(CONTROL_HEADERS.trigger)) + 1,
    status: head.indexOf(squeeze(CONTROL_HEADERS.status)) + 1,
    details: head.indexOf(squeeze(CONTROL_HEADERS.details)) + 1,
    internalSheet: find(/^internal sheets?\b/),
    profilesRequired: find(/profiles required/),
    companyName: find(/^company name/),
  };
  for (const k of ["trigger", "status", "details"] as const) {
    if (!layout[k]) throw new Error(`The "${tab}" tab has no "${CONTROL_HEADERS[k]}" column — run setup in the sheet's Apps Script.`);
  }
  layoutCache.set(key, { at: Date.now(), layout });
  return layout;
}

/** One control row as a request (the sheet is the source of truth, not what the caller sent). */
export async function readControlRequest(spreadsheetId: string, tab: string, row: number): Promise<ControlRequest> {
  const layout = await controlLayout(spreadsheetId, tab);
  if (row <= layout.headerRow) throw new Error(`Row ${row} is the header, not a request.`);
  const res = await getSheetsWriter().spreadsheets.values.get({ spreadsheetId, range: `${q(tab)}!${row}:${row}` });
  const cells = ((res.data.values ?? [])[0] ?? []) as unknown[];
  const at = (col: number) => (col ? String(cells[col - 1] ?? "").trim() : "");
  return {
    spreadsheetId,
    sheetName: tab,
    row,
    instructions: at(layout.instructions),
    trigger: at(layout.trigger),
    internalSheetUrl: at(layout.internalSheet),
    profilesRequired: at(layout.profilesRequired),
    companyName: at(layout.companyName),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const transient = (err: unknown) => {
  const e = err as { code?: number | string; response?: { status?: number } };
  const status = Number(e.response?.status ?? e.code);
  return status === 429 || status >= 500 || /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket/i.test(String((err as Error)?.message));
};

/** Retry a Sheets call on rate limits / server errors / network blips (3 tries). */
export async function withSheetsRetry<T>(work: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await work();
    } catch (err) {
      if (i >= tries || !transient(err)) throw err;
      await sleep(2_000 * i * i);
    }
  }
}

/**
 * Write the status to the job's row. The row is found by the job id in "Automation Details"
 * (rows can move while a job runs); a row that never showed this job is used only if it still
 * says "start" for these instructions.
 */
export async function writeControlStatus(
  job: { id: string; spreadsheetId: string; controlTab: string; controlRow: number; instructions: string },
  details: Omit<DetailsInput, "jobId">,
  opts: { requestId?: string } = {},
): Promise<boolean> {
  try {
    const layout = await controlLayout(job.spreadsheetId, job.controlTab);
    const sheets = getSheetsWriter();
    const col = await withSheetsRetry(() =>
      sheets.spreadsheets.values.get({ spreadsheetId: job.spreadsheetId, range: `${q(job.controlTab)}!${columnLetter(layout.details)}:${columnLetter(layout.details)}` }),
    );
    const values = ((col.data.values ?? []) as unknown[][]).map((r) => String(r[0] ?? ""));
    let row = values.findIndex((v, i) => i + 1 > layout.headerRow && (v.includes(job.id) || (opts.requestId ? v.includes(opts.requestId) : false))) + 1;
    if (!row) {
      const req = await readControlRequest(job.spreadsheetId, job.controlTab, job.controlRow).catch(() => null);
      if (req && req.trigger.toLowerCase() === "start" && req.instructions === job.instructions) row = job.controlRow;
    }
    if (!row) {
      console.warn(`[automation] job ${job.id}: its control row wasn't found — status not written.`);
      return false;
    }
    await withSheetsRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: job.spreadsheetId,
        requestBody: {
          valueInputOption: "RAW",
          data: [
            { range: `${q(job.controlTab)}!${columnLetter(layout.status)}${row}`, values: [[statusLabel(details.status)]] },
            { range: `${q(job.controlTab)}!${columnLetter(layout.details)}${row}`, values: [[detailsText({ ...details, jobId: job.id })]] },
          ],
        },
      }),
    );
    return true;
  } catch (err) {
    console.warn(`[automation] job ${job.id}: status write failed:`, err instanceof Error ? err.message : err);
    return false;
  }
}
