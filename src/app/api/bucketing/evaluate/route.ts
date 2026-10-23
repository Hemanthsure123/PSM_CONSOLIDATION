import { NextResponse } from "next/server";
import { inputHash, runBucketing } from "@/lib/bucketing/graph";
import { TIMEOUTS, normalizeStage, normalizeTrack, normalizeVerdict, type Track, type Tr2Verdict } from "@/lib/bucketing/config";
import {
  failedBucketingResult,
  type BucketingCandidateInput,
  type BucketingResult,
  type InterviewRecord,
  type InterviewTr2,
} from "@/lib/bucketing/types";

/**
 * Bucket ONE candidate: runs the Candidate Bucketing LangGraph workflow and
 * returns its result. A route handler (not a server action) so the browser can
 * keep several candidates in flight — server actions from one page run one at a
 * time — and a slow GitHub audit never holds up the others.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  let body: { candidate?: Partial<Record<keyof BucketingCandidateInput, unknown>> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const c = body.candidate;
  // A candidate without a resume link is still evaluated: a TR-2 hire is placed by the interview alone.
  if (!c?.id) return NextResponse.json({ error: "Candidate id is required." }, { status: 400 });
  const stage = normalizeStage(String(c.stage ?? ""));
  if (!stage) return NextResponse.json({ error: `Unrecognised stage "${String(c.stage ?? "")}" — use Assessment cleared, TR-1 cleared or TR-2 cleared.` }, { status: 400 });
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const candidate: BucketingCandidateInput = {
    id: String(c.id),
    mobile: text(c.mobile) || String(c.id),
    name: text(c.name),
    resumeUrl: text(c.resumeUrl),
    resumeText: typeof c.resumeText === "string" ? c.resumeText : undefined,
    stage,
    track: stage === "TR2" ? normalizeTrack(text(c.track)) : null,
    verdict: stage === "TR2" ? normalizeVerdict(text(c.verdict)) : null,
    interview: coerceInterview(c.interview),
    externalId: text(c.externalId).slice(0, 64) || undefined,
    email: text(c.email).slice(0, 120) || undefined,
    college: text(c.college).slice(0, 160) || undefined,
    githubUrl: text(c.githubUrl) || undefined,
    leetcodeUrl: text(c.leetcodeUrl) || undefined,
    codechefUrl: text(c.codechefUrl) || undefined,
    codeforcesUrl: text(c.codeforcesUrl) || undefined,
    batch: Number(c.batch) || 1,
  };

  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<BucketingResult>((resolve) => {
    timer = setTimeout(
      () => resolve(failedBucketingResult(candidate, `Timed out after ${Math.round(TIMEOUTS.candidateMs / 1000)}s — re-run this candidate.`, TIMEOUTS.candidateMs)),
      TIMEOUTS.candidateMs,
    );
  });
  const work = runBucketing(candidate).catch((err) => {
    console.error(`[bucketing] ${candidate.mobile} failed:`, err);
    return failedBucketingResult(candidate, err instanceof Error ? err.message.slice(0, 300) : "Bucketing failed.", Date.now() - started);
  });
  const result = await Promise.race([work.finally(() => clearTimeout(timer)), timedOut]);
  return NextResponse.json({ result: result.inputHash ? result : { ...result, inputHash: inputHash(candidate) } });
}

/** The interview record from the browser, re-checked field by field (it is untrusted input). */
function coerceInterview(v: unknown): InterviewRecord | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const obj = (x: unknown) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const track = (x: unknown): Track | null => (typeof x === "string" ? normalizeTrack(x) : null);
  const verdict = (x: unknown): Tr2Verdict | null => (typeof x === "string" ? normalizeVerdict(x) : null);
  const tr2 = (Array.isArray(o.tr2) ? o.tr2 : [])
    .map((t) => ({ track: track(obj(t).track), verdict: verdict(obj(t).verdict) }))
    .filter((t): t is InterviewTr2 => Boolean(t.track && t.verdict));
  const t1 = obj(o.tr1);
  const as = obj(o.assessment);
  const tracks = (x: unknown) => (Array.isArray(x) ? x : []).map(track).filter((t): t is Track => Boolean(t));
  const word = (x: unknown, max = 40) => (typeof x === "string" ? x.trim().toLowerCase().slice(0, max) : "");
  const di = obj(o.dsaInterview);
  const jr = obj(o.journey);
  return {
    tr2,
    tr2Rejected: tracks(o.tr2Rejected),
    tr2Pending: tracks(o.tr2Pending),
    combined: verdict(o.combined),
    combinedRejected: o.combinedRejected === true,
    combinedState: word(o.combinedState),
    interviewPath: word(o.interviewPath),
    currentStage: word(o.currentStage),
    dsaInterview: { qualifying: word(di.qualifying), dsaScore: n(di.dsaScore), csScore: n(di.csScore) },
    journey: { status: word(jr.status), reason: word(jr.reason, 60), notes: typeof jr.notes === "string" ? jr.notes.slice(0, 200) : "" },
    tr1: {
      status: typeof t1.status === "string" ? t1.status.slice(0, 20) : "",
      selfIntro: n(t1.selfIntro),
      dsaOverall: n(t1.dsaOverall),
      problemSolving: n(t1.problemSolving),
      coding: n(t1.coding),
      communication: n(t1.communication),
      debugging: n(t1.debugging),
      overallTechnical: n(t1.overallTechnical),
    },
    assessment: {
      offlineOverall: n(as.offlineOverall),
      dsaCoding: n(as.dsaCoding),
      csFundamentals: n(as.csFundamentals),
      sqlMcq: n(as.sqlMcq),
      sqlCoding: n(as.sqlCoding),
    },
  };
}
