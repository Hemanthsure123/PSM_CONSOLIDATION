import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { markFeedbackReviewed } from "@/lib/feedback-docs/service";

/**
 * POST /pool/feedback-documents/{documentId}/review { version? } — marks it reviewed (draft → reviewed);
 * returns the document. With version: 409 version_changed when the document was rebuilt since.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = withUser<{ documentId: string }>(async (req, { user }, { documentId }) => {
  if (!UUID.test(documentId)) return fail(404, "This feedback document doesn't exist.", "not_found");
  const body = (await readJson<{ version?: unknown }>(req)) ?? {};
  return NextResponse.json(await markFeedbackReviewed(user, documentId, body.version));
});
