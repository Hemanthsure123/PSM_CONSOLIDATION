import { NextResponse } from "next/server";
import { addApiKey, listApiKeys } from "@/lib/admin/api-keys";
import { fail, readJson, withUser } from "@/lib/mobile/http";

/**
 * Admins only. GET /admin/api-keys — the providers (with how many keys the server itself has) and
 * the keys added in the app (label + last 4 characters, never the key). POST { provider, label?, key }
 * — adds a key after a read-only check with the provider (a rejected key is kept but not used).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async () => NextResponse.json(await listApiKeys(), { headers: { "Cache-Control": "no-store" } }), { admin: true });

export const POST = withUser(
  async (req, { user }) => {
    const body = await readJson<{ provider?: unknown; label?: unknown; key?: unknown }>(req);
    if (!body) return fail(400, "Send a JSON body.", "invalid_body");
    return NextResponse.json(await addApiKey(user.email, body), { status: 201 });
  },
  { admin: true },
);
