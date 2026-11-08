import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { poolDetail, type PoolUpdateInput, updatePoolCandidate } from "@/lib/mobile/pool/service";

/**
 * GET /pool/{uid} — one candidate: profile, every assessment attempt, interviews, resumes, meetings
 * and history. PATCH /pool/{uid} { version, priority?, track?, tags? } — the mentor's choices
 * (409 version_conflict when someone else changed them first). Both return the candidate.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser<{ uid: string }>(async (_req, { user }, { uid }) =>
  NextResponse.json(await poolDetail(user, uid), { headers: { "Cache-Control": "no-store" } }),
);

export const PATCH = withUser<{ uid: string }>(async (req, { user }, { uid }) => {
  const body = await readJson<PoolUpdateInput>(req);
  if (!body || typeof body !== "object") return fail(400, "Send a JSON body.", "invalid_body");
  return NextResponse.json(await updatePoolCandidate(user, uid, body));
});
