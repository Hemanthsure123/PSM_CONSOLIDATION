import { NextResponse } from "next/server";
import { evaluateAcCandidate } from "@/lib/academy/evaluator";
import { failedAcEvaluation, type AcEvalRequest, type AcEvaluation } from "@/lib/academy/types";

/**
 * Academy bucketing — read ONE candidate (resume, GitHub, coding profiles). A
 * route handler (not a server action) so the browser can keep several in flight.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Hard ceiling per candidate — the row comes back as a retryable error instead of hanging. */
const CANDIDATE_MS = 240_000;

export async function POST(req: Request) {
  let body: { candidate?: Partial<AcEvalRequest> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const c = body.candidate;
  if (!c?.id || typeof c.resumeUrl !== "string") {
    return NextResponse.json({ error: "Candidate id and resume link are required." }, { status: 400 });
  }
  const ctx = c.context;
  const candidate: AcEvalRequest = {
    id: String(c.id),
    name: String(c.name ?? ""),
    email: typeof c.email === "string" ? c.email : "",
    mobile: typeof c.mobile === "string" ? c.mobile : "",
    resumeUrl: c.resumeUrl,
    github: c.github !== false,
    dsa: c.dsa !== false,
    trust: c.trust === true,
    context: {
      competencies: Array.isArray(ctx?.competencies) ? ctx.competencies.slice(0, 12) : [],
      interviews: Array.isArray(ctx?.interviews) ? ctx.interviews.slice(0, 12) : [],
    },
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<AcEvaluation>((resolve) => {
    timer = setTimeout(
      () => resolve(failedAcEvaluation(candidate, `Timed out after ${CANDIDATE_MS / 1000}s — re-run this candidate.`, true, CANDIDATE_MS)),
      CANDIDATE_MS,
    );
  });
  const result = await Promise.race([evaluateAcCandidate(candidate).finally(() => clearTimeout(timer)), timedOut]);
  return NextResponse.json({ result });
}
