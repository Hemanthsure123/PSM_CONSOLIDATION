import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { communicationsFor, logWhatsapp } from "@/lib/team/kit";

/**
 * GET /preps/{prepId}/messages — emails and WhatsApp hand-offs for the prep, newest first.
 * POST /preps/{prepId}/messages { purpose, to?, meetingId? } — the app opened WhatsApp with a
 * message (logged as "opened"; WhatsApp gives no delivery receipt without its API).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser<{ prepId: string }>(async (_req, _ctx, { prepId }) => {
  if (!/^[0-9a-f]{24}$/.test(prepId)) return fail(404, "This prep doesn't exist.", "not_found");
  return NextResponse.json({ items: await communicationsFor(prepId) }, { headers: { "Cache-Control": "no-store" } });
});

export const POST = withUser<{ prepId: string }>(async (req, { user }, { prepId }) => {
  if (!/^[0-9a-f]{24}$/.test(prepId)) return fail(404, "This prep doesn't exist.", "not_found");
  const body = await readJson<Record<string, unknown>>(req);
  if (!body) return fail(400, "Send a JSON body.", "invalid_body");
  return NextResponse.json(await logWhatsapp(user, prepId, body));
});
