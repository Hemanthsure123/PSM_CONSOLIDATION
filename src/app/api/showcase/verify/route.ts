import { NextResponse } from "next/server";
import { verifyCandidate, type VerifyRequest } from "@/lib/showcase/verify";
import { withDeadline } from "@/lib/showcase/deadline";
import { SP_VERSIONS, type SpVerify } from "@/lib/showcase/types";

/** Sample profiles: prove one finalist's flagship projects on GitHub and complete their DSA. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  let body: VerifyRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body?.id || !Array.isArray(body.projects)) return NextResponse.json({ error: "id and projects are required." }, { status: 400 });
  const timeout = (): SpVerify => ({
    id: body.id,
    status: "error",
    error: "Timed out after 270s — re-run.",
    retryable: true,
    proofs: [],
    dsa: {},
    version: SP_VERSIONS.verify,
    checkedAt: new Date().toISOString(),
  });
  return NextResponse.json({ result: await withDeadline(verifyCandidate(body), 270_000, timeout) });
}
