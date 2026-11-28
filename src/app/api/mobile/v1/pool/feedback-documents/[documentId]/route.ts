import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { getFeedbackDoc } from "@/lib/feedback-docs/service";

/** GET /pool/feedback-documents/{documentId} — one feedback document (CandidateFeedbackDoc). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser<{ documentId: string }>(async (_req, { user }, { documentId }) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId)) return fail(404, "This feedback document doesn't exist.", "not_found");
  return NextResponse.json(await getFeedbackDoc(user, documentId), { headers: { "Cache-Control": "no-store" } });
});
