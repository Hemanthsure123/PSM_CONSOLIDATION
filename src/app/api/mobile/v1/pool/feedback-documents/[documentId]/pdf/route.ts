import { fail, withUser } from "@/lib/mobile/http";
import { feedbackPdf } from "@/lib/feedback-docs/service";

/**
 * GET /pool/feedback-documents/{documentId}/pdf[?version=n] — the document as it is now in Google Docs
 * (with the reviewer's edits), as a PDF attachment. Only once reviewed (409 not_reviewed); with
 * version, 409 version_changed when it was rebuilt since. Content-Disposition carries an ASCII
 * filename and the full name in filename* (UTF-8, RFC 6266 / 5987).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 5987 value: UTF-8, percent-encoded (encodeURIComponent leaves ' ( ) * as they are). */
const ext = (s: string) => encodeURIComponent(s).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

export const GET = withUser<{ documentId: string }>(async (req, { user }, { documentId }) => {
  if (!UUID.test(documentId)) return fail(404, "This feedback document doesn't exist.", "not_found");
  const version = new URL(req.url).searchParams.get("version") ?? undefined;
  const { bytes, fileName, displayName } = await feedbackPdf(user, documentId, version);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${fileName}"; filename*=UTF-8''${ext(displayName)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
