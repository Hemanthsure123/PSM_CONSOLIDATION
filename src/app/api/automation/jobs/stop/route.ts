import { NextResponse } from "next/server";
import { databaseConfigured, describeDbError } from "@/lib/db/client";
import { allowedSpreadsheets, allowedTabs, checkToken, jobSummary } from "@/lib/automation/api";
import { writeControlStatus } from "@/lib/automation/control-sheet";
import { cancelPendingJob, requestStopJob } from "@/lib/automation/store";
import { kickWorker } from "@/lib/automation/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const denied = checkToken(req);
  if (denied) return denied;
  if (!databaseConfigured()) return NextResponse.json({ error: "The database isn't configured." }, { status: 503 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const jobId = typeof body?.jobId === "string" ? body.jobId : undefined;
  const spreadsheetId = typeof body?.spreadsheetId === "string" ? body.spreadsheetId : undefined;
  const sheetName = typeof body?.sheetName === "string" ? body.sheetName : undefined;
  const row = typeof body?.row === "number" ? body.row : undefined;

  if (!jobId && (!spreadsheetId || !sheetName || !row)) {
    return NextResponse.json({ error: "Send { jobId } or { spreadsheetId, sheetName, row }." }, { status: 400 });
  }

  if (spreadsheetId && (!allowedSpreadsheets().includes(spreadsheetId) || !allowedTabs().includes(sheetName!))) {
    return NextResponse.json({ error: "This sheet isn't set up for automation." }, { status: 403 });
  }

  try {
    const job = await requestStopJob({ jobId, spreadsheetId, controlTab: sheetName, controlRow: row });
    if (!job) {
      return NextResponse.json({ error: "No active or pending job found for this row." }, { status: 404 });
    }

    // Still queued: finish it at once (nothing was screened). If a worker took it meanwhile, it
    // sees the stop flag and delivers what it screened — handled like a running job below.
    const cancelled = job.status === "pending" ? await cancelPendingJob(job.id) : null;
    if (cancelled) {
      await writeControlStatus(cancelled, {
        status: "completed",
        step: "done",
        progress: { ...cancelled.progress, note: "Stopped before screening started — nothing was screened" },
        result: null,
        error: null,
      });
      return NextResponse.json({ message: "Job was pending and has been stopped.", job: jobSummary(cancelled) }, { status: 200 });
    }

    // If processing, kick worker so it checks stopRequested and delivers results screened so far
    kickWorker();
    return NextResponse.json({
      message: "Stop requested. Screening will halt and deliver candidates screened up to this point.",
      job: jobSummary(job),
    }, { status: 200 });
  } catch (err) {
    console.error("[automation] stop failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: describeDbError(err) }, { status: 503 });
  }
}

