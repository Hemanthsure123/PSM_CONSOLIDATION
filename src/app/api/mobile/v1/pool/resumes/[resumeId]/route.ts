import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { removeResume, updateResume } from "@/lib/mobile/pool/resumes";

/** PATCH /pool/resumes/{id} { stack?, best?, note? } · DELETE /pool/resumes/{id} — both return the candidate. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = withUser<{ resumeId: string }>(async (req, { user }, { resumeId }) => {
  const body = await readJson<{ stack?: unknown; best?: unknown; note?: unknown }>(req);
  if (!body || typeof body !== "object") return fail(400, "Send a JSON body.", "invalid_body");
  return NextResponse.json(await updateResume(user, resumeId, body));
});

export const DELETE = withUser<{ resumeId: string }>(async (_req, { user }, { resumeId }) => NextResponse.json(await removeResume(user, resumeId)));
