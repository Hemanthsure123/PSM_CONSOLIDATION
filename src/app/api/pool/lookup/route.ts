import { NextResponse } from "next/server";
import { databaseConfigured, describeDbError } from "@/lib/db/client";
import { lookupStandings, poolRecords } from "@/lib/pool/queries";
import { PRODUCTS, type PersonRecords, type Product } from "@/lib/pool/types";

/**
 * Eligible pool — internal standings for a batch of people. JSON body:
 * { people: [{ phone?, userId? }], include?: ("edge2" | "edge1" | "academy")[] }. Matches by
 * phone first, then by user id.
 * Returns { configured, standings: { "p:<phone>" | "u:<userId>": CandidateStanding } } and, when
 * `include` names products, records: { <candidateId>: { edge2?, edge1?, academy? } } — the
 * assessment details behind each matched standing (the Standing lookup's Requirements).
 * When the database isn't configured or can't be reached, the caller carries on
 * without standings (everyone is treated as external) and shows the reason.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_PEOPLE = 20_000;

export async function POST(req: Request) {
  if (!databaseConfigured()) return NextResponse.json({ configured: false, standings: {} });
  const body = (await req.json().catch(() => null)) as { people?: { phone?: unknown; userId?: unknown }[]; include?: unknown } | null;
  if (!Array.isArray(body?.people)) return NextResponse.json({ error: "Send { people: [{ phone, userId }] }." }, { status: 400 });
  if (body.people.length > MAX_PEOPLE) return NextResponse.json({ error: `At most ${MAX_PEOPLE} people per lookup.` }, { status: 413 });
  const people = body.people.map((p) => ({ phone: String(p?.phone ?? "").slice(0, 40), userId: String(p?.userId ?? "").slice(0, 80) }));
  const include = Array.isArray(body.include) ? PRODUCTS.filter((p) => (body.include as unknown[]).includes(p)) : ([] as Product[]);
  try {
    const standings = await lookupStandings(people);
    if (!include.length) return NextResponse.json({ configured: true, standings });
    const ids = [...new Set(Object.values(standings).map((s) => s.candidateId))];
    const records: Record<number, PersonRecords> = await poolRecords(ids, include);
    return NextResponse.json({ configured: true, standings, records });
  } catch (err) {
    console.error("[pool] lookup failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: describeDbError(err) }, { status: 503 });
  }
}
