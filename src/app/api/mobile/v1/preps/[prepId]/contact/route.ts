import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { prepContact } from "@/lib/team/kit";

/** GET /preps/{prepId}/contact — the candidate's email from CRPs → company sheet: found / ambiguous / not_found (never guessed). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser<{ prepId: string }>(async (_req, _ctx, { prepId }) => {
  if (!/^[0-9a-f]{24}$/.test(prepId)) return fail(404, "This prep doesn't exist.", "not_found");
  return NextResponse.json(await prepContact(prepId), { headers: { "Cache-Control": "no-store" } });
});
