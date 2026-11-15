import { NextResponse } from "next/server";
import { deleteApiKey, updateApiKey } from "@/lib/admin/api-keys";
import { fail, readJson, withUser } from "@/lib/mobile/http";

/** Admins only. PATCH { label?, key?, enabled? } — rename, replace the key (checked again), switch on/off. DELETE — remove it. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID = /^[0-9a-f-]{36}$/;

export const PATCH = withUser<{ keyId: string }>(
  async (req, { user }, { keyId }) => {
    if (!ID.test(keyId)) return fail(404, "This key doesn't exist.", "not_found");
    const body = await readJson<{ label?: unknown; key?: unknown; enabled?: unknown }>(req);
    if (!body) return fail(400, "Send a JSON body.", "invalid_body");
    return NextResponse.json(await updateApiKey(user.email, keyId, body));
  },
  { admin: true },
);

export const DELETE = withUser<{ keyId: string }>(
  async (_req, { user }, { keyId }) => {
    if (!ID.test(keyId)) return fail(404, "This key doesn't exist.", "not_found");
    await deleteApiKey(user.email, keyId);
    return new NextResponse(null, { status: 204 });
  },
  { admin: true },
);
