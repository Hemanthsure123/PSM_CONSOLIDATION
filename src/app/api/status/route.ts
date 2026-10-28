import { NextResponse } from "next/server";
import { databaseConfigured, describeDbError, query } from "@/lib/db/client";
import { env } from "@/lib/env";
import { htmlToPdf } from "@/lib/pdf";

/**
 * Readiness — behind sign-in like every other route. What an operator or an agent checks
 * before starting work: is the database reachable and how fresh is the eligible pool, which
 * integrations are configured (counts and yes/no only — never a key), and, with ?pdf=1, can
 * the server render a PDF (headless Chromium; takes a few seconds).
 *
 *   GET /api/status        → { ready, version, database, pool, integrations }
 *   GET /api/status?pdf=1  → … plus pdf: { ok, ms } | { ok: false, error }
 *
 * 200 when the core is ready (database reachable, or not configured at all), 503 otherwise.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const has = (name: string) => Boolean(process.env[name]?.trim());

export async function GET(req: Request) {
  const started = Date.now();
  const out: Record<string, unknown> = {
    version: (process.env.RENDER_GIT_COMMIT ?? process.env.APP_VERSION ?? "dev").slice(0, 12),
    uptimeSec: Math.round(process.uptime()),
    integrations: {
      googleServiceAccount: has("GCP_SERVICE_ACCOUNT_CLIENT_EMAIL") && has("GCP_SERVICE_ACCOUNT_PRIVATE_KEY"),
      googleDriveFolder: has("GOOGLE_DRIVE_FOLDER_ID"),
      bigQuery: has("GCP_PROJECT_ID") && has("BIGQUERY_DATASET_ID") && has("BIGQUERY_TABLE_ID"),
      geminiKeys: env.gemini.apiKeys.length,
      openaiKeys: env.openai.apiKeys.length,
      mistralKeys: env.mistral.apiKeys.length,
      groqKeys: env.groq.apiKeys.length,
      githubToken: has("GITHUB_TOKEN"),
      signIn: has("APP_BASIC_AUTH"),
    },
  };

  let dbOk = true;
  if (!databaseConfigured()) {
    out.database = { state: "not-configured" };
  } else {
    try {
      const t0 = Date.now();
      const runs = await query<{ product: string; last_ok: Date | null }>(
        `select p.product::text product,
                (select max(finished_at) from placement.sync_runs r where r.product = p.product and r.status = 'succeeded') last_ok
           from unnest(enum_range(null::placement.product)) p(product)`,
      );
      out.database = { state: "ok", ms: Date.now() - t0 };
      out.pool = Object.fromEntries(runs.map((r) => [r.product, { lastRefetch: r.last_ok ? new Date(r.last_ok).toISOString() : null }]));
    } catch (err) {
      dbOk = false;
      out.database = { state: "unavailable", error: describeDbError(err) };
    }
  }

  if (new URL(req.url).searchParams.has("pdf")) {
    try {
      const t0 = Date.now();
      const pdf = await htmlToPdf("<html><body><h1>Status check</h1></body></html>");
      out.pdf = { ok: pdf.length > 500, ms: Date.now() - t0, bytes: pdf.length };
    } catch (err) {
      out.pdf = { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : "PDF rendering failed" };
    }
  }

  out.ready = dbOk;
  out.ms = Date.now() - started;
  return NextResponse.json(out, { status: dbOk ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
