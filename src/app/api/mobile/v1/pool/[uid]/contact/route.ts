import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { logPoolContact } from "@/lib/mobile/pool/service";

/** POST /pool/{uid}/contact { channel: call | whatsapp | email } — logged for "last contacted" and the history. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ uid: string }>(async (req, { user }, { uid }) => {
  const body = await readJson<{ channel?: unknown }>(req);
  if (!body) return fail(400, "Send a JSON body.", "invalid_body");
  await logPoolContact(user, uid, body.channel);
  return new NextResponse(null, { status: 204 });
});
