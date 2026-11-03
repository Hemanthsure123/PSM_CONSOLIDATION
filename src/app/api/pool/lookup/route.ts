import { NextResponse } from "next/server";
import { databaseConfigured, describeDbError } from "@/lib/db/client";
import { lookupStandings, poolRecords } from "@/lib/pool/queries";
import { assessedOutsidePool, marksTablesMissing, profilesFor, scoresFor } from "@/lib/pool/scores/queries";
import { PRODUCTS, type PersonRecords, type Product } from "@/lib/pool/types";

/**
 * Eligible pool — internal standings for a batch of people. JSON body:
 * { people: [{ phone?, userId? }], include?: ("edge2" | "edge1" | "academy" | "scores" | "profile")[] }.
 * Matches by phone first, then by user id.
 * Returns { configured, standings: { "p:<phone>" | "u:<userId>": CandidateStanding }, assessed }:
 *  - assessed: { "p:…" | "u:…": PersonRef } — people with assessment marks who aren't in the
 *    eligible pool (no standing, so not eligible for job opportunities);
 * and, when `include` asks for them, per candidate id of all of these people:
 *  - records: { edge2?, edge1?, academy? } — the products' assessment details;
 *  - scores: AssessmentScore[] — every final mark (with verdict, date, recording), oldest first;
 *  - profiles: CandidateProfile — year of graduation, college, degree.
 * When the database isn't configured or can't be reached, the caller carries on
 * without standings (everyone is treated as external) and shows the reason.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_PEOPLE = 20_000;

/** The value of `work`, or `fallback` when the marks tables aren't migrated yet (any other error is thrown). */
async function withoutMarksTables<T, F>(work: Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await work;
  } catch (err) {
    if (marksTablesMissing(err)) return fallback;
    throw err;
  }
}

export async function POST(req: Request) {
  if (!databaseConfigured()) return NextResponse.json({ configured: false, standings: {} });
  const body = (await req.json().catch(() => null)) as { people?: { phone?: unknown; userId?: unknown }[]; include?: unknown } | null;
  if (!Array.isArray(body?.people)) return NextResponse.json({ error: "Send { people: [{ phone, userId }] }." }, { status: 400 });
  if (body.people.length > MAX_PEOPLE) return NextResponse.json({ error: `At most ${MAX_PEOPLE} people per lookup.` }, { status: 413 });
  const people = body.people.map((p) => ({ phone: String(p?.phone ?? "").slice(0, 40), userId: String(p?.userId ?? "").slice(0, 80) }));
  const asked = Array.isArray(body.include) ? (body.include as unknown[]) : [];
  const include = PRODUCTS.filter((p) => asked.includes(p)) as Product[];
  const wantScores = asked.includes("scores");
  const wantProfile = asked.includes("profile");
  try {
    // Marks and profiles live in migrations 004 / 005's tables: until they are applied, the
    // lookup carries on with standings and records only.
    const [standings, assessed] = await Promise.all([lookupStandings(people), withoutMarksTables(assessedOutsidePool(people), {})]);
    if (!include.length && !wantScores && !wantProfile) return NextResponse.json({ configured: true, standings, assessed });
    const ids = [...new Set([...Object.values(standings).map((s) => s.candidateId), ...Object.values(assessed).map((p) => p.candidateId)])];
    const [records, scores, profiles] = await Promise.all([
      include.length ? poolRecords(ids, include) : Promise.resolve({} as Record<number, PersonRecords>),
      wantScores ? withoutMarksTables(scoresFor(ids), undefined) : Promise.resolve(undefined),
      wantProfile ? withoutMarksTables(profilesFor(ids), undefined) : Promise.resolve(undefined),
    ]);
    return NextResponse.json({ configured: true, standings, assessed, records, ...(scores ? { scores } : {}), ...(profiles ? { profiles } : {}) });
  } catch (err) {
    console.error("[pool] lookup failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: describeDbError(err) }, { status: 503 });
  }
}
