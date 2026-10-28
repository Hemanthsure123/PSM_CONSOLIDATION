import { NextResponse } from "next/server";
import { reviewDomainProjects } from "@/lib/domain-project-review";
import type { DomainProjectReviewResult } from "@/lib/types";

/**
 * Domain Shortlisting — deep review of ONE candidate's top domain repositories (folder and
 * file level, against the domain and its mandatory requirements). A route handler so the
 * browser can review several candidates at once.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const REVIEW_MS = 240_000;

const text = (v: unknown, max = 2_000) => (typeof v === "string" ? v.slice(0, max) : "");

export async function POST(req: Request) {
  let body: { input?: Record<string, unknown>; domain?: unknown; mandatory?: unknown; refresh?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const i = body.input ?? {};
  const repos = (Array.isArray(i.repos) ? i.repos : [])
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      return {
        url: text(o.url, 500),
        name: text(o.name, 200),
        matchPct: Math.max(0, Math.min(100, Number(o.matchPct) || 0)),
        techs: (Array.isArray(o.techs) ? o.techs : []).filter((t): t is string => typeof t === "string" && t.length <= 60).slice(0, 20),
      };
    })
    .filter((r) => /^https?:\/\/(www\.)?github\.com\//i.test(r.url))
    .slice(0, 3);
  const id = text(i.id, 200);
  if (!id || !repos.length) return NextResponse.json({ error: "A candidate id and at least one GitHub repo are required." }, { status: 400 });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<DomainProjectReviewResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          id,
          status: "failed",
          note: `The project review timed out after ${REVIEW_MS / 1000}s.`,
          score: 0,
          reviews: [],
          reviewedAt: new Date().toISOString(),
          fromCache: false,
          retryable: true,
        }),
      REVIEW_MS,
    );
  });
  try {
    const result = await Promise.race([
      reviewDomainProjects({ id, repos }, text(body.domain, 3_000), text(body.mandatory, 1_000), { refresh: body.refresh === true }).finally(() =>
        clearTimeout(timer),
      ),
      timedOut,
    ]);
    return NextResponse.json({ result });
  } catch (err) {
    console.error("[domain-review] crashed:", err);
    return NextResponse.json({ error: "The project review failed — try again." }, { status: 500 });
  }
}
