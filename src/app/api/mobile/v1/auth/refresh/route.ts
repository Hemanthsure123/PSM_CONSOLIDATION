import { NextResponse } from "next/server";
import { fail, publicRoute, readJson } from "@/lib/mobile/http";
import { refreshSession } from "@/lib/mobile/sessions";

/** POST /auth/refresh { refreshToken }: rotates the refresh token, issues a new access token. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = publicRoute(async (req) => {
  const body = await readJson<{ refreshToken?: string }>(req);
  const token = String(body?.refreshToken ?? "");
  if (token.length < 20 || token.length > 200) return fail(400, "Send { refreshToken }.", "invalid_request");
  return NextResponse.json(await refreshSession(token));
});
