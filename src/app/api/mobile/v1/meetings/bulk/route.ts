import { NextResponse } from "next/server";
import { fail, readJson, UserError, withUser } from "@/lib/mobile/http";
import { createMeeting, type MeetingInput } from "@/lib/team/meetings";

/**
 * POST /meetings/bulk { items: [MeetingInput] } (max 20) — schedules several meetings (e.g. one
 * mock per candidate). Each item succeeds or fails on its own: { results: [{ ok, meeting? , error?, code? }] }.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = withUser(async (req, { user }) => {
  const body = await readJson<{ items?: MeetingInput[] }>(req);
  if (!body || !Array.isArray(body.items) || !body.items.length) return fail(400, "Send { items: [...] }.", "invalid_body");
  if (body.items.length > 20) return fail(422, "Schedule at most 20 meetings at once.", "invalid_body");
  const results = [];
  for (const item of body.items) {
    try {
      results.push({ ok: true, meeting: await createMeeting(user, item) });
    } catch (err) {
      if (err instanceof UserError) results.push({ ok: false, error: err.message, code: err.code ?? "error" });
      else {
        console.warn("[meetings] bulk item failed:", err instanceof Error ? err.message.slice(0, 200) : err);
        results.push({ ok: false, error: "This one couldn't be scheduled. Try it again.", code: "server_error" });
      }
    }
  }
  return NextResponse.json({ results });
});
