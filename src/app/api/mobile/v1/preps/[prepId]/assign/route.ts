import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { assignPrep } from "@/lib/mobile/preps/service";

/** POST /preps/{prepId}/assign { emails } — sets "Prep given by" (take / hand back your own; leads and admins assign anyone). Returns the updated prep. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ prepId: string }>(async (req, { user }, { prepId }) => {
  if (!/^[0-9a-f]{24}$/.test(prepId)) return fail(404, "This prep doesn't exist.", "not_found");
  const body = await readJson<Record<string, unknown>>(req);
  if (!body) return fail(400, "Send a JSON body.", "invalid_body");
  return NextResponse.json(await assignPrep(user, prepId, body));
});
