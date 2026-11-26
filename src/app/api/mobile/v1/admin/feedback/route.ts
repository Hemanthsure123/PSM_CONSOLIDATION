import { NextResponse } from "next/server";
import { listFeedback } from "@/lib/mobile/feedback";
import { withUser } from "@/lib/mobile/http";

/** Admins only. GET /admin/feedback — the team's feedback, newest first (up to 200), and how many are unread. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async () => NextResponse.json(await listFeedback(), { headers: { "Cache-Control": "no-store" } }), { admin: true });
