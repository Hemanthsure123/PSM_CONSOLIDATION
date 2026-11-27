import { NextResponse } from "next/server";
import { withUser } from "@/lib/mobile/http";
import { listCompanies } from "@/lib/mobile/pool/companies";

/**
 * GET /pool/companies (PSM 1.12.0) — every hiring drive Academy assessed candidates were sent to:
 * requirements from the CRPs master (CTC, openings, Academy counts, JD / HubSpot remarks, tentative
 * start), the candidates found in the company sheet with their status, and the drive's state. Every
 * active member sees everything ("mine" marks the caller's candidates). ETag-aware: unchanged → 304.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async (req, { user }) => {
  const { body, etag } = await listCompanies(user);
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return NextResponse.json(body, { headers: { ETag: etag, "Cache-Control": "private, no-store" } });
});
