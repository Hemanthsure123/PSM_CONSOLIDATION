import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { resendMeetingEmail } from "@/lib/team/meetings";

/** POST /meetings/{meetingId}/resend — sends the meeting's email (with the invite) to every guest again. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ meetingId: string }>(async (_req, { user }, { meetingId }) => {
  if (!/^[0-9a-f-]{36}$/.test(meetingId)) return fail(404, "This meeting doesn't exist.", "not_found");
  return NextResponse.json(await resendMeetingEmail(user, meetingId));
});
