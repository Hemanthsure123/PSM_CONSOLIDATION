import { NextResponse } from "next/server";
import { databaseConfigured, describeDbError } from "@/lib/db/client";
import { isAssessmentKey, isEligibilityFilter } from "@/lib/pool/scores/catalogue";
import { MARKS_NOT_SET_UP, MAX_FILTER_PEOPLE, filterPeople, marksTablesMissing } from "@/lib/pool/scores/queries";

/**
 * Standing lookup's "Find" mode — everyone assessed, by college, year of graduation, minimum marks
 * and job eligibility. JSON body: { colleges?: string[], yogs?: number[], assessment?: AssessmentKey,
 * minScore?: number, eligibility?: "all" | "eligible" | "not-eligible" } (at least one besides
 * "all"). Colleges match "contains", any of them. Returns { people: PersonRef[] (each with its
 * eligibility), total, truncated } — best score first when an assessment is given.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!databaseConfigured()) return NextResponse.json({ error: "The database isn't configured: set DATABASE_URL in .env.local." }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { colleges?: unknown; yogs?: unknown; assessment?: unknown; minScore?: unknown; eligibility?: unknown } | null;
  const colleges = Array.isArray(body?.colleges) ? body.colleges.map((c) => String(c ?? "").slice(0, 200)).filter((c) => c.trim()) : [];
  const yogs = Array.isArray(body?.yogs) ? body.yogs.map(Number).filter(Number.isInteger) : [];
  const assessment = isAssessmentKey(body?.assessment) ? body.assessment : undefined;
  const minScore = typeof body?.minScore === "number" && Number.isFinite(body.minScore) ? body.minScore : undefined;
  const eligibility = isEligibilityFilter(body?.eligibility) ? body.eligibility : "all";
  if (!colleges.length && !yogs.length && !assessment && eligibility === "all") {
    return NextResponse.json({ error: "Pick a college, a year of graduation, an assessment or eligibility to filter by." }, { status: 400 });
  }
  try {
    const { people, total } = await filterPeople({ colleges, yogs, assessment, minScore, eligibility });
    return NextResponse.json({ people, total, truncated: total > MAX_FILTER_PEOPLE });
  } catch (err) {
    if (marksTablesMissing(err)) return NextResponse.json({ error: MARKS_NOT_SET_UP }, { status: 503 });
    console.error("[pool] find failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: describeDbError(err) }, { status: 503 });
  }
}
