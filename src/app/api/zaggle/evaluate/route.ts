import { NextResponse } from "next/server";
import { evaluateZgCandidate } from "@/lib/zaggle/evaluator";
import { failedZgEvaluation, type ZgCandidateInput, type ZgEvaluation } from "@/lib/zaggle/types";

/**
 * Zaggle (ZagMoney) SDE 1 Backend — screen ONE resume. A route handler (not a
 * server action) so the browser can keep many in flight at once.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Hard ceiling per candidate — the row comes back as a retryable error instead of hanging. */
const CANDIDATE_MS = 180_000;

export async function POST(req: Request) {
  let body: { candidate?: Partial<ZgCandidateInput> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const c = body.candidate;
  if (!c?.id || (typeof c.resumeUrl !== "string" && typeof c.resumeText !== "string")) {
    return NextResponse.json({ error: "Candidate id and a resume link or resume text are required." }, { status: 400 });
  }
  const candidate: ZgCandidateInput = {
    id: String(c.id),
    mobile: String(c.mobile ?? c.id),
    name: String(c.name ?? ""),
    resumeUrl: String(c.resumeUrl ?? ""),
    resumeText: typeof c.resumeText === "string" ? c.resumeText : undefined,
    batch: Number(c.batch) || 1,
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ZgEvaluation>((resolve) => {
    timer = setTimeout(
      () => resolve(failedZgEvaluation(candidate, `Timed out after ${CANDIDATE_MS / 1000}s — re-run this candidate.`, true, CANDIDATE_MS)),
      CANDIDATE_MS,
    );
  });
  const result = await Promise.race([evaluateZgCandidate(candidate).finally(() => clearTimeout(timer)), timedOut]);
  return NextResponse.json({ result });
}
