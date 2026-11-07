import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { cancelMeeting } from "@/lib/team/meetings";

/** DELETE /meetings/{meetingId} — cancels it (calendar event removed; guests who got the invite get a cancellation). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = withUser<{ meetingId: string }>(async (_req, { user }, { meetingId }) => {
  if (!/^[0-9a-f-]{36}$/.test(meetingId)) return fail(404, "This meeting doesn't exist.", "not_found");
  return NextResponse.json(await cancelMeeting(user, meetingId));
});
