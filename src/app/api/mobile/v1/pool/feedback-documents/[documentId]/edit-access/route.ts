import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { feedbackEditAccess } from "@/lib/feedback-docs/service";

/**
 * POST /pool/feedback-documents/{documentId}/edit-access — gives the signed-in person (roster email and
 * linked Google accounts) edit access to the Google Doc; { url, title, emails }.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ documentId: string }>(async (_req, { user }, { documentId }) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId)) return fail(404, "This feedback document doesn't exist.", "not_found");
  return NextResponse.json(await feedbackEditAccess(user, documentId));
});
