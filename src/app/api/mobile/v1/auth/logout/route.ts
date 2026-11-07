import { withUser } from "@/lib/mobile/http";
import { endSession } from "@/lib/mobile/sessions";

/** POST /auth/logout: ends this device's session; its push token is forgotten. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser(async (_req, { claims }) => {
  await endSession(claims.sid);
  return new Response(null, { status: 204 });
});
