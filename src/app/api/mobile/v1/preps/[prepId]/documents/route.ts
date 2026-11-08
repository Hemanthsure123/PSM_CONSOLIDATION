import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { type StartBody, startDocRun } from "@/lib/prepdocs/service";
import { documentOverview } from "@/lib/team/prep";

/**
 * GET /preps/{prepId}/documents — the job + round's prep document(s) (link, version, whether newer
 * drill-downs or transcripts exist), the sources it can be built from, the sections, the last
 * website / LinkedIn, the team account's state, the run in progress and the WhatsApp draft.
 * POST /preps/{prepId}/documents { kind: "gdoc"|"notion", sources: [url], website?, linkedin?, sections: [id] }
 * — creates the document, or rewrites it when one exists (reading its current text first, so
 * manual edits are kept). Returns the run (202); poll GET /preps/runs/{runId}.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser<{ prepId: string }>(async (_req, { user }, { prepId }) => {
  if (!/^[0-9a-f]{24}$/.test(prepId)) return fail(404, "This prep doesn't exist.", "not_found");
  return NextResponse.json(await documentOverview(user, prepId), { headers: { "Cache-Control": "no-store" } });
});

export const POST = withUser<{ prepId: string }>(async (req, { user }, { prepId }) => {
  if (!/^[0-9a-f]{24}$/.test(prepId)) return fail(404, "This prep doesn't exist.", "not_found");
  const body = await readJson<StartBody>(req);
  if (!body) return fail(400, "Send a JSON body.", "invalid_body");
  return NextResponse.json(await startDocRun(user, prepId, body), { status: 202 });
});
