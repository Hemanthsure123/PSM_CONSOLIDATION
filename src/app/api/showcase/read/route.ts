import { NextResponse } from "next/server";
import { readCandidate } from "@/lib/showcase/reader";
import { withDeadline } from "@/lib/showcase/deadline";
import { SP_VERSIONS, type SpRead } from "@/lib/showcase/types";

/** Sample profiles: read one resume (one model call, checked against the text). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  let body: { id?: string; resumeUrl?: string; urls?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { id, resumeUrl } = body;
  if (!id || !resumeUrl) return NextResponse.json({ error: "id and resumeUrl are required." }, { status: 400 });
  const urls = Array.isArray(body.urls) ? body.urls.slice(0, 60).map(String) : [];
  const timeout = (): SpRead => ({
    id,
    status: "error",
    error: "Timed out after 240s — re-run.",
    retryable: true,
    nameOnResume: "",
    education: { degree: "", institution: "", year: "" },
    projects: [],
    jobs: [],
    skills: [],
    skillKeys: [],
    checks: [],
    model: "",
    transcribed: false,
    textChars: 0,
    version: SP_VERSIONS.read,
    readAt: new Date().toISOString(),
  });
  const read = readCandidate({ id, resumeUrl, urls }).then((r) => r.read);
  return NextResponse.json({ result: await withDeadline(read, 240_000, timeout) });
}
