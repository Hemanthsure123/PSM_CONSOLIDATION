import { NextResponse } from "next/server";
import { inputHash, runBucketing } from "@/lib/bucketing/graph";
import { TIMEOUTS, normalizeStage, normalizeTrack } from "@/lib/bucketing/config";
import { failedBucketingResult, type BucketingCandidateInput, type BucketingResult } from "@/lib/bucketing/types";

/**
 * Bucket ONE candidate: runs the Candidate Bucketing LangGraph workflow and
 * returns its result. A route handler (not a server action) so the browser can
 * keep several candidates in flight — server actions from one page run one at a
 * time — and a slow GitHub audit never holds up the others.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  let body: { candidate?: Partial<Record<keyof BucketingCandidateInput, unknown>> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const c = body.candidate;
  if (!c?.id || (typeof c.resumeUrl !== "string" && typeof c.resumeText !== "string")) {
    return NextResponse.json({ error: "Candidate id and a resume link or resume text are required." }, { status: 400 });
  }
  const stage = normalizeStage(String(c.stage ?? ""));
  if (!stage) return NextResponse.json({ error: `Unrecognised stage "${String(c.stage ?? "")}" — use Assessment cleared, TR-1 cleared or TR-2 cleared.` }, { status: 400 });
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const candidate: BucketingCandidateInput = {
    id: String(c.id),
    mobile: text(c.mobile) || String(c.id),
    name: text(c.name),
    resumeUrl: text(c.resumeUrl),
    resumeText: typeof c.resumeText === "string" ? c.resumeText : undefined,
    stage,
    track: stage === "TR2" ? normalizeTrack(text(c.track)) : null,
    githubUrl: text(c.githubUrl) || undefined,
    leetcodeUrl: text(c.leetcodeUrl) || undefined,
    codechefUrl: text(c.codechefUrl) || undefined,
    codeforcesUrl: text(c.codeforcesUrl) || undefined,
    batch: Number(c.batch) || 1,
  };

  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<BucketingResult>((resolve) => {
    timer = setTimeout(
      () => resolve(failedBucketingResult(candidate, `Timed out after ${Math.round(TIMEOUTS.candidateMs / 1000)}s — re-run this candidate.`, TIMEOUTS.candidateMs)),
      TIMEOUTS.candidateMs,
    );
  });
  const work = runBucketing(candidate).catch((err) => {
    console.error(`[bucketing] ${candidate.mobile} failed:`, err);
    return failedBucketingResult(candidate, err instanceof Error ? err.message.slice(0, 300) : "Bucketing failed.", Date.now() - started);
  });
  const result = await Promise.race([work.finally(() => clearTimeout(timer)), timedOut]);
  return NextResponse.json({ result: result.inputHash ? result : { ...result, inputHash: inputHash(candidate) } });
}
