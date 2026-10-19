import "server-only";
import { SchemaType, type Schema } from "@google/generative-ai";
import { BUCKETS, LIMITS, TRACK_LABEL, TRUST, type Bucket } from "@/lib/bucketing/config";
import { missingFor } from "@/lib/bucketing/bucket-rules";
import { callAgent, fence, str, strList, verifierChain } from "@/lib/bucketing/llm";
import { domainLines, eligibility, eligibilityLines } from "@/lib/bucketing/nodes/bucketing-agent";
import { evidenceItems, traceEntry } from "@/lib/bucketing/nodes/shared";
import { verifierTrust } from "@/lib/bucketing/scoring";
import type { BucketDecision, BucketReview, ProjectEvidence } from "@/lib/bucketing/types";
import type { State, Update } from "@/lib/bucketing/state";

/**
 * Agent 4 — bucket verifier.
 *  1. Deterministic: the bucket is eligible, the flagship is a valid project whose
 *     verified code meets the bucket's rule, MERN vs Frontend follows whether a
 *     backend exists, and the GitHub audits behind it completed.
 *  2. A judge on a different model: is another eligible bucket or project better
 *     supported?
 * A violation or a better bucket sends Agent 3 back once. If the rules still
 * fail after that, the decision is repaired deterministically (and trust drops).
 */

const SYSTEM = `You are an independent reviewer of a placement-bucketing decision. Check whether the chosen bucket and flagship project are the best supported by the VERIFIED evidence (code-verified projects, internships). Only ELIGIBLE buckets may be chosen. Don't second-guess close calls — flag a problem only when another eligible bucket or another valid project is clearly better supported, or the rationale contradicts the evidence.`;

const SHAPE = `Return ONLY a JSON object: {"agree":boolean,"betterBucket":string,"betterFlagshipId":string,"issues":[string]} — betterBucket / betterFlagshipId are "" when you agree.`;

const SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    agree: { type: SchemaType.BOOLEAN },
    betterBucket: { type: SchemaType.STRING },
    betterFlagshipId: { type: SchemaType.STRING },
    issues: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  },
  required: ["agree", "betterBucket", "betterFlagshipId", "issues"],
};

const TIER_RANK: Record<string, number> = { A: 3, B: 2, C: 1, D: 0 };

/** The strongest valid project meeting a bucket's rule: tier first, then the agent's strength rating. */
export function bestFlagship(bucket: Bucket, projects: ProjectEvidence[], strengths: Record<string, number>): ProjectEvidence | null {
  return (
    projects
      .filter((p) => p.valid && p.buckets.includes(bucket))
      .sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || (strengths[b.projectId] ?? 0) - (strengths[a.projectId] ?? 0))[0] ?? null
  );
}

/** Deterministic rule checks on a decision. Returns the violations. */
function ruleCheck(d: BucketDecision, projects: ProjectEvidence[], eligible: Bucket[]): { violations: string[]; checks: number } {
  const v: string[] = [];
  let checks = 1;
  if (!d.bucket) {
    if (eligible.length) v.push(`No bucket chosen although ${eligible.join(", ")} ${eligible.length === 1 ? "is" : "are"} eligible`);
    return { violations: v, checks };
  }
  if (!eligible.includes(d.bucket)) v.push(`${d.bucket} is not eligible — no valid project's code meets its rule`);
  checks += 2;
  const flagship = projects.find((p) => p.projectId === d.flagshipId);
  if (!flagship) {
    if (d.basis !== "internship") v.push("No flagship project named");
  } else if (!flagship.valid) {
    v.push(`Flagship ${flagship.projectId} is not a valid project (${flagship.invalidReason ?? flagship.status})`);
  } else if (!flagship.buckets.includes(d.bucket)) {
    v.push(`Flagship ${flagship.projectId}'s code doesn't meet the ${d.bucket} rule (missing ${missingFor(d.bucket, new Set(flagship.techKeys)).join(", ") || "rule"})`);
  }
  checks += 1;
  if (d.bucket === "FRONTEND" && flagship?.backend) v.push(`Flagship ${flagship.projectId} has its own backend — it is not a Frontend-only project`);
  return { violations: v, checks };
}

export async function bucketVerifierNode(s: State): Promise<Update> {
  const t0 = Date.now();
  const x = s.extraction!;
  const projects = s.projectEvidence?.projects ?? [];
  const d = s.bucketing;
  if (!d || d.error) {
    const review: BucketReview = {
      verdict: "fail",
      trust: 0,
      coverage: 0,
      agreement: null,
      issues: [`Bucketing agent failed: ${d?.error ?? "no output"}`],
      model: "",
      betterBucket: null,
    };
    return { bucketReview: review, ...traceEntry("bucket_verifier", t0, "agent failed — nothing to verify") };
  }
  const elig = eligibility(projects, x.experience);
  const { violations, checks } = ruleCheck(d, projects, elig.eligible);

  // How complete the GitHub evidence behind the decision is: a truncated or unavailable
  // audit counts 0, a history with behavioural flags (single dump, bursts) counts half.
  const audited = projects.filter((p) => p.repos.length && p.status !== "invalid");
  const quality = (p: ProjectEvidence) =>
    p.status === "unavailable" || p.repos.some((r) => r.integrity?.truncated) ? 0 : p.repos.some((r) => (r.integrity?.flags.length ?? 0) > 0) ? 0.5 : 1;
  const auditCompleteness = audited.length ? audited.reduce((sum, p) => sum + quality(p), 0) / audited.length : 1;
  const coverage = 0.5 * ((checks - violations.length) / checks) + 0.5 * auditCompleteness;

  // Judge — only when there is a real choice to review.
  let agreement: number | null = null;
  let betterBucket: Bucket | null = null;
  const issues = [...violations];
  let judgeModel = "";
  const choice = elig.eligible.length > 0;
  if (choice) {
    const domains = s.domainReview?.adjusted?.length ? s.domainReview.adjusted : (s.domainAnalysis?.domains ?? []);
    const track = s.input.stage === "TR2" && s.input.track ? `TR-2 track: ${TRACK_LABEL[s.input.track]}.` : "No TR-2 track.";
    const prompt =
      `${track}\n\nELIGIBLE BUCKETS:\n${eligibilityLines(elig)}\n\nVERIFIED DOMAIN SCORES:\n${domainLines(domains)}\n\n` +
      `${fence("evidence items (with verification results)", evidenceItems(x, projects))}\n\n` +
      `DECISION UNDER REVIEW: bucket ${d.bucket ?? "NONE"}; flagship ${d.flagshipId || "none"} (strength ${d.flagshipStrength}); basis ${d.basis || "—"}.\nRationale: ${d.rationale || "—"}`;
    const judge = await callAgent<Record<string, unknown>>({
      label: `bucketing:${s.input.mobile}:bucket-judge`,
      chain: verifierChain(),
      system: SYSTEM,
      schema: SCHEMA,
      shapeHint: SHAPE,
      prompt,
      accept: (j) => typeof (j as { agree?: unknown }).agree === "boolean",
    });
    if (judge.ok) {
      judgeModel = judge.model;
      const j = judge.json;
      const bb = str(j.betterBucket, 20).toUpperCase();
      betterBucket = (BUCKETS as readonly string[]).includes(bb) && elig.eligible.includes(bb as Bucket) && bb !== d.bucket ? (bb as Bucket) : null;
      const bf = str(j.betterFlagshipId, 8).toUpperCase();
      const flagshipDisagree = Boolean(bf) && bf !== d.flagshipId && projects.some((p) => p.projectId === bf && p.valid);
      agreement = j.agree === true && !betterBucket ? 1 : betterBucket ? 0 : flagshipDisagree ? 0.5 : 0.75;
      if (betterBucket) issues.push(`Judge: ${betterBucket} is better supported than ${d.bucket ?? "NONE"}`);
      if (flagshipDisagree) issues.push(`Judge: ${bf} is a stronger flagship than ${d.flagshipId || "none"}`);
      issues.push(...strList(j.issues, 4, 200).map((i) => `Judge: ${i}`));
    } else {
      issues.push(`Judge unavailable (${judge.error.slice(0, 120)}) — rules checked only`);
    }
  }

  const needsWork = violations.length > 0 || betterBucket !== null;
  const canRevise = (s.attempts.bucketing_agent ?? 1) <= LIMITS.MAX_REVISE_LOOPS;
  const verdict = needsWork ? (canRevise ? "revise" : "fail") : "pass";

  // Out of revisions with the rules still broken → repair deterministically.
  let repaired: BucketDecision | null = null;
  if (verdict === "fail" && violations.length) {
    const ranked = [...elig.eligible].sort(
      (a, b) =>
        (domainsScore(s, b) - domainsScore(s, a)) || ((elig.backers[b]?.length ?? 0) - (elig.backers[a]?.length ?? 0)),
    );
    const bucket = ranked[0] ?? null;
    const flagship = bucket ? bestFlagship(bucket, projects, d.projectStrengths) : null;
    repaired = {
      ...d,
      bucket,
      flagshipId: flagship?.projectId ?? "",
      flagshipStrength: flagship ? (d.projectStrengths[flagship.projectId] ?? d.flagshipStrength) : 0,
      basis: flagship ? "flagship" : "",
      tierCBacked: bucket ? elig.tierCOnly.includes(bucket) : false,
      noBucketReason: bucket ? "" : "No valid project's code meets any bucket rule.",
      rationale: `${d.rationale} [Repaired by the verifier: ${violations.join("; ")}]`.trim(),
    };
    issues.push(`Repaired deterministically → ${bucket ?? "NONE"}${flagship ? ` / ${flagship.projectId}` : ""}`);
  }

  let trust = verifierTrust(coverage, agreement);
  if (agreement === null && choice) trust = Math.min(trust, 70);
  if ((repaired ?? d).tierCBacked) trust = Math.min(trust, TRUST.caps.tierCBacking);
  const review: BucketReview = {
    verdict,
    trust,
    coverage: Number(coverage.toFixed(2)),
    agreement,
    issues: issues.slice(0, 12),
    model: judgeModel,
    betterBucket,
  };
  return {
    bucketReview: review,
    ...(repaired ? { bucketing: repaired } : {}),
    ...(judgeModel ? { models: [judgeModel] } : {}),
    ...traceEntry(
      "bucket_verifier",
      t0,
      `${verdict}; trust ${trust}${violations.length ? `; ${violations.length} rule violation(s)` : ""}${betterBucket ? `; judge prefers ${betterBucket}` : ""}${repaired ? `; repaired → ${repaired.bucket ?? "NONE"}` : ""}`,
      judgeModel || undefined,
    ),
  };
}

function domainsScore(s: State, b: Bucket): number {
  const domains = s.domainReview?.adjusted?.length ? s.domainReview.adjusted : (s.domainAnalysis?.domains ?? []);
  return domains.find((d) => d.domain === b)?.score ?? 0;
}

/** Back to the bucketing agent once on "revise"; otherwise the branch is done. */
export function routeAfterBucketReview(s: State): "bucketing_agent" | "__end__" {
  return s.bucketReview?.verdict === "revise" && (s.attempts.bucketing_agent ?? 1) <= LIMITS.MAX_REVISE_LOOPS ? "bucketing_agent" : "__end__";
}
