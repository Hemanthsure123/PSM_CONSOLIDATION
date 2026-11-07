import { NextResponse } from "next/server";
import { withUser } from "@/lib/mobile/http";
import { adminConnectToken, publicOrigin } from "@/lib/team/connect";
import { teamConfig } from "@/lib/team/google";

/** POST /admin/integrations/google/start — a 10-minute link that opens Google sign-in for the team account. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser(async (req, { user }) => {
  const c = teamConfig();
  return NextResponse.json({
    url: `${publicOrigin(req)}/api/integrations/google/connect?t=${encodeURIComponent(adminConnectToken(user.email))}`,
    account: c.account,
    configured: c.configured,
  });
}, { admin: true });
