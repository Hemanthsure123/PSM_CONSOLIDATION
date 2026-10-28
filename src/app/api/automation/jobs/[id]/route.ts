import { NextResponse } from "next/server";
import { databaseConfigured, describeDbError } from "@/lib/db/client";
import { checkToken, jobSummary } from "@/lib/automation/api";
import { getJob, jobEvents, queuePosition } from "@/lib/automation/store";
import { kickWorker } from "@/lib/automation/worker";

/**
 * Sheet automation — one job: its status, progress, result and (with ?events=1) its event log.
 * A check-in also wakes the worker, so a job left waiting by a restart continues.
 * Auth: Bearer AUTOMATION_TOKEN.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const denied = checkToken(req);
  if (denied) return denied;
  if (!databaseConfigured()) return NextResponse.json({ error: "The database isn't configured." }, { status: 503 });
  try {
    const job = await getJob(params.id);
    if (!job) return NextResponse.json({ error: "No such job." }, { status: 404 });
    kickWorker();
    const ahead = job.status === "pending" ? await queuePosition(job) : 0;
    const events = new URL(req.url).searchParams.has("events") ? await jobEvents(job.id) : undefined;
    return NextResponse.json({ job: jobSummary(job, { queueAhead: ahead }), ...(events ? { events } : {}) });
  } catch (err) {
    return NextResponse.json({ error: describeDbError(err) }, { status: 503 });
  }
}
