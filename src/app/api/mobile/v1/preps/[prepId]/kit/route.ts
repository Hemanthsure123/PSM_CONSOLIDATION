import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { communicationsFor, prepKit } from "@/lib/team/kit";

/** GET /preps/{prepId}/kit — prep documents (with staleness and sources), meetings, call recordings, drafts, message history. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser<{ prepId: string }>(async (_req, { user }, { prepId }) => {
  if (!/^[0-9a-f]{24}$/.test(prepId)) return fail(404, "This prep doesn't exist.", "not_found");
  const [kit, messages] = await Promise.all([prepKit(user, prepId), communicationsFor(prepId)]);
  return NextResponse.json({ ...kit, messages }, { headers: { "Cache-Control": "no-store" } });
});
