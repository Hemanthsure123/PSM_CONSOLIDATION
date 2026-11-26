import { NextResponse } from "next/server";
import { withUser } from "@/lib/mobile/http";
import { requestSharesSync } from "@/lib/mobile/pool/shares-sync";

/**
 * Admins only. POST /pool/shares/sync — re-check the company sheets now (Pool → Company sheets →
 * Sync now). 202 at once; the run goes on in the background (a few minutes). At most once every
 * 5 minutes: { status: started | running | fresh, startedAt }.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser(async (_req, { user }) => NextResponse.json(await requestSharesSync(`admin ${user.email}`), { status: 202 }), { admin: true });
