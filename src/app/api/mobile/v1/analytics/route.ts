import { NextResponse } from "next/server";
import { analyticsFor, parseRange } from "@/lib/mobile/analytics";
import { withUser } from "@/lib/mobile/http";

/**
 * GET /analytics?days=7|30|90 (or from=YYYY-MM-DD&to=YYYY-MM-DD) &scope=mine|team
 * Real numbers from the control sheet and the screening jobs; every row links to its sheet row
 * and its shortlist tab.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async (req, { user }) => {
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") === "team" ? "team" : "mine";
  const body = await analyticsFor(user, scope, parseRange(url.searchParams));
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
});
