import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { poolMeetingSetup } from "@/lib/mobile/pool/meetings";

/** POST /pool/meeting-setup { ids: [uid…] } — emails, drafts and the team account's state for a mock interview / guidance meet. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser(async (req, { user }) => {
  const body = await readJson<{ ids?: unknown }>(req);
  if (!body) return fail(400, "Send a JSON body.", "invalid_body");
  return NextResponse.json(await poolMeetingSetup(user, body.ids));
});
