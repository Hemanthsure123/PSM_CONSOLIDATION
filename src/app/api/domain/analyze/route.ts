import { NextResponse } from "next/server";
import { screenDomainCandidate, type DomainScreenResult } from "@/lib/domain-screen";
import type { DomainCandidateRow } from "@/lib/types";

/**
 * Domain Shortlisting — screen ONE candidate. A route handler (not a server action)
 * so the browser can keep many candidates in flight at once; server actions from one
 * page run one at a time, which is what made big sheets slow.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Hard ceiling per candidate — it comes back as a retryable error instead of hanging a slot. */
const CANDIDATE_MS = 180_000;

const text = (v: unknown, max = 2_000) => (typeof v === "string" ? v.slice(0, max) : "");

export async function POST(req: Request) {
  let body: { row?: Record<string, unknown>; opts?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const r = body.row ?? {};
  const o = body.opts ?? {};
  if (!text(r.id) || !text(r.resumeUrl) || !text(o.domain)) {
    return NextResponse.json({ error: "A candidate id, a resume link and the domain are required." }, { status: 400 });
  }
  const row: DomainCandidateRow = {
    id: text(r.id, 200),
    name: text(r.name, 200),
    resumeUrl: text(r.resumeUrl),
    assessmentReport: text(r.assessmentReport),
    tr1Panelist: text(r.tr1Panelist, 200),
    tr1PanelLinkedin: text(r.tr1PanelLinkedin),
    tr1Recording: text(r.tr1Recording),
    tr2Panelist: text(r.tr2Panelist, 200),
    tr2PanelLinkedin: text(r.tr2PanelLinkedin),
    tr2Recording: text(r.tr2Recording),
    placedCompany: text(r.placedCompany, 200),
    ctc: text(r.ctc, 100),
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<DomainScreenResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, kind: "error", error: `Timed out after ${CANDIDATE_MS / 1000}s — retrying.`, retryable: true }),
      CANDIDATE_MS,
    );
  });
  const result = await Promise.race([
    screenDomainCandidate(row, {
      domain: text(o.domain, 3_000),
      mandatory: text(o.mandatory, 1_000),
      useDsa: Boolean(o.useDsa),
      useGithub: Boolean(o.useGithub),
      requireExperience: Boolean(o.requireExperience),
      checkPresentation: Boolean(o.checkPresentation),
    }).finally(() => clearTimeout(timer)),
    timedOut,
  ]);
  return NextResponse.json({ result });
}
