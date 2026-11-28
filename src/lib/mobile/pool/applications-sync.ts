import "server-only";
import { google, type sheets_v4 } from "googleapis";
import { query, transaction } from "@/lib/db/client";
import { buildApplications, type BuiltApplications, findApplicationColumns, internalSheetsOf, type PoolLookup } from "@/lib/mobile/pool/applications";
import { type MasterRequirement, pickTabs, type SheetTab, type TabInfo } from "@/lib/mobile/pool/shares";
import { getSheets, withSheetsRetry } from "@/lib/sheets";
import { teamStatus, withTeam } from "@/lib/team/google";

/**
 * The applications part of the hourly company-sheet run (PSM 1.13.0). Read-only on every sheet.
 *
 * For each internal sheet the CRPs master lists ("Internal sheet Link"): Drive's modifiedTime decides
 * whether to read it again (never read, changed, or read more than 24 h ago), at most
 * MAX_INTERNAL_PER_RUN a run. A read is one spreadsheets.get (tabs), one values.batchGet of every tab's
 * first 6 rows (to find the applications tabs by their headers), and one values.batchGet of those tabs
 * only, paced like the company sheets. Rows matched to the Academy assessed pool are upserted into
 * app.job_applications; the ones that left the sheet are marked removed. A sheet that can't be read
 * gets read_error and the run carries on. Called by shares-sync.ts (which passes its pacer and Drive
 * check, so the two modules don't import each other).
 *
 * Most internal sheets are shared inside the organisation, not with the service account: a sheet the
 * service account can't open is read as the team Google account (read-only calls), when it is
 * connected. internal_sheets.read_via says which.
 */

export const MAX_INTERNAL_PER_RUN = 60;
const STALE_MS = 24 * 3_600_000;
const RETRY_FAILED_MS = 60 * 60_000;
const MAX_TABS = 60;
const MAX_COLUMNS = 104; // CZ
const HEAD_ROWS = 6;
const MAX_DATA_ROWS = 20_000;

const q = (tab: string) => `'${tab.replace(/'/g, "''")}'`;
const short = (err: unknown) => (err instanceof Error ? err.message.replace(/\s+/g, " ").slice(0, 300) : String(err).slice(0, 300));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 1 → A, 27 → AA. */
function columnName(n: number): string {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

export type DriveCheck =
  | { ok: true; modifiedAt: Date | null; createdAt: Date | null }
  | { ok: false; noAccess: boolean; error: string };

const NO_ACCESS = "Neither the service account nor the team Google account can open this internal sheet: share it (Viewer) with the service account.";

function isNoAccess(err: unknown): boolean {
  const e = err as { code?: number | string; status?: number };
  const code = Number(e?.code ?? e?.status);
  return code === 404 || (code === 403 && !/rate ?limit|quota/i.test(short(err)));
}

/**
 * One internal sheet's applications tabs: their headers decide which tabs are read in full. Hidden
 * tabs are included (raw exports are often hidden); a "Read me" isn't.
 */
export async function readInternalSheet(spreadsheetId: string, pace: () => Promise<void>, client: sheets_v4.Sheets = getSheets()): Promise<SheetTab[]> {
  await pace();
  const meta = await withSheetsRetry(() =>
    client.spreadsheets.get(
      { spreadsheetId, fields: "sheets.properties(sheetId,title,hidden,sheetType,gridProperties(rowCount,columnCount))" },
      { timeout: 60_000 },
    ),
  );
  const all: TabInfo[] = (meta.data.sheets ?? [])
    .map((s) => s.properties ?? {})
    .filter((p) => p.title && (p.sheetType ?? "GRID") === "GRID")
    .map((p) => ({
      title: p.title!,
      gid: p.sheetId ?? -1,
      hidden: Boolean(p.hidden),
      rowCount: p.gridProperties?.rowCount ?? 1000,
      columnCount: p.gridProperties?.columnCount ?? 26,
    }));
  // pickTabs drops hidden tabs and read-mes; hidden exports are kept here, read-mes are not.
  const visible = new Set(pickTabs(all).map((t) => t.gid));
  const tabs = all.filter((t) => visible.has(t.gid) || (t.hidden && !/read\s*-?\s*me/i.test(t.title))).slice(0, MAX_TABS);
  if (!tabs.length) return [];
  const width = (t: TabInfo) => columnName(Math.min(Math.max(t.columnCount, 1), MAX_COLUMNS));
  await pace();
  const heads = await withSheetsRetry(() =>
    client.spreadsheets.values.batchGet(
      { spreadsheetId, ranges: tabs.map((t) => `${q(t.title)}!A1:${width(t)}${HEAD_ROWS}`), valueRenderOption: "FORMATTED_VALUE" },
      { timeout: 60_000 },
    ),
  );
  const headValues = heads.data.valueRanges ?? [];
  const wanted = tabs.filter((t, i) => findApplicationColumns((headValues[i]?.values ?? []) as unknown[][], t.title) !== null);
  if (!wanted.length) return [];
  await pace();
  const res = await withSheetsRetry(() =>
    client.spreadsheets.values.batchGet(
      {
        spreadsheetId,
        ranges: wanted.map((t) => `${q(t.title)}!A1:${width(t)}${Math.min(Math.max(t.rowCount, 1), MAX_DATA_ROWS + HEAD_ROWS)}`),
        valueRenderOption: "FORMATTED_VALUE",
      },
      { timeout: 120_000 },
    ),
  );
  const values = res.data.valueRanges ?? [];
  return wanted.map((info, i) => ({ info, rows: (values[i]?.values ?? []) as unknown[][] }));
}

/** The sheet's Drive modifiedTime as the team account sees it. */
async function teamDriveCheck(fileId: string): Promise<DriveCheck> {
  try {
    const res = await withTeam((auth) =>
      withSheetsRetry(() => google.drive({ version: "v3", auth }).files.get({ fileId, fields: "modifiedTime,createdTime,trashed,mimeType", supportsAllDrives: true }, { timeout: 15_000 })),
    );
    if (res.data.trashed) return { ok: false, noAccess: true, error: "The internal sheet is in the Drive trash." };
    if (res.data.mimeType && res.data.mimeType !== "application/vnd.google-apps.spreadsheet") {
      return { ok: false, noAccess: true, error: "The internal sheet link opens a file that isn't a Google Sheet." };
    }
    const at = (v?: string | null) => (v && Number.isFinite(Date.parse(v)) ? new Date(v) : null);
    return { ok: true, modifiedAt: at(res.data.modifiedTime), createdAt: at(res.data.createdTime) };
  } catch (err) {
    if (isNoAccess(err)) return { ok: false, noAccess: true, error: NO_ACCESS };
    return { ok: false, noAccess: false, error: short(err) };
  }
}

interface InternalState {
  sheet_id: string;
  drive_modified_at: Date | null;
  last_read_at: Date | null;
  last_tried_at: Date | null;
  read_error: string | null;
  read_via: "service_account" | "team" | null;
}

export interface ApplicationsSyncResult {
  sheetsChecked: number;
  sheetsRead: number;
  rowsMatched: number;
  errors: number;
}

/** Writes one internal sheet's read in one transaction. Exported for tests. */
export async function writeApplications(sheetId: string, built: BuiltApplications, modifiedAt: Date | null, via: "service_account" | "team" = "service_account"): Promise<number> {
  return transaction(async (tx) => {
    const apps = built.applications;
    let written = 0;
    for (let i = 0; i < apps.length; i += 400) {
      const c = apps.slice(i, i + 400);
      const res = await tx.query(
        `insert into app.job_applications (sheet_id, tab, tab_gid, uid, job_id, phone, source, applied_at, resume_url)
         select $1, t, gid, u, j, ph, src, at, ru
           from unnest($2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::timestamptz[], $9::text[])
             as x(t, gid, u, j, ph, src, at, ru)
          where exists (select 1 from app.pool_candidates p where p.uid = x.u)
         on conflict (sheet_id, uid, job_id) do update set
           tab = excluded.tab, tab_gid = excluded.tab_gid, phone = excluded.phone, source = excluded.source,
           applied_at = excluded.applied_at, resume_url = excluded.resume_url, last_seen_at = now(), removed_at = null`,
        [
          sheetId,
          c.map((a) => a.tab),
          c.map((a) => a.gid),
          c.map((a) => a.uid),
          c.map((a) => a.jobId.slice(0, 80)),
          c.map((a) => a.phone),
          c.map((a) => a.source),
          c.map((a) => (a.appliedAt === null ? null : new Date(a.appliedAt))),
          c.map((a) => a.resumeUrl),
        ],
      );
      written += res.rowCount ?? 0;
    }
    // Applications no longer in the sheet are kept as removed (an export replaced by a smaller one),
    // unless the read looks broken: fewer than half of the stored rows (a renamed header, a tab moved).
    const [{ n }] = (await tx.query<{ n: number }>("select count(*)::int as n from app.job_applications where sheet_id = $1 and removed_at is null", [sheetId])).rows;
    if (n > 5 && apps.length * 2 < n) {
      console.warn(`[applications] ${sheetId.slice(0, 8)}…: this read has ${apps.length} applications against ${n} stored; none marked removed`);
    } else {
      await tx.query(
        `update app.job_applications set removed_at = now()
          where sheet_id = $1 and removed_at is null
            and not ((uid, job_id) in (select * from unnest($2::text[], $3::text[])))`,
        [sheetId, apps.map((a) => a.uid), apps.map((a) => a.jobId.slice(0, 80))],
      );
    }
    await tx.query(
      `update app.internal_sheets set drive_modified_at = coalesce($2, drive_modified_at), last_read_at = now(), last_tried_at = now(),
              read_error = null, tabs_read = $3, academy_rows = $4, read_via = $5, updated_at = now() where sheet_id = $1`,
      [sheetId, modifiedAt, built.tabsRead, built.academyRows, via],
    );
    return written;
  });
}

/**
 * Reads the internal sheets that are due (see the module comment). Never throws: a sheet's failure
 * is recorded on it; a failure of the whole step is logged and reported as one error.
 */
export async function syncApplications(input: {
  requirements: MasterRequirement[];
  pool: PoolLookup;
  pace: () => Promise<void>;
  driveCheck: (fileId: string) => Promise<DriveCheck>;
  /** Read again even when unchanged (the reading rules changed). */
  rulesAt: Date | null;
}): Promise<ApplicationsSyncResult> {
  const out: ApplicationsSyncResult = { sheetsChecked: 0, sheetsRead: 0, rowsMatched: 0, errors: 0 };
  try {
    const sheets = internalSheetsOf(input.requirements);
    if (!sheets.length) return out;
    await query(
      `insert into app.internal_sheets (sheet_id, company, job_ids, listed_at)
       select x.sheet_id, x.company, array(select jsonb_array_elements_text(x.job_ids)), now()
         from jsonb_to_recordset($1::jsonb) as x(sheet_id text, company text, job_ids jsonb)
       on conflict (sheet_id) do update set company = excluded.company, job_ids = excluded.job_ids, listed_at = now(),
         updated_at = case when (app.internal_sheets.company, app.internal_sheets.job_ids) is distinct from (excluded.company, excluded.job_ids)
                           then now() else app.internal_sheets.updated_at end`,
      [JSON.stringify(sheets.map((s) => ({ sheet_id: s.sheetId, company: s.company.slice(0, 200), job_ids: s.jobIds })))],
    );
    const states = new Map(
      (
        await query<InternalState>("select sheet_id, drive_modified_at, last_read_at, last_tried_at, read_error, read_via from app.internal_sheets where sheet_id = any($1::text[])", [
          sheets.map((s) => s.sheetId),
        ])
      ).map((s) => [s.sheet_id, s]),
    );
    const now = Date.now();
    const team = await teamStatus()
      .then((t) => t.connected)
      .catch(() => false);
    const plan: { sheet: (typeof sheets)[number]; modifiedAt: Date | null; priority: number; tried: number; via: "service_account" | "team" }[] = [];
    const noAccess: { id: string; error: string }[] = [];
    for (const sheet of sheets) {
      const st = states.get(sheet.sheetId);
      const stale = !st?.last_read_at || now - st.last_read_at.getTime() >= STALE_MS;
      const triedRecently = st?.last_tried_at ? now - st.last_tried_at.getTime() < STALE_MS : false;
      // Drive's modifiedTime is the only way to know the sheet changed: one cheap call per sheet.
      // A sheet last read as the team account is checked as the team account straight away.
      let via: "service_account" | "team" = "service_account";
      let meta: DriveCheck = st?.read_via === "team" && team ? { ok: false, noAccess: true, error: NO_ACCESS } : await input.driveCheck(sheet.sheetId);
      if (!meta.ok && meta.noAccess && team) {
        const viaTeam = await teamDriveCheck(sheet.sheetId);
        if (viaTeam.ok) {
          meta = viaTeam;
          via = "team";
        } else meta = viaTeam.noAccess ? { ok: false, noAccess: true, error: NO_ACCESS } : viaTeam;
      }
      out.sheetsChecked++;
      await sleep(80);
      if (!meta.ok && meta.noAccess && (triedRecently || !stale)) {
        noAccess.push({ id: sheet.sheetId, error: meta.error.includes("internal sheet") ? meta.error : NO_ACCESS });
        continue;
      }
      let priority = -1;
      if (!st?.last_read_at) priority = 0;
      else if (meta.ok && meta.modifiedAt && (!st.drive_modified_at || meta.modifiedAt.getTime() > st.drive_modified_at.getTime())) priority = 1;
      else if (input.rulesAt && st.last_read_at.getTime() < input.rulesAt.getTime()) priority = 1;
      else if (stale) priority = 2;
      if (priority < 0) continue;
      if (st?.read_error && st.last_tried_at && now - st.last_tried_at.getTime() < RETRY_FAILED_MS && priority !== 1) continue;
      plan.push({ sheet, modifiedAt: meta.ok ? meta.modifiedAt : null, priority, tried: st?.last_tried_at?.getTime() ?? 0, via });
    }
    if (noAccess.length) {
      out.errors += noAccess.length;
      await query(
        "update app.internal_sheets s set read_error = x.e from unnest($1::text[], $2::text[]) as x(id, e) where s.sheet_id = x.id and s.read_error is distinct from x.e",
        [noAccess.map((n) => n.id), noAccess.map((n) => n.error)],
      );
    }
    plan.sort((a, b) => a.priority - b.priority || a.tried - b.tried);
    for (const { sheet, modifiedAt, via } of plan.slice(0, MAX_INTERNAL_PER_RUN)) {
      try {
        const tabs =
          via === "team"
            ? await withTeam((auth) => readInternalSheet(sheet.sheetId, input.pace, google.sheets({ version: "v4", auth })))
            : await readInternalSheet(sheet.sheetId, input.pace);
        const built = buildApplications(sheet, tabs, input.pool);
        await writeApplications(sheet.sheetId, built, modifiedAt, via);
        out.sheetsRead++;
        out.rowsMatched += built.academyRows;
      } catch (err) {
        out.errors++;
        const message = isNoAccess(err) ? NO_ACCESS : `Couldn't read the internal sheet: ${short(err)}`;
        await query("update app.internal_sheets set read_error = $2, last_tried_at = now() where sheet_id = $1", [sheet.sheetId, message.slice(0, 500)]).catch(() => undefined);
      }
    }
    if (out.sheetsRead || out.errors) console.log(`[applications] ${out.sheetsChecked} internal sheets checked, ${out.sheetsRead} read, ${out.rowsMatched} Academy rows, ${out.errors} unreadable`);
    return out;
  } catch (err) {
    console.warn("[applications] sync step failed:", short(err));
    return { ...out, errors: out.errors + 1 };
  }
}

/** When the internal sheets were last read successfully (null: never, or no migration 023). */
export async function lastApplicationsRead(): Promise<Date | null> {
  try {
    const rows = await query<{ at: Date | null }>("select max(last_read_at) as at from app.internal_sheets");
    return rows[0]?.at ?? null;
  } catch {
    return null;
  }
}
