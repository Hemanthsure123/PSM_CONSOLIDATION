import { NextResponse } from "next/server";
import { withUser } from "@/lib/mobile/http";
import { sharesStatus } from "@/lib/mobile/pool/shares-sync";

/**
 * Admins only. GET /pool/shares/status — the last company-sheet sync (counts) and the sheets the
 * service account can't open, so the owner can share them: { lastRun, unreadable: [{ company, sheetUrl, error }], running }.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async () => NextResponse.json(await sharesStatus(), { headers: { "Cache-Control": "no-store" } }), { admin: true });
