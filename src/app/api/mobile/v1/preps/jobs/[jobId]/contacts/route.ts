import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { jobContacts } from "@/lib/team/kit";

/** GET /preps/jobs/{jobId}/contacts — every candidate of the job with their looked-up email (for a guidance session). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser<{ jobId: string }>(async (_req, _ctx, { jobId }) => {
  const id = decodeURIComponent(jobId).trim();
  if (!id || id.length > 80) return fail(404, "This job doesn't exist.", "not_found");
  return NextResponse.json({ items: await jobContacts(id) }, { headers: { "Cache-Control": "no-store" } });
});
