import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { feedbackOverview, startFeedback } from "@/lib/feedback-docs/service";

/**
 * GET /pool/{uid}/feedback-documents — the candidate's feedback documents, what the user may do, the
 * period presets and the latest run (CandidateFeedbackOverview).
 * POST /pool/{uid}/feedback-documents { from, to } — build the document for that period (or rebuild it
 * in place); 202 with the run (poll /pool/feedback-runs/{runId}).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/;

export const GET = withUser<{ uid: string }>(async (_req, { user }, { uid }) => {
  if (!UID.test(uid)) return fail(404, "This candidate isn't in the pool.", "not_found");
  return NextResponse.json(await feedbackOverview(user, uid), { headers: { "Cache-Control": "no-store" } });
});

export const POST = withUser<{ uid: string }>(async (req, { user }, { uid }) => {
  if (!UID.test(uid)) return fail(404, "This candidate isn't in the pool.", "not_found");
  const body = await readJson<{ from?: unknown; to?: unknown }>(req);
  if (!body) return fail(400, "Send a JSON body: { from, to }.", "invalid_body");
  return NextResponse.json(await startFeedback(user, uid, body), { status: 202 });
});
