import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { jobView } from "@/lib/mobile/preps/service";

/** GET /preps/jobs/{jobId} — one job's interviews (company view): rounds, candidates, statuses, links. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser<{ jobId: string }>(async (_req, { user }, { jobId }) => {
  if (!/^[0-9a-zA-Z-]{6,64}$/.test(jobId)) return fail(404, "This job doesn't exist.", "not_found");
  return NextResponse.json(await jobView(user, jobId), { headers: { "Cache-Control": "no-store" } });
});
