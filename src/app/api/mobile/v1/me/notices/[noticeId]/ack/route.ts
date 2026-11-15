import { NextResponse } from "next/server";
import { acknowledgeNotice } from "@/lib/admin/notices";
import { fail, withUser } from "@/lib/mobile/http";

/** POST /me/notices/{noticeId}/ack — the recipient acknowledges it (a second call is harmless). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ noticeId: string }>(async (_req, { user }, { noticeId }) => {
  if (!/^[0-9a-f-]{36}$/.test(noticeId)) return fail(404, "This notice doesn't exist.", "not_found");
  return NextResponse.json(await acknowledgeNotice(user.email, noticeId));
});
