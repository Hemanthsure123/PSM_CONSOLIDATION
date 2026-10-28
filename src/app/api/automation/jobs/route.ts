import { NextResponse } from "next/server";
import { databaseConfigured, describeDbError } from "@/lib/db/client";
import { allowedSpreadsheets, allowedTabs, checkToken, jobSummary } from "@/lib/automation/api";
import { readControlRequest, writeControlStatus } from "@/lib/automation/control-sheet";
import { createOrResumeJob, listJobs, queuePosition } from "@/lib/automation/store";
import { kickWorker } from "@/lib/automation/worker";

/**
 * Sheet automation — jobs.
 *
 * POST { spreadsheetId, sheetName, row, requestId }   (from the sheet's Apps Script on "start")
 *   Reads the control row itself (the sheet is the source of truth), checks its Trigger says
 *   "start", and records the job. Idempotent per requestId; a row whose job is still running
 *   gets 409 with that job. 202 = queued (or resumed from its checkpoint).
 * GET ?limit=20 — the latest jobs.
 * Auth: Bearer AUTOMATION_TOKEN (lib/automation/api.ts).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const denied = checkToken(req);
  if (denied) return denied;
  if (!databaseConfigured()) return NextResponse.json({ error: "The database isn't configured." }, { status: 503 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const spreadsheetId = String(body?.spreadsheetId ?? "");
  const sheetName = String(body?.sheetName ?? "");
  const row = Number(body?.row);
  const requestId = String(body?.requestId ?? "");
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(spreadsheetId) || !sheetName || sheetName.length > 100 || !Number.isInteger(row) || row < 2 || row > 200_000 || !/^[A-Za-z0-9-]{8,80}$/.test(requestId)) {
    return NextResponse.json({ error: "Send { spreadsheetId, sheetName, row, requestId }." }, { status: 400 });
  }
  if (!allowedSpreadsheets().includes(spreadsheetId) || !allowedTabs().includes(sheetName)) {
    return NextResponse.json({ error: "This sheet isn't set up for the automation (AUTOMATION_SPREADSHEET_IDS / AUTOMATION_CONTROL_TABS)." }, { status: 403 });
  }
  try {
    const request = await readControlRequest(spreadsheetId, sheetName, row);
    if (request.trigger.trim().toLowerCase() !== "start") {
      return NextResponse.json({ error: `Row ${row}'s Trigger says "${request.trigger.slice(0, 20)}", not "start" — nothing started.` }, { status: 422 });
    }
    if (!request.instructions.trim()) {
      return NextResponse.json({ error: `Row ${row} has no Screening Instructions — add them, then type start again.` }, { status: 422 });
    }
    const outcome = await createOrResumeJob(request, requestId);
    if (outcome.kind === "busy") {
      return NextResponse.json({ error: "A job is already running for this row.", job: jobSummary(outcome.job) }, { status: 409 });
    }
    const ahead = await queuePosition(outcome.job);
    if (outcome.kind !== "existing" || outcome.job.status === "pending") {
      await writeControlStatus(outcome.job, { status: outcome.job.status, step: outcome.job.step, progress: outcome.job.progress, result: outcome.job.result, error: outcome.job.error, queueAhead: ahead }, { requestId });
    }
    kickWorker();
    return NextResponse.json({ outcome: outcome.kind, job: jobSummary(outcome.job, { queueAhead: ahead }) }, { status: outcome.kind === "existing" ? 200 : 202 });
  } catch (err) {
    console.error("[automation] trigger failed:", err instanceof Error ? err.message : err);
    const message = err instanceof Error && /column|header|tab/i.test(err.message) ? err.message : describeDbError(err);
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

export async function GET(req: Request) {
  const denied = checkToken(req);
  if (denied) return denied;
  if (!databaseConfigured()) return NextResponse.json({ error: "The database isn't configured." }, { status: 503 });
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 20);
  try {
    kickWorker();
    return NextResponse.json({ jobs: (await listJobs(limit)).map((j) => jobSummary(j)) });
  } catch (err) {
    return NextResponse.json({ error: describeDbError(err) }, { status: 503 });
  }
}
