import "server-only";
import { google, type drive_v3 } from "googleapis";
import { query, transaction } from "@/lib/db/client";
import { env } from "@/lib/env";
import { UserError } from "@/lib/mobile/http";
import { refreshHubspotDeals } from "@/lib/hubspot/deals";
import { notifyShareEvents, type ShareNotice } from "@/lib/mobile/pool/notify";
import { academySchemaReady, companiesSchemaReady, hasRunBefore } from "@/lib/mobile/pool/schema";
import {
  baselineSharedAt,
  buildShares,
  type BuiltSheet,
  diffShares,
  inferCrpYear,
  isApplicationsTab,
  type MasterParse,
  type MasterRequirement,
  type MasterSheet,
  MAX_ROWS_PER_TAB,
  normHead,
  parseCrpMonth,
  parseCrpsMaster,
  pickTabs,
  type PoolIndex,
  poolIndex,
  roundsOf,
  type ShareOutcome,
  type SheetTab,
  sheetUrl,
  statusChangeText,
  type StoredShare,
  type TabInfo,
} from "@/lib/mobile/pool/shares";
import { getSheets, withSheetsRetry } from "@/lib/sheets";

/**
 * The hourly sync of Academy candidates' company shares (PSM 1.10.0). Read-only on every sheet.
 *
 *  1. Reads the master ">8 LPA Companies" sheet's CRPs tab (columns by name).
 *  2. For each distinct company sheet, asks Drive for its modifiedTime; the sheet is read again only
 *     when it changed since the last read, when it was never read, or when the last read is older
 *     than 24 h. At most MAX_SHEETS_PER_RUN sheets per run (never read first, then changed, then
 *     stale); the rest wait for the next hour.
 *  3. Reads a sheet with one spreadsheets.get (tabs, hidden flags) and one values.batchGet, paced
 *     at SHEETS_PER_MINUTE with withSheetsRetry. A sheet that can't be read gets read_error and the
 *     run carries on.
 *  4. Keeps only rows matched to the Academy assessed pool (phone, then email); upserts them into
 *     app.company_shares, marks the ones that left as removed, and turns what changed into pushes
 *     (notify.ts). A sheet's first read is a baseline: recorded, never pushed.
 * Single-flight: one run per process, and a lease row in app.company_share_syncs across processes.
 */

export const SHARES_EVERY_MS = 60 * 60_000;
export const SHARES_RETRY_AFTER_FAILURE_MS = 15 * 60_000;
export const SHARES_MANUAL_MIN_MS = 5 * 60_000;
const STALE_MS = 24 * 3_600_000;
// A run takes 2–10 minutes (100 sheets at 40 reads a minute, then HubSpot). A run cut off by a restart or a
// deploy keeps its "running" row; after this long the next run takes over and marks it interrupted.
const LEASE_MS = 20 * 60_000;
export const MAX_SHEETS_PER_RUN = 100;
export const SHEETS_PER_MINUTE = 40;
const MAX_TABS = 40;
const MAX_COLUMNS = 104; // CZ
const LOCK = 74_210_020;

const MASTER_ID = "1y1FgqMNvSFR8f3HRHlb4RYP1rDIDfRTYN5GwD6IXg7U";

/**
 * The version of the reading rules (round columns, statuses). When it changes, every sheet is read
 * again once, silently: rows that look different only because the rules changed send no pushes.
 */
export const SHARE_RULES_VERSION = "2026-11-27.status";

/** The master sheet and tab (ACADEMY_CRP_SHEET / ACADEMY_CRP_TAB override them). */
export function crpMaster(): { spreadsheetId: string; tab: string } {
  return { spreadsheetId: process.env.ACADEMY_CRP_SHEET?.trim() || MASTER_ID, tab: process.env.ACADEMY_CRP_TAB?.trim() || "CRPs" };
}

const short = (err: unknown) => (err instanceof Error ? err.message.replace(/\s+/g, " ").slice(0, 300) : String(err).slice(0, 300));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

/** A pacer: each call waits so that calls are at most [perMinute] a minute. */
export function pacer(perMinute: number): () => Promise<void> {
  let next = 0;
  const gap = 60_000 / perMinute;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + gap;
    if (wait) await sleep(wait);
  };
}

/** 1 → A, 27 → AA, 104 → CZ. */
export function columnName(n: number): string {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

const g = globalThis as unknown as { __sharesDrive?: drive_v3.Drive; __sharesRun?: Promise<SharesSyncResult>; __sharesCheckedAt?: number };

function drive(): drive_v3.Drive {
  g.__sharesDrive ??= google.drive({
    version: "v3",
    auth: new google.auth.JWT({ email: env.gcp.clientEmail, key: env.gcp.privateKey, scopes: ["https://www.googleapis.com/auth/drive.readonly"] }),
  });
  return g.__sharesDrive;
}

// ── Reading (no writes anywhere) ────────────────────────────────────────────

export async function readCrpMaster(pace: () => Promise<void>): Promise<MasterParse> {
  const { spreadsheetId, tab } = crpMaster();
  await pace();
  const res = await withSheetsRetry(() =>
    getSheets().spreadsheets.values.get(
      { spreadsheetId, range: `${q(tab)}!A1:BZ${MAX_ROWS_PER_TAB + 1}`, valueRenderOption: "FORMATTED_VALUE" },
      { timeout: 60_000 },
    ),
  );
  const rows = (res.data.values ?? []) as unknown[][];
  return parseCrpsMaster(rows, await readJdLinks(spreadsheetId, tab, rows, pace));
}

/**
 * The JD column's hyperlinks (a cell can show a file name that links to the JD), by row index.
 * Best effort: on any error the JD column's text links are used alone.
 */
async function readJdLinks(spreadsheetId: string, tab: string, rows: unknown[][], pace: () => Promise<void>): Promise<(string | null)[]> {
  const head = (rows[0] ?? []).map(normHead);
  const at = head.findIndex((h) => ["jd", "jd link", "job description", "job description link"].includes(h));
  if (at < 0 || rows.length < 2) return [];
  const col = columnName(at + 1);
  try {
    await pace();
    const res = await withSheetsRetry(() =>
      getSheets().spreadsheets.get(
        {
          spreadsheetId,
          ranges: [`${q(tab)}!${col}1:${col}${Math.min(rows.length, MAX_ROWS_PER_TAB + 1)}`],
          includeGridData: true,
          fields: "sheets.data.rowData.values(hyperlink,textFormatRuns.format.link.uri,chipRuns.chip.richLinkProperties.uri)",
        },
        { timeout: 60_000 },
      ),
    );
    const data = res.data.sheets?.[0]?.data?.[0]?.rowData ?? [];
    return data.map((r) => {
      const v = r.values?.[0];
      if (!v) return null;
      const run = v.textFormatRuns?.find((t) => t.format?.link?.uri)?.format?.link?.uri;
      // chipRuns (smart chips) isn't in this googleapis version's types.
      const chips = (v as { chipRuns?: { chip?: { richLinkProperties?: { uri?: string | null } } }[] }).chipRuns;
      const chip = chips?.find((c) => c.chip?.richLinkProperties?.uri)?.chip?.richLinkProperties?.uri;
      return v.hyperlink ?? run ?? chip ?? null;
    });
  } catch (err) {
    console.warn("[shares] JD links not read (text links only):", short(err));
    return [];
  }
}

export type DriveMeta =
  | { ok: true; modifiedAt: Date | null; createdAt: Date | null }
  | { ok: false; noAccess: boolean; error: string };

const NO_ACCESS = "The service account can't open this sheet: share it (Viewer) with the service account.";

/** A 404, or a 403 that isn't a rate limit (Drive answers 403 for "rate limit exceeded" too). */
function isNoAccess(err: unknown): boolean {
  const e = err as { code?: number | string; status?: number };
  const code = Number(e?.code ?? e?.status);
  return code === 404 || (code === 403 && !/rate ?limit|quota/i.test(short(err)));
}

/** The sheet's Drive modifiedTime / createdTime. A 403 / 404 means the service account has no access. */
export async function driveMeta(fileId: string): Promise<DriveMeta> {
  try {
    const res = await withSheetsRetry(() =>
      drive().files.get({ fileId, fields: "modifiedTime,createdTime,trashed,mimeType", supportsAllDrives: true }, { timeout: 15_000 }),
    );
    if (res.data.trashed) return { ok: false, noAccess: true, error: "The sheet is in the Drive trash." };
    if (res.data.mimeType && res.data.mimeType !== "application/vnd.google-apps.spreadsheet") {
      return { ok: false, noAccess: true, error: "The link opens a file that isn't a Google Sheet (an uploaded Excel file?). Save it as a Google Sheet." };
    }
    const at = (v?: string | null) => (v && Number.isFinite(Date.parse(v)) ? new Date(v) : null);
    return { ok: true, modifiedAt: at(res.data.modifiedTime), createdAt: at(res.data.createdTime) };
  } catch (err) {
    if (isNoAccess(err)) return { ok: false, noAccess: true, error: NO_ACCESS };
    return { ok: false, noAccess: false, error: short(err) };
  }
}

/** One company sheet: its tabs (one spreadsheets.get) and the candidate tabs' cells (one values.batchGet). */
export async function readSheet(spreadsheetId: string, pace: () => Promise<void>): Promise<SheetTab[]> {
  await pace();
  const meta = await withSheetsRetry(() =>
    getSheets().spreadsheets.get(
      { spreadsheetId, fields: "sheets.properties(sheetId,title,hidden,sheetType,gridProperties(rowCount,columnCount))" },
      { timeout: 60_000 },
    ),
  );
  const tabs: TabInfo[] = (meta.data.sheets ?? [])
    .map((s) => s.properties ?? {})
    .filter((p) => p.title && (p.sheetType ?? "GRID") === "GRID")
    .map((p) => ({
      title: p.title!,
      gid: p.sheetId ?? -1,
      hidden: Boolean(p.hidden),
      rowCount: p.gridProperties?.rowCount ?? 1000,
      columnCount: p.gridProperties?.columnCount ?? 26,
    }));
  const picked = pickTabs(tabs).slice(0, MAX_TABS);
  if (!picked.length) return [];
  const ranges = picked.map((t) => `${q(t.title)}!A1:${columnName(Math.min(Math.max(t.columnCount, 1), MAX_COLUMNS))}${Math.min(Math.max(t.rowCount, 1), MAX_ROWS_PER_TAB + 6)}`);
  await pace();
  const res = await withSheetsRetry(() =>
    getSheets().spreadsheets.values.batchGet({ spreadsheetId, ranges, valueRenderOption: "FORMATTED_VALUE" }, { timeout: 120_000 }),
  );
  const values = res.data.valueRanges ?? [];
  return picked.map((info, i) => ({ info, rows: (values[i]?.values ?? []) as unknown[][] }));
}

// ── The run ─────────────────────────────────────────────────────────────────

export interface SharesSyncResult {
  status: "succeeded" | "failed" | "skipped" | "running";
  sheetsChecked: number;
  sheetsRead: number;
  rowsMatched: number;
  changes: number;
  errors: number;
  pushed: number;
  error?: string;
}

const emptyResult = (status: SharesSyncResult["status"], error?: string): SharesSyncResult => ({
  status,
  sheetsChecked: 0,
  sheetsRead: 0,
  rowsMatched: 0,
  changes: 0,
  errors: 0,
  pushed: 0,
  ...(error ? { error } : {}),
});

/** Runs a sync now unless one is running (single-flight). */
export function syncShares(by: string): Promise<SharesSyncResult> {
  if (g.__sharesRun) return g.__sharesRun.then(() => emptyResult("running"));
  const run = runSync(by).finally(() => {
    g.__sharesRun = undefined;
  });
  g.__sharesRun = run;
  return run;
}

interface SheetState {
  sheet_id: string;
  drive_modified_at: Date | null;
  last_read_at: Date | null;
  last_tried_at: Date | null;
  read_error: string | null;
}

async function runSync(by: string): Promise<SharesSyncResult> {
  if (!(await academySchemaReady())) return emptyResult("skipped", "Migration 020 isn't applied.");
  // The pool must hold every assessed row (the first 1.10.0 pool sync) before shares are matched,
  // or a sheet's baseline would miss the unassigned candidates.
  if (!(await hasRunBefore("pool:assigned"))) return emptyResult("skipped", "Waiting for the first Academy pool sync.");
  const lease = await transaction(async (tx) => {
    const lock = await tx.query<{ ok: boolean }>("select pg_try_advisory_xact_lock($1) as ok", [LOCK]);
    if (!lock.rows[0]?.ok) return null;
    const busy = await tx.query("select 1 from app.company_share_syncs where status = 'running' and started_at > now() - $1::interval limit 1", [`${LEASE_MS / 1000} seconds`]);
    if (busy.rows.length) return null;
    await tx.query("update app.company_share_syncs set status = 'failed', finished_at = now(), error = coalesce(error, 'Interrupted (server restart).') where status = 'running'");
    const r = await tx.query<{ id: string; started_at: Date }>("insert into app.company_share_syncs (triggered_by) values ($1) returning id::text as id, started_at", [by.slice(0, 120)]);
    return r.rows[0];
  });
  if (!lease) return emptyResult("running");

  const out = emptyResult("succeeded");
  const notices: ShareNotice[] = [];
  const finish = (status: "succeeded" | "failed", error?: string) =>
    query(
      `update app.company_share_syncs set status = $2, finished_at = now(), sheets_checked = $3, sheets_read = $4, rows_matched = $5, changes = $6, errors = $7, pushed = $8, error = $9
        where id = $1`,
      [lease.id, status, out.sheetsChecked, out.sheetsRead, out.rowsMatched, out.changes, out.errors, out.pushed, error?.slice(0, 500) ?? null],
    );
  try {
    const pace = pacer(SHEETS_PER_MINUTE);
    const master = await readCrpMaster(pace);
    if (!master.sheets.length) throw new Error("The CRPs tab lists no company sheets; nothing was changed.");
    await saveMaster(master.sheets);
    const companies = await companiesSchemaReady().catch(() => false);
    if (companies) {
      await saveRequirements(master.requirements).catch((err) => console.warn("[shares] requirements not saved:", short(err)));
    }
    // When the reading rules change, every sheet is read again once (silently, see SHARE_RULES_VERSION).
    const rulesAt = companies ? await rulesChangedAt().catch(() => null) : null;

    const people = await query<{ uid: string; phone: string | null; email: string | null }>("select uid, phone, email from app.pool_candidates where removed_at is null");
    if (people.length < 10) throw new Error("The Academy pool has fewer than 10 candidates; the shares were left as they are.");
    const idx = poolIndex(people);

    const states = new Map(
      (
        await query<SheetState>("select sheet_id, drive_modified_at, last_read_at, last_tried_at, read_error from app.company_sheets where sheet_id = any($1::text[])", [
          master.sheets.map((s) => s.sheetId),
        ])
      ).map((s) => [s.sheet_id, s]),
    );

    // Which sheets to read: never read, changed in Drive, or read more than 24 h ago.
    const now = Date.now();
    const plan: { sheet: MasterSheet; meta: DriveMeta; priority: number; tried: number }[] = [];
    const noAccess: { id: string; error: string }[] = [];
    for (const sheet of master.sheets) {
      const st = states.get(sheet.sheetId);
      const meta = await driveMeta(sheet.sheetId);
      out.sheetsChecked++;
      await sleep(100);
      const triedRecently = st?.last_tried_at ? now - st.last_tried_at.getTime() < STALE_MS : false;
      const stale = !st?.last_read_at || now - st.last_read_at.getTime() >= STALE_MS;
      if (!meta.ok && meta.noAccess) {
        // Drive says no: try the Sheets read once a day (it can differ for link-shared files).
        if (triedRecently || !stale) {
          noAccess.push({ id: sheet.sheetId, error: meta.error });
          continue;
        }
      }
      let priority = -1;
      if (!st?.last_read_at) priority = 0;
      else if (meta.ok && meta.modifiedAt && (!st.drive_modified_at || meta.modifiedAt.getTime() > st.drive_modified_at.getTime())) priority = 1;
      else if (rulesAt && st.last_read_at.getTime() < rulesAt.getTime()) priority = 1;
      else if (stale) priority = 2;
      if (priority < 0) continue;
      // A sheet that failed less than an hour ago and didn't change waits.
      if (st?.read_error && st.last_tried_at && now - st.last_tried_at.getTime() < SHARES_EVERY_MS && priority !== 1) continue;
      plan.push({ sheet, meta, priority, tried: st?.last_tried_at?.getTime() ?? 0 });
    }
    if (noAccess.length) {
      out.errors += noAccess.length;
      await query(
        "update app.company_sheets s set read_error = x.e from unnest($1::text[], $2::text[]) as x(id, e) where s.sheet_id = x.id and s.read_error is distinct from x.e",
        [noAccess.map((n) => n.id), noAccess.map((n) => n.error)],
      );
    }
    plan.sort((a, b) => a.priority - b.priority || a.tried - b.tried);

    for (const { sheet, meta } of plan.slice(0, MAX_SHEETS_PER_RUN)) {
      const st = states.get(sheet.sheetId);
      try {
        const tabs = await readSheet(sheet.sheetId, pace);
        const built = buildShares(sheet, tabs, idx);
        const written = await writeSheet(sheet, built, {
          baseline: !st?.last_read_at,
          silent: Boolean(rulesAt && st?.last_read_at && st.last_read_at.getTime() < rulesAt.getTime()),
          modifiedAt: meta.ok ? meta.modifiedAt : null,
          createdAt: meta.ok ? meta.createdAt : null,
          withStatus: companies,
        });
        out.sheetsRead++;
        out.rowsMatched += built.academyRows;
        out.changes += written.changes;
        notices.push(...written.notices);
      } catch (err) {
        out.errors++;
        const message = isNoAccess(err) ? NO_ACCESS : `Couldn't read the sheet: ${short(err)}`;
        await query("update app.company_sheets set read_error = $2, last_tried_at = now() where sheet_id = $1", [sheet.sheetId, message.slice(0, 500)]).catch(() => undefined);
      }
    }

    out.pushed = await notifyShareEvents(notices, lease.started_at.toISOString()).catch((err) => {
      console.warn("[shares] pushes failed:", short(err));
      return 0;
    });
    // HubSpot (GET only): the JD link / Nurturing Team Remarks of each requirement's deal. Never fails the run.
    // Newest requirements first (the master grows downwards), so this month's deals are read first.
    if (companies) await refreshHubspotDeals([...master.requirements].reverse().map((r) => r.hubspotDealId ?? "").filter(Boolean));
    await finish("succeeded");
    if (out.sheetsRead || out.changes || out.errors) {
      console.log(`[shares] ${out.sheetsChecked} sheets checked, ${out.sheetsRead} read, ${out.rowsMatched} Academy rows, ${out.changes} changes, ${out.errors} unreadable, ${out.pushed} pushes`);
    }
    return out;
  } catch (err) {
    const message = short(err);
    console.warn("[shares] sync failed:", message);
    await finish("failed", message).catch(() => undefined);
    return { ...out, status: "failed", error: message };
  }
}

/** The master's facts for every listed sheet (new sheets are added unread). Exported for tests. */
export async function saveMaster(sheets: MasterSheet[]): Promise<void> {
  await query(
    `insert into app.company_sheets (sheet_id, company, roles, job_ids, crp_months, ise, crm, master_final_status, master_stage, listed_at)
     select x.sheet_id, x.company,
            array(select jsonb_array_elements_text(x.roles)), array(select jsonb_array_elements_text(x.job_ids)), array(select jsonb_array_elements_text(x.crp_months)),
            x.ise, x.crm, x.master_final_status, x.master_stage, now()
       from jsonb_to_recordset($1::jsonb) as x(sheet_id text, company text, roles jsonb, job_ids jsonb, crp_months jsonb, ise text, crm text, master_final_status text, master_stage text)
     on conflict (sheet_id) do update set
       company = excluded.company, roles = excluded.roles, job_ids = excluded.job_ids, crp_months = excluded.crp_months, ise = excluded.ise, crm = excluded.crm,
       master_final_status = excluded.master_final_status, master_stage = excluded.master_stage, listed_at = now(),
       updated_at = case when (app.company_sheets.company, app.company_sheets.roles, app.company_sheets.job_ids, app.company_sheets.crp_months, app.company_sheets.ise,
                               app.company_sheets.crm, app.company_sheets.master_final_status, app.company_sheets.master_stage)
                          is distinct from (excluded.company, excluded.roles, excluded.job_ids, excluded.crp_months, excluded.ise, excluded.crm, excluded.master_final_status, excluded.master_stage)
                         then now() else app.company_sheets.updated_at end`,
    [
      JSON.stringify(
        sheets.map((s) => ({
          sheet_id: s.sheetId,
          company: s.company,
          roles: s.roles,
          job_ids: s.jobIds,
          crp_months: s.crpMonths,
          ise: s.ise,
          crm: s.crm,
          master_final_status: s.masterFinalStatus,
          master_stage: s.masterStage,
        })),
      ),
    ],
  );
}

/** When the current reading rules were first used (recorded on the first run under them). */
async function rulesChangedAt(): Promise<Date | null> {
  const name = `shares:rules:${SHARE_RULES_VERSION}`.slice(0, 80);
  await query("insert into app.sync_marks (name) values ($1) on conflict (name) do nothing", [name]);
  const [row] = await query<{ at: Date }>("select at from app.sync_marks where name = $1", [name]);
  return row?.at ?? null;
}

/**
 * The master's requirement rows (migration 022). A month's year is fixed the first time the row is
 * seen with that month text (a CRP "Nov" stays Nov 2026 years later). Rows no longer in the master
 * are deleted, unless the read looks broken (fewer than half the rows stored).
 */
export async function saveRequirements(reqs: MasterRequirement[], now = new Date()): Promise<void> {
  if (!reqs.length) return;
  const year = (r: MasterRequirement) => {
    const m = parseCrpMonth(r.crpMonth);
    if (!m) return null;
    const y = m.year ?? inferCrpYear(m.month, now);
    return y >= 2020 && y <= 2100 ? y : null;
  };
  const rows = reqs.map((r) => ({
    key: r.key,
    row_index: r.row,
    sheet_id: r.sheetId,
    company: r.company.slice(0, 200) || "Company",
    role: r.role.slice(0, 200),
    job_id: r.jobId.slice(0, 80),
    job_type: r.jobType.slice(0, 80),
    crp_month: r.crpMonth.slice(0, 40),
    crp_year: year(r),
    crp_week: r.crpWeek,
    openings: r.openings,
    ctc_text: r.ctcText.slice(0, 80),
    final_status: r.finalStatus.slice(0, 200),
    stage: r.stage.slice(0, 200),
    id_status: r.idStatus.slice(0, 200),
    academy_sent: r.academySent,
    assessed_sent: r.assessedSent,
    non_assessed_sent: r.nonAssessedSent,
    requested: r.requested.slice(0, 200),
    tech_stack: r.techStack.slice(0, 200),
    pass_out: r.passOut.slice(0, 80),
    interview_process: r.interviewProcess.slice(0, 200),
    ise: r.ise.slice(0, 80),
    crm: r.crm.slice(0, 80),
    jd_url: r.jdUrl && r.jdUrl.length <= 2000 ? r.jdUrl : null,
    hubspot_url: r.hubspotUrl && r.hubspotUrl.length <= 2000 ? r.hubspotUrl : null,
    hubspot_deal_id: r.hubspotDealId,
  }));
  await transaction(async (tx) => {
    const cols = Object.keys(rows[0]);
    const types: Record<string, string> = { row_index: "integer", crp_year: "integer", crp_week: "integer", openings: "integer", academy_sent: "integer", assessed_sent: "integer", non_assessed_sent: "integer" };
    await tx.query(
      `insert into app.crp_requirements (${cols.join(", ")})
       select ${cols.join(", ")} from jsonb_to_recordset($1::jsonb) as x(${cols.map((c) => `${c} ${types[c] ?? "text"}`).join(", ")})
       on conflict (key) do update set
         ${cols
           .filter((c) => c !== "key" && c !== "crp_year")
           .map((c) => `${c} = excluded.${c}`)
           .join(", ")},
         crp_year = case when app.crp_requirements.crp_month = excluded.crp_month and app.crp_requirements.crp_year is not null
                         then app.crp_requirements.crp_year else excluded.crp_year end,
         listed_at = now(),
         updated_at = case when (${cols.filter((c) => c !== "key" && c !== "crp_year").map((c) => `app.crp_requirements.${c}`).join(", ")})
                                is distinct from (${cols.filter((c) => c !== "key" && c !== "crp_year").map((c) => `excluded.${c}`).join(", ")})
                           then now() else app.crp_requirements.updated_at end`,
      [JSON.stringify(rows)],
    );
    const [{ n }] = (await tx.query<{ n: number }>("select count(*)::int as n from app.crp_requirements")).rows;
    if (rows.length * 2 < n) {
      console.warn(`[shares] the CRPs read has ${rows.length} requirements against ${n} stored: nothing deleted`);
      return;
    }
    await tx.query("delete from app.crp_requirements where not (key = any($1::text[]))", [rows.map((r) => r.key)]);
  });
}

interface StoredRow {
  id: string;
  tab: string;
  uid: string;
  rounds: unknown;
  final_status: string;
  outcome: ShareOutcome;
  hash: string;
  first_seen_at: Date;
  changed_at: Date;
  outcome_at: Date | null;
  baseline: boolean;
  removed_at: Date | null;
}

/** Writes one sheet's read in one transaction; returns the changes and what to push. Exported for tests. */
export async function writeSheet(
  sheet: MasterSheet,
  built: BuiltSheet,
  opts: {
    baseline: boolean;
    /** Read again because the reading rules changed: recorded without pushes, times kept. */
    silent?: boolean;
    modifiedAt: Date | null;
    createdAt: Date | null;
    /** Migration 022 is applied: store each row's status. */
    withStatus?: boolean;
  },
): Promise<{ changes: number; notices: ShareNotice[] }> {
  return transaction(async (tx) => {
    const prev = await tx.query<StoredRow>(
      `select id::text as id, tab, uid, rounds, final_status, outcome, hash, first_seen_at, changed_at, outcome_at, baseline, removed_at
         from app.company_shares where sheet_id = $1`,
      [sheet.sheetId],
    );
    const byId = new Map(prev.rows.map((r) => [r.id, r]));
    const stored: StoredShare[] = prev.rows.map((r) => ({
      id: r.id,
      tab: r.tab,
      uid: r.uid,
      rounds: roundsOf(r.rounds),
      finalStatus: r.final_status,
      outcome: r.outcome,
      hash: r.hash,
      firstSeenAt: r.first_seen_at.getTime(),
      changedAt: r.changed_at.getTime(),
      removed: r.removed_at !== null,
    }));
    const quiet = opts.baseline || Boolean(opts.silent);
    const diff = diffShares(stored, built.shares, quiet);
    const now = Date.now();
    const rows = diff.writes.map((w) => {
      const from = w.from ? byId.get(w.from.id) ?? null : null;
      const firstSeen = from ? from.first_seen_at.getTime() : quiet ? baselineSharedAt(w.resumeAt, opts.createdAt?.getTime() ?? null, now) : now;
      return {
        ...w,
        firstSeen: new Date(firstSeen),
        changedAt: from ? (w.changed && !opts.silent ? new Date(now) : from.changed_at) : new Date(firstSeen),
        outcomeAt: from ? (w.outcomeChanged && !opts.silent ? new Date(now) : from.outcome_at) : quiet ? null : new Date(now),
        baseline: from ? from.baseline : quiet,
      };
    });
    const ids = new Map<string, string>();
    for (let i = 0; i < rows.length; i += 300) {
      const c = rows.slice(i, i + 300);
      const ws = Boolean(opts.withStatus);
      const res = await tx.query<{ id: string; tab: string; uid: string }>(
        `insert into app.company_shares (sheet_id, tab, tab_gid, uid, phone, company, role, rounds, final_status, stage, outcome, hash, first_seen_at, changed_at, outcome_at, baseline${ws ? ", status" : ""})
         select $1, t, gid, u, ph, co, ro, rd::jsonb, fs, st, oc, h, f, ca, oa, b${ws ? ", ss" : ""}
           from unnest($2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[],
                       $13::timestamptz[], $14::timestamptz[], $15::timestamptz[], $16::boolean[]${ws ? ", $17::text[]" : ""})
             as x(t, gid, u, ph, co, ro, rd, fs, st, oc, h, f, ca, oa, b${ws ? ", ss" : ""})
         on conflict (sheet_id, tab, uid) do update set
           tab_gid = excluded.tab_gid, phone = excluded.phone, company = excluded.company, role = excluded.role, rounds = excluded.rounds,
           final_status = excluded.final_status, stage = excluded.stage, outcome = excluded.outcome, hash = excluded.hash,
           first_seen_at = excluded.first_seen_at, changed_at = excluded.changed_at, outcome_at = excluded.outcome_at, baseline = excluded.baseline,
           ${ws ? "status = excluded.status, " : ""}last_seen_at = now(), removed_at = null
         returning id::text as id, tab, uid`,
        [
          sheet.sheetId,
          c.map((r) => r.tab),
          c.map((r) => r.gid),
          c.map((r) => r.uid),
          c.map((r) => r.phone),
          c.map((r) => r.company),
          c.map((r) => r.role),
          c.map((r) => JSON.stringify(r.rounds)),
          c.map((r) => r.finalStatus),
          c.map((r) => r.stage),
          c.map((r) => r.outcome),
          c.map((r) => r.hash),
          c.map((r) => r.firstSeen),
          c.map((r) => r.changedAt),
          c.map((r) => r.outcomeAt),
          c.map((r) => r.baseline),
          ...(ws ? [c.map((r) => r.status)] : []),
        ],
      );
      for (const r of res.rows) ids.set(`${r.tab}\u0000${r.uid}`, r.id);
    }
    if (diff.removed.length) {
      await tx.query("update app.company_shares set removed_at = now() where id = any($1::bigint[]) and removed_at is null", [diff.removed.map((r) => r.id)]);
    }
    await tx.query(
      `update app.company_sheets set drive_modified_at = coalesce($2, drive_modified_at), last_read_at = now(), last_tried_at = now(), read_error = null,
              tabs_read = $3, academy_rows = $4, updated_at = now() where sheet_id = $1`,
      [sheet.sheetId, opts.modifiedAt, built.tabsRead, built.academyRows],
    );
    const notices: ShareNotice[] = [];
    for (const e of diff.events) {
      const shareId = ids.get(`${e.share.tab}\u0000${e.share.uid}`);
      if (!shareId) continue;
      notices.push({
        type: e.type,
        shareId,
        uid: e.share.uid,
        company: e.share.company,
        role: e.share.role,
        stage: e.share.stage,
        outcome: e.share.outcome,
        hash: e.share.hash,
        text: e.type === "status" ? statusChangeText(e.prev, e.share) : "",
        finalChanged: e.type === "status" && e.prev.finalStatus.toLowerCase() !== e.share.finalStatus.toLowerCase(),
        kind: isApplicationsTab(e.share.tab) ? "applied" : "shared",
      });
    }
    return { changes: diff.events.length + diff.removed.length, notices };
  });
}

// ── Ticker, admin status and "Sync now" ─────────────────────────────────────

/** Once a minute from the ticker: starts a run (in the background) when the last one is an hour old. */
export async function sharesTickIfDue(): Promise<void> {
  if (g.__sharesRun || Date.now() - (g.__sharesCheckedAt ?? 0) < 5 * 60_000) return;
  g.__sharesCheckedAt = Date.now();
  if (!(await academySchemaReady())) return;
  const [last] = await query<{ started_at: Date; status: string }>("select started_at, status from app.company_share_syncs order by started_at desc limit 1");
  if (last) {
    const age = Date.now() - last.started_at.getTime();
    if (last.status === "running" && age < LEASE_MS) return;
    if (age < (last.status === "failed" ? SHARES_RETRY_AFTER_FAILURE_MS : SHARES_EVERY_MS)) return;
  }
  void syncShares("ticker").catch((err) => console.warn("[shares] tick failed:", short(err)));
}

export interface SharesStatusDto {
  lastRun: { startedAt: string; finishedAt: string | null; status: string; sheetsChecked: number; sheetsRead: number; rowsMatched: number; changes: number; errors: number; error: string | null } | null;
  unreadable: { company: string; sheetUrl: string; error: string }[];
  running: boolean;
}

export async function sharesStatus(): Promise<SharesStatusDto> {
  if (!(await academySchemaReady())) return { lastRun: null, unreadable: [], running: false };
  const [[run], unreadable] = await Promise.all([
    query<{ started_at: Date; finished_at: Date | null; status: string; sheets_checked: number; sheets_read: number; rows_matched: number; changes: number; errors: number; error: string | null }>(
      "select started_at, finished_at, status, sheets_checked, sheets_read, rows_matched, changes, errors, error from app.company_share_syncs order by started_at desc limit 1",
    ),
    query<{ company: string; sheet_id: string; read_error: string }>(
      `select company, sheet_id, read_error from app.company_sheets
        where read_error is not null and listed_at > now() - interval '3 days' order by lower(company), sheet_id limit 500`,
    ),
  ]);
  return {
    lastRun: run
      ? {
          startedAt: run.started_at.toISOString(),
          finishedAt: run.finished_at?.toISOString() ?? null,
          status: run.status,
          sheetsChecked: run.sheets_checked,
          sheetsRead: run.sheets_read,
          rowsMatched: run.rows_matched,
          changes: run.changes,
          errors: run.errors,
          error: run.error,
        }
      : null,
    unreadable: unreadable.map((u) => ({ company: u.company, sheetUrl: sheetUrl(u.sheet_id), error: u.read_error })),
    running: Boolean(g.__sharesRun) || (run?.status === "running" && Date.now() - run.started_at.getTime() < LEASE_MS),
  };
}

/** POST /pool/shares/sync: starts a run in the background, at most once every 5 minutes. */
export async function requestSharesSync(by: string): Promise<{ status: "started" | "running" | "fresh"; startedAt: string | null }> {
  if (!(await academySchemaReady())) throw new UserError(503, "The company-sheet sync isn't set up on the server yet (migration 020).", "not_ready");
  if (g.__sharesRun) return { status: "running", startedAt: null };
  const [last] = await query<{ started_at: Date; status: string }>("select started_at, status from app.company_share_syncs order by started_at desc limit 1");
  if (last) {
    const age = Date.now() - last.started_at.getTime();
    if (last.status === "running" && age < LEASE_MS) return { status: "running", startedAt: last.started_at.toISOString() };
    if (age < SHARES_MANUAL_MIN_MS) return { status: "fresh", startedAt: last.started_at.toISOString() };
  }
  void syncShares(by).catch((err) => console.warn("[shares] manual sync failed:", short(err)));
  return { status: "started", startedAt: new Date().toISOString() };
}

export type { PoolIndex };
