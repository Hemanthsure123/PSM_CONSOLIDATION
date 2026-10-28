import { NextResponse } from "next/server";
import { databaseConfigured, query } from "@/lib/db/client";

/**
 * Liveness — the one route that needs no sign-in (middleware.ts lets it through), so the
 * host's health check, an uptime monitor or an agent waiting for a sleeping instance to wake
 * can poll it. It says only that the app is up and which build is running:
 *
 *   GET /api/health        → { status: "ok", version, startedAt, uptimeSec }
 *   GET /api/health?db=1   → … plus db: "ok" | "unavailable" | "not-configured"
 *
 * Always 200 while the app runs (a database outage isn't an app outage). The database ping is
 * a `select 1`, shared by every caller for 30 s, so polling can't load the database. Deeper
 * checks (PDF rendering, which integrations are configured) live behind sign-in at /api/status.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DbState = "ok" | "unavailable" | "not-configured";

const STARTED_AT = new Date().toISOString();
/** Render sets RENDER_GIT_COMMIT for every deploy. */
const VERSION = (process.env.RENDER_GIT_COMMIT ?? process.env.APP_VERSION ?? "dev").slice(0, 12);
const DB_TTL_MS = 30_000;
const DB_TIMEOUT_MS = 8_000;

const g = globalThis as unknown as { __healthDb?: { at: number; state: Promise<DbState> } };

async function pingDb(): Promise<DbState> {
  if (!databaseConfigured()) return "not-configured";
  try {
    await Promise.race([
      query("select 1"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), DB_TIMEOUT_MS)),
    ]);
    return "ok";
  } catch {
    return "unavailable";
  }
}

export async function GET(req: Request) {
  const body: Record<string, unknown> = { status: "ok", version: VERSION, startedAt: STARTED_AT, uptimeSec: Math.round(process.uptime()) };
  if (new URL(req.url).searchParams.has("db")) {
    const cached = g.__healthDb;
    if (!cached || Date.now() - cached.at > DB_TTL_MS) g.__healthDb = { at: Date.now(), state: pingDb() };
    body.db = await g.__healthDb!.state;
  }
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
