import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { prepDetail } from "@/lib/mobile/preps/service";

/** GET /preps/{prepId} — one prep's page: interview, candidate, tags, resume, links, journey, activity. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser<{ prepId: string }>(async (_req, { user }, { prepId }) => {
  if (!/^[0-9a-f]{24}$/.test(prepId)) return fail(404, "This prep doesn't exist.", "not_found");
  return NextResponse.json(await prepDetail(user, prepId), { headers: { "Cache-Control": "no-store" } });
});
