import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { createMeeting, listMeetings, type MeetingInput } from "@/lib/team/meetings";

/**
 * GET /meetings?from=ISO&to=ISO[&prepId=][&jobId=][&mine=1] — meetings in a window (max 62 days).
 * POST /meetings { kind, prepId?|jobId?, company?, title?, startsAt, durationMin, attendees: [{email, name?}],
 *   record?, email: { mode: "now"|"scheduled"|"none", subject, body, sendAt? }, force? }
 * — calendar event + Meet link from the team account, auto recording, email now / later.
 * 409 duplicate_meeting / meeting_conflict unless force.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async (req, { user }) => {
  const sp = new URL(req.url).searchParams;
  const from = new Date(sp.get("from") ?? Date.now() - 7 * 86_400_000);
  const to = new Date(sp.get("to") ?? Date.now() + 30 * 86_400_000);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) return fail(422, "from / to must be dates, from before to.", "invalid_query");
  if (to.getTime() - from.getTime() > 62 * 86_400_000) return fail(422, "Ask for at most 62 days at a time.", "invalid_query");
  const prepId = sp.get("prepId") ?? undefined;
  const items = await listMeetings(user, { from, to, prepKey: prepId && /^[0-9a-f]{24}$/.test(prepId) ? prepId : undefined, jobKey: sp.get("jobId") ?? undefined, mine: sp.get("mine") === "1" });
  return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
});

export const POST = withUser(async (req, { user }) => {
  const body = await readJson<MeetingInput>(req);
  if (!body) return fail(400, "Send a JSON body.", "invalid_body");
  return NextResponse.json(await createMeeting(user, body), { status: 201 });
});
