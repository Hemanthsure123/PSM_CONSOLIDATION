import { NextResponse } from "next/server";
import { analyzeExperience } from "@/lib/experience-analyzer";
import type { ExperienceCandidateInput, ExperienceResult } from "@/lib/experience-types";

/**
 * Analyse ONE candidate's resume. A route handler (not a server action) so the
 * browser can keep several in flight at once — server actions from one page run
 * one at a time — and a slow resume never holds up the others.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Hard ceiling per candidate — the row comes back as an error instead of hanging. */
const CANDIDATE_MS = 180_000;

export async function POST(req: Request) {
  let body: { candidate?: ExperienceCandidateInput };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const c = body.candidate;
  if (!c?.id || typeof c.resumeUrl !== "string") {
    return NextResponse.json({ error: "Candidate id and resume link are required." }, { status: 400 });
  }
  const candidate: ExperienceCandidateInput = {
    id: String(c.id),
    mobile: String(c.mobile ?? ""),
    name: String(c.name ?? ""),
    resumeUrl: String(c.resumeUrl),
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ExperienceResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          id: candidate.id,
          mobile: candidate.mobile,
          name: candidate.name,
          resumeUrl: candidate.resumeUrl,
          status: "error",
          error: `Timed out after ${CANDIDATE_MS / 60_000} min — re-run this candidate.`,
          entries: [],
          totalMonths: null,
          internshipMonths: null,
          model: "",
          durationMs: CANDIDATE_MS,
          analyzedAt: new Date().toISOString(),
        }),
      CANDIDATE_MS,
    );
  });
  const result = await Promise.race([analyzeExperience(candidate).finally(() => clearTimeout(timer)), timedOut]);
  return NextResponse.json({ result });
}
