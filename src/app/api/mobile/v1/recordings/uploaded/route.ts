import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { uploadedDeviceKeys } from "@/lib/team/recordings";

/** GET /recordings/uploaded?since=ISO — device keys of the user's recordings already on the server (so the phone never uploads twice). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async (req, { user }) => {
  const raw = new URL(req.url).searchParams.get("since");
  const since = raw ? new Date(raw) : new Date(Date.now() - 30 * 86_400_000);
  if (!Number.isFinite(since.getTime())) return fail(422, "since must be a date.", "invalid_query");
  return NextResponse.json({ deviceKeys: await uploadedDeviceKeys(user.email, since) }, { headers: { "Cache-Control": "no-store" } });
});
