import { NextResponse } from "next/server";
import { databaseConfigured } from "@/lib/db/client";
import { checkToken } from "@/lib/automation/api";
import { syncAssignments } from "@/lib/mobile/assignments";

/**
 * POST /api/automation/tick (Bearer AUTOMATION_TOKEN): one pass of the app's assignment sync —
 * new Mentor assignments, reminders, escalations, job news → pushes. The server also ticks every
 * minute on its own; this wakes a sleeping instance (the sheet's sweep or any cron can call it).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const denied = checkToken(req);
  if (denied) return denied;
  if (!databaseConfigured()) return NextResponse.json({ error: "The database isn't configured." }, { status: 503 });
  try {
    return NextResponse.json(await syncAssignments());
  } catch (err) {
    console.error("[mobile] tick failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Tick failed; see the server log." }, { status: 503 });
  }
}
