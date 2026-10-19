import { NextResponse } from "next/server";
import { inspectDomainGithub, type GithubInspectResult } from "@/lib/domain-screen";

/**
 * Domain Shortlisting — deep-inspect ONE candidate's GitHub. A route handler so the
 * browser can inspect several candidates at once (server actions run one at a time).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const INSPECT_MS = 150_000;

const text = (v: unknown, max = 2_000) => (typeof v === "string" ? v.slice(0, max) : "");
/** A bounded list of short strings (anything else is dropped). */
const strings = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= maxLen).slice(0, maxItems) : [];

export async function POST(req: Request) {
  let body: { input?: Record<string, unknown>; domain?: unknown; mandatory?: unknown; refresh?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const i = body.input ?? {};
  const repos = strings(i.githubRepos, 20, 500);
  const input = {
    id: text(i.id, 200),
    githubProfile: text(i.githubProfile, 300),
    githubRepos: repos,
    claimedTechs: strings(i.claimedTechs, 60, 80),
  };
  if (!input.id || (!input.githubProfile && !repos.length)) {
    return NextResponse.json({ error: "A candidate id and a GitHub profile or repo link are required." }, { status: 400 });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<GithubInspectResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          id: input.id,
          status: "failed",
          note: `GitHub inspection timed out after ${INSPECT_MS / 1000}s.`,
          score: 0,
          matches: 0,
          techs: [],
          topRepos: [],
          commits2y: 0,
          lastDomainCommit: null,
          aiLikelihood: "",
          aiSummary: "",
          evidence: [],
          mandatoryGaps: [],
          claimedNotFound: [],
          checkedAt: new Date().toISOString(),
          fromCache: false,
          retryable: true,
        }),
      INSPECT_MS,
    );
  });
  const result = await Promise.race([
    inspectDomainGithub(input, text(body.domain, 3_000), text(body.mandatory, 1_000), { refresh: body.refresh === true }).finally(() =>
      clearTimeout(timer),
    ),
    timedOut,
  ]);
  return NextResponse.json({ result });
}
