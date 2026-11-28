import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { markFeedbackShared } from "@/lib/feedback-docs/service";

/**
 * POST /pool/feedback-documents/{documentId}/shared { channel: whatsapp | other, version? } — the app
 * opened WhatsApp (or another app) with the PDF.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = withUser<{ documentId: string }>(async (req, { user }, { documentId }) => {
  if (!UUID.test(documentId)) return fail(404, "This feedback document doesn't exist.", "not_found");
  const body = await readJson<{ channel?: unknown; version?: unknown }>(req);
  if (!body) return fail(400, "Send a JSON body: { channel }.", "invalid_body");
  return NextResponse.json(await markFeedbackShared(user, documentId, body.channel, body.version));
});
