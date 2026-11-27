import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { setTentativeStart } from "@/lib/mobile/pool/companies";

/**
 * PUT /pool/companies/requirements/{key}/tentative-start — body {"date": "YYYY-MM-DD"} sets the
 * requirement's tentative process start (shown in the Calendar), {"date": null} clears it. Any
 * active member; audited (tentative_start_set / tentative_start_cleared).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = withUser<{ key: string }>(async (req, { user }, { key }) => {
  const body = (await req.json().catch(() => null)) as { date?: unknown } | null;
  if (!body || !("date" in body) || (body.date !== null && typeof body.date !== "string")) {
    return fail(400, 'Send {"date": "YYYY-MM-DD"} or {"date": null}.', "invalid_date");
  }
  const res = await setTentativeStart(user, key.toLowerCase(), body.date as string | null);
  return NextResponse.json({ key: res.key, tentativeStart: res.tentativeStart }, { headers: { "Cache-Control": "no-store" } });
});
