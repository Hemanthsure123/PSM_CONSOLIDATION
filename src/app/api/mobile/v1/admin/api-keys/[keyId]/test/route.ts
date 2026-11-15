import { NextResponse } from "next/server";
import { retestApiKey } from "@/lib/admin/api-keys";
import { fail, withUser } from "@/lib/mobile/http";

/** Admins only. POST — checks the saved key with its provider again (read-only, no usage spent). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ keyId: string }>(
  async (_req, { user }, { keyId }) => {
    if (!/^[0-9a-f-]{36}$/.test(keyId)) return fail(404, "This key doesn't exist.", "not_found");
    return NextResponse.json(await retestApiKey(user.email, keyId));
  },
  { admin: true },
);
