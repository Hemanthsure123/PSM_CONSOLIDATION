import "server-only";
import { getSheetsWriter } from "@/lib/sheets";
import { withSheetsRetry } from "@/lib/automation/control-sheet";
import { readControlSnapshot } from "@/lib/mobile/control-rows";
import type { RosterUser } from "@/lib/mobile/roster";

/**
 * Keeps the control sheet's Mentor dropdown equal to the active roster, so a person an admin adds
 * in the app can be picked in the sheet at once (and nobody can pick someone without the app).
 * Best effort: a failure is reported, the roster change itself still stands.
 */
export async function syncMentorDropdown(roster: RosterUser[]): Promise<{ ok: boolean; message?: string }> {
  try {
    const snap = await readControlSnapshot(true);
    const col = snap.columns.mentor;
    if (!col) return { ok: false, message: 'No "Mentor" column in the control tab.' };
    const sheets = getSheetsWriter();
    const meta = await withSheetsRetry(() =>
      sheets.spreadsheets.get({ spreadsheetId: snap.spreadsheetId, fields: "sheets.properties(sheetId,title,gridProperties.rowCount)" }),
    );
    const props = meta.data.sheets?.find((s) => s.properties?.title === snap.tab)?.properties;
    if (props?.sheetId == null) return { ok: false, message: "Control tab not found." };
    const names = roster.filter((u) => u.active).map((u) => u.name);
    // Rewriting the rule drops the sheet's chip colours, so only do it when the names changed
    // (making someone an admin, or a lead, leaves the dropdown alone).
    const current = await currentOptions(snap.spreadsheetId, snap.tab, snap.columns.headerRow + 1, col);
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((n) => b.includes(n));
    if (current && same(current, names)) return { ok: true, message: "Mentor dropdown already lists everyone." };
    await withSheetsRetry(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: snap.spreadsheetId,
        requestBody: {
          requests: [
            {
              setDataValidation: {
                range: {
                  sheetId: props.sheetId!,
                  startRowIndex: snap.columns.headerRow,
                  endRowIndex: props.gridProperties?.rowCount ?? 1000,
                  startColumnIndex: col - 1,
                  endColumnIndex: col,
                },
                rule: {
                  condition: { type: "ONE_OF_LIST", values: names.map((userEnteredValue) => ({ userEnteredValue })) },
                  strict: true,
                  showCustomUi: true,
                },
              },
            },
          ],
        },
      }),
    );
    return { ok: true, message: `Mentor dropdown now lists: ${names.join(", ")}.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }
}

/** The dropdown options on the first data row's Mentor cell, or null when it has no list rule. */
async function currentOptions(spreadsheetId: string, tab: string, row: number, col: number): Promise<string[] | null> {
  const sheets = getSheetsWriter();
  const a1 = `'${tab.replace(/'/g, "''")}'!${columnLetter(col)}${row}`;
  const res = await withSheetsRetry(() =>
    sheets.spreadsheets.get({ spreadsheetId, ranges: [a1], fields: "sheets.data.rowData.values.dataValidation" }),
  );
  const rule = res.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0]?.dataValidation;
  if (rule?.condition?.type !== "ONE_OF_LIST") return null;
  return (rule.condition.values ?? []).map((v) => String(v.userEnteredValue ?? "").trim()).filter(Boolean);
}

function columnLetter(n: number): string {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
