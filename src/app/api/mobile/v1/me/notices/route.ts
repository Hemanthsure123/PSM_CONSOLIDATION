import { NextResponse } from "next/server";
import { openNotices } from "@/lib/admin/notices";
import { withUser } from "@/lib/mobile/http";

/** GET /me/notices — the signed-in person's sticky notifications not acknowledged yet. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async (_req, { user }) => NextResponse.json({ items: await openNotices(user.email) }, { headers: { "Cache-Control": "no-store" } }));
