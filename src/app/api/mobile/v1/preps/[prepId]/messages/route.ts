import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { logWhatsapp } from "@/lib/team/prep";

/**
 * POST /preps/{prepId}/messages { purpose, to? } — the app opened WhatsApp with a message: a line is
 * added to the row's Prep Messages column (WhatsApp gives no delivery receipt without its API).
 * Messages are kept in the sheet only.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ prepId: string }>(async (req, { user }, { prepId }) => {
  if (!/^[0-9a-f]{24}$/.test(prepId)) return fail(404, "This prep doesn't exist.", "not_found");
  const body = await readJson<Record<string, unknown>>(req);
  if (!body) return fail(400, "Send a JSON body.", "invalid_body");
  return NextResponse.json(await logWhatsapp(user, prepId, body));
});
