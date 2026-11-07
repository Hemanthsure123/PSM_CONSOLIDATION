import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { type StartBody, startDocRun } from "@/lib/prepdocs/service";

/**
 * POST /preps/{prepId}/documents { kind: "gdoc"|"notion", sources: [url], website?, linkedin?, sections: [id] }
 * — creates the job + round's prep document, or updates it when one exists. Returns the run
 * (202); poll GET /preps/runs/{runId} until it is done or failed.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withUser<{ prepId: string }>(async (req, { user }, { prepId }) => {
  if (!/^[0-9a-f]{24}$/.test(prepId)) return fail(404, "This prep doesn't exist.", "not_found");
  const body = await readJson<StartBody>(req);
  if (!body) return fail(400, "Send a JSON body.", "invalid_body");
  return NextResponse.json(await startDocRun(user, prepId, body), { status: 202 });
});
