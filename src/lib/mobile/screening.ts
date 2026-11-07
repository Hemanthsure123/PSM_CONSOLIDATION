import "server-only";
import { google } from "googleapis";
import { query } from "@/lib/db/client";
import { readControlRequest, withSheetsRetry, writeControlStatus } from "@/lib/automation/control-sheet";
import { columnLetter } from "@/lib/automation/delivery-rules";
import { createOrResumeJob, queuePosition } from "@/lib/automation/store";
import { kickWorker } from "@/lib/automation/worker";
import { extractSpreadsheetId, getSheetsWriter } from "@/lib/sheets";
import { forgetControlSnapshot } from "@/lib/mobile/control-rows";
import { UserError } from "@/lib/mobile/http";
import { toMobileJob } from "@/lib/mobile/jobs";
import { normName, type RosterUser } from "@/lib/mobile/roster";
import { acknowledge, type TaskContext } from "@/lib/mobile/tasks";

/** ScreeningConfig in docs/mobile-api.yaml. */
export interface ScreeningConfig {
  subsheets: string[];
  focus: string;
  mustHaves?: string[];
  github: "off" | "fit" | "all";
  codeReview?: boolean;
  dsa: { enabled: boolean; minRating?: { codeforces?: number; codechef?: number; leetcode?: number }; minSolved?: number; minContests?: number; minScore?: number };
  experience?: string;
  topN: number;
}

const q = (tab: string) => `'${tab.replace(/'/g, "''")}'`;
const pos = (n: unknown) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.round(Number(n)) : 0);

/** Rejects what the agents would fail on anyway, with the sentence the app shows. */
export function validateConfig(raw: unknown): ScreeningConfig {
  const c = raw as Partial<ScreeningConfig> | null;
  if (!c || typeof c !== "object") throw new UserError(400, "Send the screening settings.", "invalid_config");
  const subsheets = Array.isArray(c.subsheets) ? c.subsheets.map((s) => String(s).trim()).filter(Boolean).slice(0, 20) : [];
  const focus = String(c.focus ?? "").trim().slice(0, 4000);
  const mustHaves = Array.isArray(c.mustHaves) ? c.mustHaves.map((s) => String(s).trim()).filter(Boolean).slice(0, 20) : [];
  const topN = pos(c.topN);
  if (!subsheets.length) throw new UserError(422, "Pick at least one subsheet.", "invalid_config");
  if (!focus && !mustHaves.length) throw new UserError(422, "Describe the focus or add a must-have.", "invalid_config");
  if (topN < 1 || topN > 500) throw new UserError(422, "Top N must be between 1 and 500.", "invalid_config");
  const github = c.github === "off" || c.github === "all" ? c.github : "fit";
  const dsa = c.dsa && typeof c.dsa === "object" ? c.dsa : { enabled: false };
  return {
    subsheets,
    focus,
    mustHaves,
    github,
    codeReview: c.codeReview !== false,
    dsa: {
      enabled: Boolean(dsa.enabled),
      minRating: { codeforces: pos(dsa.minRating?.codeforces), codechef: pos(dsa.minRating?.codechef), leetcode: pos(dsa.minRating?.leetcode) },
      minSolved: pos(dsa.minSolved),
      minContests: pos(dsa.minContests),
      minScore: pos(dsa.minScore),
    },
    experience: String(c.experience ?? "").trim().slice(0, 200),
    topN,
  };
}

/**
 * The control-row cells a person would type for this config, in the dropdown wording the sheet
 * uses — so the sheet shows the same thing whether the screening started from the app or the sheet,
 * and the deterministic instructions parser (lib/automation/instructions.ts) reads it back exactly.
 */
export function configToCells(c: ScreeningConfig) {
  const tabList = c.subsheets.map((t) => (/[,;&]|\band\b/i.test(t) ? `"${t}"` : t)).join(", ");
  const review = c.codeReview === false ? "no review" : "with review";
  const github = c.github === "off" ? "Off" : c.github === "all" ? `All candidates (${review})` : `Domain-fit candidates (${review})`;
  let dsa = "Off";
  if (c.dsa.enabled) {
    const r = c.dsa.minRating ?? {};
    const ratings = [r.codeforces && `CF ${r.codeforces}`, r.codechef && `CC ${r.codechef}`, r.leetcode && `LC ${r.leetcode}`].filter(Boolean).join(" or ");
    const extra = [c.dsa.minSolved && `${c.dsa.minSolved} solved`, c.dsa.minContests && `${c.dsa.minContests} contests`, c.dsa.minScore && `DSA score ${c.dsa.minScore}`].filter(Boolean);
    dsa = [ratings, ...extra].filter(Boolean).join(", ") || "Yes";
  }
  const lines = [
    c.focus && `Focus: ${c.focus.replace(/\s*\n+\s*/g, " ")}`,
    c.mustHaves?.length && `Focus: Must have: ${c.mustHaves.join("; ")}`,
    `Top: ${c.topN}`,
  ].filter(Boolean) as string[];
  return {
    subsheets: tabList,
    instructions: lines.join("\n"),
    github,
    dsa,
    experience: c.experience || "Not required",
  };
}

// --- Step 1: access ---

let driveClient: ReturnType<typeof google.drive> | null = null;
function drive() {
  driveClient ??= google.drive({
    version: "v3",
    auth: new google.auth.JWT({
      email: process.env.GCP_SERVICE_ACCOUNT_CLIENT_EMAIL,
      key: (process.env.GCP_SERVICE_ACCOUNT_PRIVATE_KEY ?? "").replace(/^["']|["']$/g, "").replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    }),
  });
  return driveClient;
}

export async function checkAccess(ctx: TaskContext) {
  const serviceAccountEmail = process.env.GCP_SERVICE_ACCOUNT_CLIENT_EMAIL ?? "";
  const sheetUrl = ctx.task.internalSheetUrl;
  const id = extractSpreadsheetId(sheetUrl);
  if (!id) throw new UserError(422, "This row has no Internal Sheet link in the coordination sheet.", "no_internal_sheet");
  let canRead = false;
  let canWrite = false;
  try {
    const meta = await drive().files.get({ fileId: id, fields: "capabilities(canEdit)", supportsAllDrives: true });
    canRead = true;
    canWrite = Boolean(meta.data.capabilities?.canEdit);
  } catch {
    canRead = false;
  }
  return { canRead, canWrite, serviceAccountEmail, sheetUrl };
}

// --- Step 2: tabs ---

/** Tabs the automation writes itself; never a source of candidates. */
const OWN_TAB = /^psm[_ ]/i;

export async function listTabs(ctx: TaskContext) {
  const id = extractSpreadsheetId(ctx.task.internalSheetUrl);
  if (!id) throw new UserError(422, "This row has no Internal Sheet link in the coordination sheet.", "no_internal_sheet");
  const sheets = getSheetsWriter();
  let meta;
  try {
    meta = await withSheetsRetry(() => sheets.spreadsheets.get({ spreadsheetId: id, fields: "sheets.properties(title,sheetId,hidden)" }));
  } catch {
    throw new UserError(403, "The automation can't open the Internal Sheet. Share it with the service account, then re-check access.", "no_access");
  }
  const tabs = (meta.data.sheets ?? [])
    .map((s) => s.properties!)
    .filter((p) => p.title && !p.hidden && !OWN_TAB.test(p.title));
  if (!tabs.length) return [];
  const heads = await withSheetsRetry(() => sheets.spreadsheets.values.batchGet({ spreadsheetId: id, ranges: tabs.map((t) => `${q(t.title!)}!1:1`) }));
  const resumeCol = heads.data.valueRanges!.map((vr) => {
    const row = ((vr.values ?? [])[0] ?? []).map((h) => String(h).toLowerCase());
    return row.findIndex((h) => /resume|cv\b/.test(h));
  });
  const bodies = await withSheetsRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: id,
      ranges: tabs.map((t, i) => {
        const col = resumeCol[i] >= 0 ? columnLetter(resumeCol[i] + 1) : "A";
        return `${q(t.title!)}!A2:${col}`;
      }),
    }),
  );
  const hints = normName(`${ctx.task.remarks} ${ctx.task.mechanism}`);
  return tabs.map((t, i) => {
    const values = (bodies.data.valueRanges![i].values ?? []) as unknown[][];
    const rows = values.filter((r) => r.some((c) => String(c ?? "").trim())).length;
    const withResume = resumeCol[i] >= 0 ? values.filter((r) => String(r[resumeCol[i]] ?? "").trim()).length : null;
    return {
      name: t.title!,
      rows,
      withResume,
      url: `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${t.sheetId}`,
      suggested: normName(t.title!).length > 2 && hints.includes(normName(t.title!)),
    };
  });
}

// --- Recheck: ETA ---

export async function estimate(ctx: TaskContext, config: ScreeningConfig) {
  const tabs = await listTabs(ctx);
  const picked = tabs.filter((t) => config.subsheets.includes(t.name));
  const profiles = picked.reduce((n, t) => n + t.rows, 0);
  const withResume = picked.reduce((n, t) => n + (t.withResume ?? t.rows), 0);
  // Seconds per profile from recent finished jobs (median of the last 10 with real volume).
  const history = await query<{ s: number }>(
    `select extract(epoch from (finished_at - started_at)) / nullif((progress->>'read')::numeric, 0) as s
       from automation.jobs where status = 'completed' and started_at is not null and finished_at is not null
        and coalesce((progress->>'read')::int, 0) >= 20 and finished_at > now() - interval '30 days'
      order by finished_at desc limit 10`,
  );
  const samples = history.map((h) => Number(h.s)).filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => a - b);
  const perProfile = samples.length ? samples[Math.floor(samples.length / 2)] : config.github === "off" ? 5.5 : 8;
  const full = Math.max(1, Math.ceil((withResume * perProfile) / 60));
  const ahead = await query<{ n: string }>("select count(*) n from automation.jobs where status in ('pending', 'processing')");
  return {
    profiles,
    withResume,
    earlyShortlistMinutes: Math.max(1, Math.round(full * 0.47)),
    fullMinutes: full,
    queueAhead: Number(ahead[0]?.n ?? 0),
    basis: samples.length ? `Median of the last ${samples.length} screenings` : "Typical speed (no recent history yet)",
  };
}

// --- Start ---

/**
 * Writes the control row exactly as a person would (Subsheets, Screening Instructions, Github,
 * DSA, Experience, Trigger = start), then enters the same path as the sheet's own trigger.
 * Idempotent per Idempotency-Key; a row with a running job answers 409 with that job.
 */
export async function startScreening(ctx: TaskContext, raw: unknown, idempotencyKey: string, by: RosterUser) {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(idempotencyKey)) throw new UserError(400, "Send an Idempotency-Key header.", "invalid_request");
  const config = validateConfig(raw);
  const access = await checkAccess(ctx);
  if (!access.canWrite) {
    throw new UserError(422, "The automation can't write to the Internal Sheet yet. Share it as Editor, then re-check access.", "no_access");
  }
  const { spreadsheetId, tab, columns: c } = ctx.snapshot;
  const row = ctx.task.row;
  const cells = configToCells(config);
  const writes = [
    [c.subsheets, cells.subsheets],
    [c.instructions, cells.instructions],
    [c.github, cells.github],
    [c.dsa, cells.dsa],
    [c.experience, cells.experience],
    [c.trigger, "start"],
  ].filter(([col]) => Number(col) > 0) as [number, string][];
  if (!c.instructions || !c.trigger) throw new UserError(503, "The control tab is missing its automation columns. Run setup in the sheet.", "sheet_setup");
  await withSheetsRetry(() =>
    getSheetsWriter().spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: writes.map(([col, value]) => ({ range: `${q(tab)}!${columnLetter(col)}${row}`, values: [[value]] })),
      },
    }),
  );
  forgetControlSnapshot();

  const request = await readControlRequest(spreadsheetId, tab, row);
  if (request.companyName.trim().toLowerCase() !== ctx.task.company.trim().toLowerCase()) {
    throw new UserError(409, "The sheet changed while starting (rows moved). Refresh and try again.", "row_moved");
  }
  const outcome = await createOrResumeJob(request, idempotencyKey);
  if (outcome.kind === "busy") return { status: 409, job: toMobileJob(outcome.job, ctx.task.taskId) };
  const ahead = await queuePosition(outcome.job);
  if (outcome.kind !== "existing" || outcome.job.status === "pending") {
    await writeControlStatus(
      outcome.job,
      { status: outcome.job.status, step: outcome.job.step, progress: outcome.job.progress, result: outcome.job.result, error: outcome.job.error, queueAhead: ahead },
      { requestId: idempotencyKey },
    );
  }
  kickWorker();
  await acknowledge(ctx, by);
  await query("update app.assignments set job_id = $2, updated_at = now() where task_id = $1", [ctx.task.taskId, outcome.job.id]);
  return { status: outcome.kind === "existing" ? 200 : 202, job: toMobileJob(outcome.job, ctx.task.taskId, ahead) };
}
