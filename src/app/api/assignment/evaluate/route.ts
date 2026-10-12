import { NextResponse } from "next/server";
import { evaluateCandidate } from "@/lib/assignment-evaluator";
import { bandThresholds } from "@/lib/assignment-scoring";
import type { AssignmentRunConfig, AssignmentSpec, CandidateInput } from "@/lib/assignment-types";

/**
 * Evaluate ONE candidate. A route handler (not a server action) on purpose:
 * the browser can keep several of these in flight at once — server actions
 * from one page are dispatched one at a time — so the client runs a sliding
 * window and a slow repository never holds up the others.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(req: Request) {
  let body: { spec?: AssignmentSpec; config?: AssignmentRunConfig; candidate?: CandidateInput };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { spec, config, candidate } = body;
  if (!spec?.criteria?.some((c) => c.enabled)) {
    return NextResponse.json({ error: "No enabled criteria to evaluate against." }, { status: 400 });
  }
  if (!candidate?.id || !candidate.githubUrl || !config) {
    return NextResponse.json({ error: "Candidate id, GitHub link and run config are required." }, { status: 400 });
  }
  const evaluation = await evaluateCandidate(candidate, spec, {
    ...config,
    thresholds: config.thresholds ?? bandThresholds(config.ctcBand),
  });
  return NextResponse.json({ evaluation });
}
