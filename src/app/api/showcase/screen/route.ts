import { NextResponse } from "next/server";
import { candidateIdFor, screenCandidate } from "@/lib/showcase/screen";
import { withDeadline } from "@/lib/showcase/deadline";
import { SP_VERSIONS, type SpCandidate, type SpScreen } from "@/lib/showcase/types";

/** Sample profiles, stage 1 for one row: resume text, links and fingerprint (no model). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  let body: { candidate?: SpCandidate };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const c = body.candidate;
  if (!c?.id || !c.sheetLinks) return NextResponse.json({ error: "A candidate is required." }, { status: 400 });
  const timeout = (): SpScreen => ({
    id: c.id,
    status: "error",
    error: "Timed out after 90s — re-run.",
    retryable: true,
    resumeUrl: c.resumeUrl,
    sha: "",
    source: "",
    links: { githubProfile: "", githubRepos: [], leetcode: "", codeforces: "", codechef: "", urls: [] },
    namedWithoutLink: [],
    inferred: [],
    fromSheet: [],
    candidateId: candidateIdFor(c),
    version: SP_VERSIONS.screen,
  });
  return NextResponse.json({ result: await withDeadline(screenCandidate(c), 90_000, timeout) });
}
