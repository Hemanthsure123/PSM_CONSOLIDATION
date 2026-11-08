import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { meetingSetup } from "@/lib/team/prep";

/**
 * GET /preps/{prepId}/meeting-setup — for the Google Meet scheduler: candidate, company, round,
 * phone, the team account's state, the email and WhatsApp drafts per meeting kind ({meet_link} and
 * {when} are filled by the server) and the prep's meetings.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser<{ prepId: string }>(async (_req, { user }, { prepId }) => {
  if (!/^[0-9a-f]{24}$/.test(prepId)) return fail(404, "This prep doesn't exist.", "not_found");
  return NextResponse.json(await meetingSetup(user, prepId), { headers: { "Cache-Control": "no-store" } });
});
