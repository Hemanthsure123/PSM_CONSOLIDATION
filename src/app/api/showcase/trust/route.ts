import { NextResponse } from "next/server";
import { trustCandidate, type TrustRequest } from "@/lib/showcase/trust";
import { withDeadline } from "@/lib/showcase/deadline";
import { SP_VERSIONS, type SpTrust } from "@/lib/showcase/types";

/** Sample profiles: the trust agent for one finalist. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  let body: TrustRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body?.id || !body.resumeUrl) return NextResponse.json({ error: "id and resumeUrl are required." }, { status: 400 });
  const timeout = (): SpTrust => ({ id: body.id, identity: null, review: null, error: "Timed out after 180s — re-run.", retryable: true, version: SP_VERSIONS.trust });
  return NextResponse.json({ result: await withDeadline(trustCandidate(body), 180_000, timeout) });
}
