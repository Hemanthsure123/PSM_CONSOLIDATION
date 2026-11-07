import { NextResponse } from "next/server";
import { databaseConfigured } from "@/lib/db/client";
import { checkToken } from "@/lib/automation/api";
import { mobileTick } from "@/lib/mobile/ticker";

/**
 * POST /api/automation/tick (Bearer AUTOMATION_TOKEN): one pass of the app's syncs — new Mentor
 * assignments, reminders, escalations, job news, and the drill-down preps / interviews → pushes.
 * The server also ticks every minute on its own; this wakes a sleeping instance (the sheet's sweep
 * or any cron can call it).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const denied = checkToken(req);
  if (denied) return denied;
  if (!databaseConfigured()) return NextResponse.json({ error: "The database isn't configured." }, { status: 503 });
  const r = await mobileTick();
  if (!r.tasks && !r.preps) return NextResponse.json({ error: "Tick failed; see the server log." }, { status: 503 });
  // Same shape as before for the tasks (checked / pushed), plus the preps.
  return NextResponse.json({ checked: r.tasks?.checked ?? 0, pushed: r.tasks?.pushed ?? 0, preps: r.preps });
}
