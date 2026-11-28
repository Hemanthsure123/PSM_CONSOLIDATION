import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { getFeedbackRun } from "@/lib/feedback-docs/service";

/** GET /pool/feedback-runs/{runId} — progress of a feedback document build (step, done with the document, or failed with a reason). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser<{ runId: string }>(async (_req, _ctx, { runId }) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) return fail(404, "This run doesn't exist.", "not_found");
  const run = await getFeedbackRun(runId);
  if (!run) return fail(404, "This run doesn't exist.", "not_found");
  return NextResponse.json(run, { headers: { "Cache-Control": "no-store" } });
});
