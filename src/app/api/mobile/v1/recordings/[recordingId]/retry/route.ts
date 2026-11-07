import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { retryRecording } from "@/lib/team/recordings";

/** POST /recordings/{recordingId}/retry — tries a failed transcript / summary again (from the saved file). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ recordingId: string }>(async (_req, { user }, { recordingId }) => {
  if (!/^[0-9a-f-]{36}$/.test(recordingId)) return fail(404, "This recording doesn't exist.", "not_found");
  return NextResponse.json(await retryRecording(user, recordingId));
});
