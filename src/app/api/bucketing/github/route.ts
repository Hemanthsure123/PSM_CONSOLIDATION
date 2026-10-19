import { NextResponse } from "next/server";
import { checkGithubAccess } from "@/lib/github-analysis";

/**
 * Pre-run GitHub check for Candidate Bucketing: is the token usable, and how
 * many REST calls are left this hour? Costs no quota. The browser pauses a run
 * (instead of failing candidates) when the budget runs low.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await checkGithubAccess());
}
