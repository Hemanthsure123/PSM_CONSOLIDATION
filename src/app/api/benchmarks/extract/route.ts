import { NextResponse } from "next/server";
import { extractBenchmarkProjects } from "@/lib/benchmark-evaluator";
import {
  failedBenchmark,
  type BenchmarkCandidateInput,
  type BenchmarkDomainProfile,
  type BenchmarkResult,
} from "@/lib/benchmark-types";

/**
 * Screen ONE resume for benchmark-quality projects in the run's domain. A route
 * handler (not a server action) so the browser can keep many in flight at once —
 * server actions from one page run one at a time.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Hard ceiling per resume — it comes back as a retryable error instead of hanging. */
const CANDIDATE_MS = 180_000;

const list = (v: unknown, max: number) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, max) : [];

/** The profile as the browser sent it — shape-checked, never trusted blindly. */
function readProfile(v: unknown): BenchmarkDomainProfile | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  const domain = typeof p.domain === "string" ? p.domain.trim().slice(0, 80) : "";
  const categories = list(p.categories, 8);
  if (!domain || !categories.length) return null;
  return {
    domain,
    input: typeof p.input === "string" ? p.input.slice(0, 200) : domain,
    focus: typeof p.focus === "string" ? p.focus.slice(0, 1500) : "",
    summary: typeof p.summary === "string" ? p.summary.slice(0, 500) : "",
    categories,
    advancedSignals: list(p.advancedSignals, 16),
    basicExamples: list(p.basicExamples, 14),
    keywords: list(p.keywords, 150),
  };
}

export async function POST(req: Request) {
  let body: { candidate?: Partial<BenchmarkCandidateInput>; profile?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const c = body.candidate;
  if (!c?.id || (typeof c.resumeUrl !== "string" && typeof c.resumeText !== "string")) {
    return NextResponse.json({ error: "Candidate id and a resume link or resume text are required." }, { status: 400 });
  }
  const profile = readProfile(body.profile);
  if (!profile) return NextResponse.json({ error: "The run's domain is missing — start a new run with a domain." }, { status: 400 });
  const candidate: BenchmarkCandidateInput = {
    id: String(c.id),
    label: String(c.label ?? c.id),
    resumeUrl: String(c.resumeUrl ?? ""),
    resumeText: typeof c.resumeText === "string" ? c.resumeText : undefined,
    batch: Number(c.batch) || 1,
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<BenchmarkResult>((resolve) => {
    timer = setTimeout(
      () => resolve(failedBenchmark(candidate, `Timed out after ${CANDIDATE_MS / 1000}s — re-run this resume.`, true, CANDIDATE_MS)),
      CANDIDATE_MS,
    );
  });
  const result = await Promise.race([extractBenchmarkProjects(candidate, profile).finally(() => clearTimeout(timer)), timedOut]);
  return NextResponse.json({ result });
}
