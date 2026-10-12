import { NextResponse } from "next/server";
import { evaluateQaCandidate } from "@/lib/qa-evaluator";
import { failedEvaluation, type QaCandidateInput, type QaEvaluation } from "@/lib/qa-types";

/**
 * Screen ONE candidate's resume for the QA role. A route handler (not a server
 * action) so the browser can keep many in flight at once — server actions from
 * one page run one at a time — and a slow resume never holds up the others.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Hard ceiling per candidate — the row comes back as a retryable error instead of hanging. */
const CANDIDATE_MS = 150_000;

export async function POST(req: Request) {
  let body: { candidate?: Partial<QaCandidateInput> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const c = body.candidate;
  if (!c?.id || (typeof c.resumeUrl !== "string" && typeof c.resumeText !== "string")) {
    return NextResponse.json({ error: "Candidate id and a resume link or resume text are required." }, { status: 400 });
  }
  const candidate: QaCandidateInput = {
    id: String(c.id),
    mobile: String(c.mobile ?? c.id),
    name: String(c.name ?? ""),
    resumeUrl: String(c.resumeUrl ?? ""),
    resumeText: typeof c.resumeText === "string" ? c.resumeText : undefined,
    batch: Number(c.batch) || 1,
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<QaEvaluation>((resolve) => {
    timer = setTimeout(
      () => resolve(failedEvaluation(candidate, `Timed out after ${CANDIDATE_MS / 1000}s — re-run this candidate.`, true, CANDIDATE_MS)),
      CANDIDATE_MS,
    );
  });
  const result = await Promise.race([evaluateQaCandidate(candidate).finally(() => clearTimeout(timer)), timedOut]);
  return NextResponse.json({ result });
}
