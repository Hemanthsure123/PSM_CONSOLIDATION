import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { listStarts } from "@/lib/mobile/pool/companies";
import { isDay } from "@/lib/mobile/pool/companies-model";

/** GET /pool/companies/starts?from=YYYY-MM-DD&to=YYYY-MM-DD — tentative process starts for the Calendar (range at most 400 days). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async (req) => {
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if ((from && !isDay(from)) || (to && !isDay(to))) return fail(400, "from and to are dates (YYYY-MM-DD).", "invalid_range");
  if (from && to && (to < from || Date.parse(to) - Date.parse(from) > 400 * 86_400_000)) return fail(400, "The range is at most 400 days.", "invalid_range");
  return NextResponse.json({ starts: await listStarts(from, to) }, { headers: { "Cache-Control": "private, no-store" } });
});
