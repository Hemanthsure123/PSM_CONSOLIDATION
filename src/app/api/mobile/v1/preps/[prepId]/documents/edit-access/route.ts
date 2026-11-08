import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { grantEditAccess } from "@/lib/team/prep";

/**
 * POST /preps/{prepId}/documents/edit-access — gives the signed-in person (their roster email and
 * linked Google accounts) edit access to the round's Google Doc and returns { url, title, emails }.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ prepId: string }>(async (_req, { user }, { prepId }) => {
  if (!/^[0-9a-f]{24}$/.test(prepId)) return fail(404, "This prep doesn't exist.", "not_found");
  return NextResponse.json(await grantEditAccess(user, prepId));
});
