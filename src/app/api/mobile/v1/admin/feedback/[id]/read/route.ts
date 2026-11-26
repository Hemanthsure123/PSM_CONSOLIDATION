import { NextResponse } from "next/server";
import { markFeedbackRead } from "@/lib/mobile/feedback";
import { withUser } from "@/lib/mobile/http";

/** Admins only. POST /admin/feedback/{id}/read → { id, readAt }. Idempotent. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ id: string }>(async (_req, _ctx, { id }) => NextResponse.json(await markFeedbackRead(id)), { admin: true });
