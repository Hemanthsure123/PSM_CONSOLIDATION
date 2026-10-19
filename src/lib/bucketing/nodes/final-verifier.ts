import "server-only";
import { BUCKETS, LIMITS, TRACK_BUCKET, TRUST } from "@/lib/bucketing/config";
import { roleBuckets } from "@/lib/bucketing/nodes/bucketing-agent";
import { traceEntry } from "@/lib/bucketing/nodes/shared";
import { overallTrust, trustBand } from "@/lib/bucketing/scoring";
import type { FinalReview } from "@/lib/bucketing/types";
import type { State, Update } from "@/lib/bucketing/state";

/**
 * Agent 8 — final verifier (deterministic). Checks the decision's invariants and
 * computes the overall trust:
 *  - a bucket is one of the five, or there is no bucket and at least one reason;
 *  - validated ⇔ at least one Tier A/B project;
 *  - the flagship is a valid project, and verified evidence backs the bucket;
 *  - a TR-2 label names its track; every score is 0-100.
 * A broken invariant sends the stage arbiter back once with repair
 * instructions. Trust is never given on missing evidence (retry_needed → null).
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

  const projects = s.projectEvidence?.projects ?? [];
  const experience = s.extraction?.experience ?? [];
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
  if (s.resume?.status === "ok" && s.projectEvidence && f.status !== "retry_needed") {
    const ab = projects.some((p) => p.valid && (p.tier === "A" || p.tier === "B"));
    check(f.validated === ab, `invariant:validation — validated=${f.validated} but Tier A/B projects ${ab ? "exist" : "don't exist"}`);
  }
  if (f.flagshipId) {
    const fl = projects.find((p) => p.projectId === f.flagshipId);
    check(Boolean(fl?.valid), `invariant:flagship_invalid — flagship ${f.flagshipId} is not a valid project`);
  }
  if (f.bucket) {
    const b = f.bucket;
    const byProject = projects.some((p) => p.valid && p.buckets.includes(b));
    const byTrackRole =
      s.input.stage === "TR2" && s.input.track && TRACK_BUCKET[s.input.track] === b && experience.some((e) => roleBuckets(e).includes(b));
    check(byProject || Boolean(byTrackRole), `invariant:bucket_unbacked — no verified project or internship backs ${b}`);
  }
  // An input gap, not a verification failure: flagged for review, never held against trust.
  const inputIssues = s.input.stage === "TR2" && !s.input.track ? ["input: TR-2 row has no track — the TR-2 rule couldn't be applied; add the track and re-run"] : [];
  const sc = f.scores;
  check(
    [sc.overall, sc.validation, sc.domain, sc.flagship, sc.dsa].every((v) => Number.isFinite(v) && v >= 0 && v <= 100),
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

  const caps: { value: number; why: string }[] = [];
  if (projects.some((p) => p.repos.some((r) => r.integrity?.truncated))) caps.push({ value: TRUST.caps.auditTruncated, why: "commit history longer than the audit window" });
  if (s.resume?.transcribed) caps.push({ value: TRUST.caps.transcribed, why: "resume read from an image / scan" });
  if (s.domainReview?.verdict === "fail" || s.bucketReview?.verdict === "fail" || verdict === "fail") {
    caps.push({ value: TRUST.caps.verifierFail, why: "a verifier still disagreed after its revision" });
  }
  if (f.bucket && s.bucketing?.tierCBacked && s.bucketing.bucket === f.bucket) caps.push({ value: TRUST.caps.tierCBacking, why: "bucket rests on a demo-only project" });

  const evidenceRan = s.resume?.status === "ok";
  const components = {
    domain: evidenceRan ? (s.domainReview?.trust ?? null) : null,
    bucket: evidenceRan ? (s.bucketReview?.trust ?? null) : null,
    dsa: evidenceRan ? (s.dsaReview?.trust ?? null) : null,
    final: finalTrust,
  };
  const { trust, applied } = overallTrust(components, caps);
  const band = trustBand(trust);
  const needsReview =
    band === "Low" ||
    verdict !== "pass" ||
    inputIssues.length > 0 ||
    f.reasonCodes.includes("RESUME_UNREADABLE") ||
    (s.dsa?.flags.length ?? 0) > 0;
  const review: FinalReview = { verdict, trust, band, needsReview, components, caps: applied, issues, model: "" };

  const flags = needsReview && band === "Low" && !f.flags.includes("LOW_TRUST") ? [...f.flags, "LOW_TRUST" as const] : f.flags;
  return {
    finalReview: review,
    ...(flags !== f.flags ? { final: { ...f, flags } } : {}),
    ...traceEntry("final_verifier", t0, `${verdict}; trust ${trust} (${band})${applied.length ? `; caps: ${applied.join(", ")}` : ""}${issues.length ? `; ${issues.length} issue(s)` : ""}`),
  };
}

/** Back to the stage arbiter once when an invariant can be repaired; otherwise done. */
export function routeAfterFinalReview(s: State): "stage_arbiter" | "__end__" {
  return s.finalReview?.verdict === "revise" && (s.attempts.stage_arbiter ?? 1) <= LIMITS.MAX_REVISE_LOOPS ? "stage_arbiter" : "__end__";
}
