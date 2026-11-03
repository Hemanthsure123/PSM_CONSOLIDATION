import { NextResponse } from "next/server";
import { databaseConfigured } from "@/lib/db/client";
import { scoreSheets } from "@/lib/pool/scores/sources";
import { syncScoreSheet } from "@/lib/pool/scores/sync";

/**
 * Assessment scores — refetch one readable Google Sheets tab. JSON body: { sheet, allowShrink? }
 * (sheet = an id from the summary's `sheets`). The screen calls this once per tab, in turn.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!databaseConfigured()) {
    return NextResponse.json({ error: "The database isn't configured: set DATABASE_URL in .env.local." }, { status: 503 });
  }
  const body = (await req.json().catch(() => null)) as { sheet?: string; allowShrink?: boolean } | null;
  const ids = scoreSheets().map((s) => s.id);
  if (!body?.sheet || !ids.includes(body.sheet)) return NextResponse.json({ error: `Say which sheet to refetch: ${ids.join(", ")}.` }, { status: 400 });
  const result = await syncScoreSheet(body.sheet, { allowShrink: body.allowShrink === true });
  return NextResponse.json({ result }, { status: result.ok ? 200 : result.needsConfirm ? 409 : 502 });
}
