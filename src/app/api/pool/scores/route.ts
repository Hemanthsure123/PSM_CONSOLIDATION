import { NextResponse } from "next/server";
import { describeDbError } from "@/lib/db/client";
import { MARKS_NOT_SET_UP, marksTablesMissing, scoresSummary } from "@/lib/pool/scores/queries";

/** Assessment scores — per-assessment counts, colleges and years (the lookup's filter), the readable sheets, recent imports. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ summary: await scoresSummary() });
  } catch (err) {
    if (marksTablesMissing(err)) return NextResponse.json({ error: MARKS_NOT_SET_UP }, { status: 503 });
    console.error("[scores] summary failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: describeDbError(err) }, { status: 503 });
  }
}
