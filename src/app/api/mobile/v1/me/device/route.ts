import { readJson, withUser } from "@/lib/mobile/http";
import { type DeviceInfo, registerDevice } from "@/lib/mobile/sessions";

/** PUT /me/device: this phone's push token and details (app start, token rotation). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = withUser(async (req, { user, claims }) => {
  await registerDevice(user.email, claims.sid, await readJson<DeviceInfo>(req));
  return new Response(null, { status: 204 });
});
