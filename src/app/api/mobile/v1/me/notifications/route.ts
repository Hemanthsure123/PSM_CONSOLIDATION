import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { listInbox, markInboxRead } from "@/lib/mobile/inbox";

/**
 * GET /me/notifications[?before=<id>] — the notification inbox (bell icon), newest first, 50 a page.
 * POST /me/notifications { ids?: [id…], all?: true } — mark read; returns { unread }.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async (req, { user }) => {
  const before = new URL(req.url).searchParams.get("before");
  return NextResponse.json(await listInbox(user, before), { headers: { "Cache-Control": "no-store" } });
});

export const POST = withUser(async (req, { user }) => {
  const body = await readJson<{ ids?: unknown; all?: unknown }>(req);
  if (!body) return fail(400, "Send a JSON body.", "invalid_body");
  return NextResponse.json({ unread: await markInboxRead(user, body.ids, body.all === true) });
});
