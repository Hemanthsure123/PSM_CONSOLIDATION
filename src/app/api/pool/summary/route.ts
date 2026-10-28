import { NextResponse } from "next/server";
import { describeDbError } from "@/lib/db/client";
import { poolSummary } from "@/lib/pool/queries";

/** Eligible pool — the dashboard's counts, sources and recent syncs. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ summary: await poolSummary() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[pool] summary failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: describeDbError(err) }, { status: 503 });
  }
}
