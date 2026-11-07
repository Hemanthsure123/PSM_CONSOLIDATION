import { NextResponse } from "next/server";
import { fail, publicRoute, readJson } from "@/lib/mobile/http";
import { type DeviceInfo, startSession, verifyGoogleIdToken } from "@/lib/mobile/sessions";

/** POST /auth/google { idToken, device }: Google ID token → app session (docs/mobile-api.yaml). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = publicRoute(async (req) => {
  const body = await readJson<{ idToken?: string; device?: DeviceInfo }>(req);
  const idToken = String(body?.idToken ?? "");
  if (idToken.length < 100 || idToken.length > 8000) return fail(400, "Send { idToken, device }.", "invalid_request");
  const google = await verifyGoogleIdToken(idToken);
  return NextResponse.json(await startSession(google.email, google.name, body?.device));
});
