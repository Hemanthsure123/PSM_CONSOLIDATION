import { NextResponse } from "next/server";
import { listNotices, sendNotice } from "@/lib/admin/notices";
import { fail, readJson, withUser } from "@/lib/mobile/http";

/**
 * Admins only. GET /admin/notices — sticky notifications sent lately, with who acknowledged.
 * POST { to: email, title, body } — sends one to a team member; it stays on their phone until they
 * tap Acknowledge.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async () => NextResponse.json({ items: await listNotices() }, { headers: { "Cache-Control": "no-store" } }), { admin: true });

export const POST = withUser(
  async (req, { user }) => {
    const body = await readJson<{ to?: unknown; title?: unknown; body?: unknown }>(req);
    if (!body) return fail(400, "Send a JSON body.", "invalid_body");
    return NextResponse.json(await sendNotice(user, body), { status: 201 });
  },
  { admin: true },
);
