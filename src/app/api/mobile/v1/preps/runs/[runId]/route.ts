import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { getRun } from "@/lib/prepdocs/service";

/** GET /preps/runs/{runId} — progress of a prep document run (step, done with the link, or failed with a reason). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser<{ runId: string }>(async (_req, _ctx, { runId }) => {
  if (!/^[0-9a-f-]{36}$/.test(runId)) return fail(404, "This run doesn't exist.", "not_found");
  const run = await getRun(runId);
  if (!run) return fail(404, "This run doesn't exist.", "not_found");
  return NextResponse.json(run, { headers: { "Cache-Control": "no-store" } });
});
