import { NextResponse } from "next/server";
import { withUser } from "@/lib/mobile/http";
import { pushToUser } from "@/lib/mobile/push";

/** POST /me/test-notification: a real push to all of my devices (onboarding check). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser(async (_req, { user }) => {
  const r = await pushToUser({
    email: user.email,
    kind: "test",
    data: {
      taskId: "test-notification",
      company: "Test company",
      profilesRequired: "5",
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    },
  });
  return NextResponse.json({ delivered: r.delivered }, { status: 202 });
});
