import "server-only";
import { BUCKETS, LIMITS, RERUN_CODES, TRUST } from "@/lib/bucketing/config";
import { eligibility } from "@/lib/bucketing/nodes/bucketing-agent";
import { traceEntry } from "@/lib/bucketing/nodes/shared";
import { overallTrust, trustBand } from "@/lib/bucketing/scoring";
import { hireTrackBuckets, type FinalReview } from "@/lib/bucketing/types";
import type { State, Update } from "@/lib/bucketing/state";

/**
 * Agent 8 — final verifier (deterministic). Checks the decision's invariants and
 * computes the overall trust:
 *  - a bucket is one of the six, or there is no bucket and at least one reason;
 *  - a bucket placed by the TR-2 track is one of the candidate's hire tracks; any
 *    other bucket is backed by a valid project or an in-domain role;
 *  - the flagship is a valid project; every score is 0-100.
 * A broken invariant sends the stage arbiter back once with repair instructions.
 * Trust: a TR-2 hire in the bucket's own track is an independent confirmation;
 * placed by the interview alone, or with evidence still pending, it is capped and
 * flagged for review. Never given on missing evidence (retry_needed → null).
 */

export function finalVerifierNode(s: State): Update {
  const t0 = Date.now();
  const f = s.final;
  if (!f) {
    const review: FinalReview = {
      verdict: "fail",
      trust: null,
      band: null,
      needsReview: true,
      components: { domain: null, bucket: null, dsa: null, final: 0 },
      caps: [],
      issues: ["No final decision was produced"],
      model: "",
    };
    return { finalReview: review, ...traceEntry("final_verifier", t0, "no decision") };
  }

  const resumeOk = s.resume?.status === "ok";
  const projects = resumeOk ? (s.projectEvidence?.projects ?? []) : [];
  const experience = resumeOk ? (s.extraction?.experience ?? []) : [];
  const issues: string[] = [];
  let checks = 0;
  let passed = 0;
  const check = (ok: boolean, issue: string) => {
    checks += 1;
    if (ok) passed += 1;
    else issues.push(issue);
  };

  check(
    (f.bucket !== null && (BUCKETS as readonly string[]).includes(f.bucket) && f.status === "bucketed") ||
      (f.bucket === null && f.status !== "bucketed" && f.reasonCodes.length > 0),
    "invariant:bucket_state — bucket, status and reason codes disagree",
  );
  if (resumeOk && s.projectEvidence && f.status !== "retry_needed") {
    const verified = projects.some((p) => p.valid && (p.tier === "A" || p.tier === "B" || p.tier === "R"));
    check(f.validated === verified, `invariant:validation — validated=${f.validated} but verified projects ${verified ? "exist" : "don't exist"}`);
  }
  if (f.flagshipId) {
    const fl = projects.find((p) => p.projectId === f.flagshipId);
    check(Boolean(fl?.valid), `invariant:flagship_invalid — flagship ${f.flagshipId} is not a valid project`);
  }
  if (f.bucket) {
    const b = f.bucket;
    if (f.placedBy === "tr2-track") {
      check(hireTrackBuckets(s.input).includes(b), `invariant:track_bucket — ${b} is not one of the candidate's TR-2 hire tracks`);
    } else {
      check(eligibility(projects, experience).eligible.includes(b), `invariant:bucket_unbacked — no verified project or in-domain role backs ${b}`);
    }
  }
  // An input gap, not a verification failure: flagged for review, never held against trust.
  const inputIssues =
    s.input.stage === "TR2" && !s.input.interview && !s.input.track
      ? ["input: TR-2 row has no track — the bucket comes from the resume; add the track and re-run to apply the TR-2 rule"]
      : [];
  const sc = f.scores;
  check(
    [sc.overall, sc.internal, sc.projects, sc.experience, sc.achievements, sc.domain, sc.flagship, sc.dsa].every(
      (v) => Number.isFinite(v) && v >= 0 && v <= 100,
    ),
    "invariant:scores — a score is outside 0-100",
  );
  const finalTrust = checks ? Math.round((100 * passed) / checks) : 100;
  const repairable = issues.some((i) => i.startsWith("invariant:flagship_invalid") || i.startsWith("invariant:bucket_unbacked"));
  const canRepair = (s.attempts.stage_arbiter ?? 1) <= LIMITS.MAX_REVISE_LOOPS;
  const verdict = repairable ? (canRepair ? "revise" : "fail") : issues.length ? "fail" : "pass";
  issues.push(...inputIssues);

  // Trust: never on missing evidence.
  if (f.status === "retry_needed") {
    const review: FinalReview = {
      verdict,
      trust: null,
      band: null,
      needsReview: true,
      components: { domain: null, bucket: null, dsa: null, final: finalTrust },
      caps: [],
      issues,
      model: "",
    };
    return { finalReview: review, ...traceEntry("final_verifier", t0, `retry needed — no trust given`) };
  }

  const interviewOnly = f.flags.includes("INTERVIEW_ONLY");
  const pending = f.flags.some((c) => RERUN_CODES.has(c));
  const caps: { value: number; why: string }[] = [];
  if (projects.some((p) => p.repos.some((r) => r.integrity?.truncated))) caps.push({ value: TRUST.caps.auditTruncated, why: "commit history longer than the audit window" });
  if (s.resume?.transcribed) caps.push({ value: TRUST.caps.transcribed, why: "resume read from an image / scan" });
  // The bucket verifier reviews the resume's own pick — moot when the TR-2 track placed the candidate.
  const bucketFail = s.bucketReview?.verdict === "fail" && f.placedBy !== "tr2-track";
  if (s.domainReview?.verdict === "fail" || bucketFail || verdict === "fail") {
    caps.push({ value: TRUST.caps.verifierFail, why: "a verifier still disagreed after its revision" });
  }
  if (f.bucket && f.placedBy === "evidence" && s.bucketing?.tierCBacked && s.bucketing.bucket === f.bucket) {
    caps.push({ value: TRUST.caps.tierCBacking, why: "bucket rests on a demo-only project" });
  }
  if (interviewOnly) caps.push({ value: TRUST.caps.interviewOnly, why: "placed by the TR-2 interview alone — the resume could not be checked" });
  if (pending) caps.push({ value: TRUST.caps.evidencePending, why: "some evidence could not be checked — re-run" });

  // The bucket stage's trust: a hire in the bucket's own track confirms it independently.
  let bucketTrust = resumeOk ? (s.bucketReview?.trust ?? null) : null;
  if (f.placedBy === "tr2-track") {
    bucketTrust = f.trackBacked ? Math.max(bucketTrust ?? 0, TRUST.trackConfirmed) : TRUST.trackUnbacked;
  }
  const components = {
    domain: resumeOk ? (s.domainReview?.trust ?? null) : null,
    bucket: bucketTrust,
    dsa: resumeOk ? (s.dsaReview?.trust ?? null) : null,
    final: finalTrust,
  };
  const { trust, applied } = overallTrust(components, caps);
  const band = trustBand(trust);
  const needsReview =
    band === "Low" ||
    verdict !== "pass" ||
    inputIssues.length > 0 ||
    interviewOnly ||
    pending ||
    f.flags.includes("TRACK_MISMATCH") ||
    f.reasonCodes.includes("RESUME_UNREADABLE") ||
    (s.dsa?.flags.length ?? 0) > 0;
  const review: FinalReview = { verdict, trust, band, needsReview, components, caps: applied, issues, model: "" };

  const flags = band === "Low" && !f.flags.includes("LOW_TRUST") ? [...f.flags, "LOW_TRUST" as const] : f.flags;
  return {
    finalReview: review,
    ...(flags !== f.flags ? { final: { ...f, flags } } : {}),
    ...traceEntry(
      "final_verifier",
      t0,
      `${verdict}; trust ${trust} (${band})${applied.length ? `; caps: ${applied.join(", ")}` : ""}${issues.length ? `; ${issues.length} issue(s)` : ""}`,
    ),
  };
}

/** Back to the stage arbiter once when an invariant can be repaired; otherwise done. */
export function routeAfterFinalReview(s: State): "stage_arbiter" | "__end__" {
  return s.finalReview?.verdict === "revise" && (s.attempts.stage_arbiter ?? 1) <= LIMITS.MAX_REVISE_LOOPS ? "stage_arbiter" : "__end__";
}
