import { NextResponse } from "next/server";
import { judgeCandidate, type JudgeRequest } from "@/lib/showcase/profile-judge";
import { withDeadline } from "@/lib/showcase/deadline";
import { SP_VERSIONS, type SpJudge } from "@/lib/showcase/types";

/** Sample profiles from job descriptions: the strict profile-fit judge for one candidate (every profile at once). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  let body: JudgeRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body?.id || !body.resumeUrl || !Array.isArray(body.profiles) || !body.profiles.length) {
    return NextResponse.json({ error: "id, resumeUrl and the profiles are required." }, { status: 400 });
  }
  const r: JudgeRequest = {
    id: String(body.id),
    resumeUrl: String(body.resumeUrl),
    readAt: String(body.readAt ?? ""),
    basedOn: String(body.basedOn ?? ""),
    profiles: body.profiles.slice(0, 5),
    projects: Array.isArray(body.projects) ? body.projects.slice(0, 25) : [],
    jobs: Array.isArray(body.jobs) ? body.jobs.slice(0, 15) : [],
  };
  const timeout = (): SpJudge => ({
    id: r.id,
    status: "error",
    error: "Timed out after 180s — re-run.",
    retryable: true,
    basedOn: r.basedOn,
    readAt: r.readAt,
    profiles: {},
    model: "",
    version: SP_VERSIONS.judge,
    checkedAt: new Date().toISOString(),
  });
  return NextResponse.json({ result: await withDeadline(judgeCandidate(r), 180_000, timeout) });
}
