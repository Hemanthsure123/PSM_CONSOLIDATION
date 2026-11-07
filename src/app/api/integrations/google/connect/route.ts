import { NextResponse } from "next/server";
import { basicAuthAdmin, callbackUrl, oauthState, page, readAdminConnectToken } from "@/lib/team/connect";
import { consentUrl, TeamAccountError } from "@/lib/team/google";

/**
 * GET /api/integrations/google/connect — starts connecting the team Google account. Opened by an
 * admin from the app (?t=<10-minute signed link>) or from the web console (its Basic sign-in).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const admin = readAdminConnectToken(url.searchParams.get("t")) ?? basicAuthAdmin(req);
  if (!admin) {
    return new NextResponse("Sign in to continue.", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="NxtWave Placements", charset="UTF-8"' } });
  }
  try {
    return NextResponse.redirect(consentUrl(callbackUrl(req), oauthState(admin)));
  } catch (err) {
    return page("Can't connect yet", err instanceof TeamAccountError ? err.message : "The server couldn't start Google sign-in.", false);
  }
}
