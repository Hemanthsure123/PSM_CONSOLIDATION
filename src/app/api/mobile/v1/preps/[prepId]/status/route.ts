import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { setPrepStatus } from "@/lib/mobile/preps/service";

/** POST /preps/{prepId}/status { status, document?, note? } — sets "Prep Given" (done fills Prep Date / Time, and "Prep given by" when empty). status "pending" reopens it. Returns the updated prep. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ prepId: string }>(async (req, { user }, { prepId }) => {
  if (!/^[0-9a-f]{24}$/.test(prepId)) return fail(404, "This prep doesn't exist.", "not_found");
  const body = await readJson<Record<string, unknown>>(req);
  if (!body) return fail(400, "Send a JSON body.", "invalid_body");
  return NextResponse.json(await setPrepStatus(user, prepId, body));
});
