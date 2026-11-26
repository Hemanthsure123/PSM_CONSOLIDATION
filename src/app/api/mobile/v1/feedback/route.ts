import { NextResponse } from "next/server";
import { submitFeedback } from "@/lib/mobile/feedback";
import { fail, readJson, withUser } from "@/lib/mobile/http";

/**
 * POST /feedback { category: problem|idea|other, message, screen?, appVersion?, device? } (anyone
 * signed in) → 201 { id }. Every active admin gets a "feedback" push. 10 per person per hour.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser(async (req, { user }) => {
  const body = await readJson<Record<string, unknown>>(req);
  if (!body) return fail(400, "Send a JSON body.", "invalid_body");
  return NextResponse.json(await submitFeedback(user, body), { status: 201 });
});
