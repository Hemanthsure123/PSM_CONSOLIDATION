import "server-only";
import { createHash } from "node:crypto";
import { END, START, StateGraph } from "@langchain/langgraph";
import { BUCKETING_PROMPT_VERSION, TIMEOUTS } from "@/lib/bucketing/config";
import { BucketingState, type State, type Update } from "@/lib/bucketing/state";
import { ingestNode } from "@/lib/bucketing/nodes/ingest";
import { domainAnalystNode } from "@/lib/bucketing/nodes/domain-analyst";
import { domainVerifierNode, routeAfterDomainReview } from "@/lib/bucketing/nodes/domain-verifier";
import { projectEvidenceNode } from "@/lib/bucketing/nodes/project-evidence";
import { bucketingAgentNode } from "@/lib/bucketing/nodes/bucketing-agent";
import { bucketVerifierNode, routeAfterBucketReview } from "@/lib/bucketing/nodes/bucket-verifier";
import { dsaCollectorNode, dsaVerifierNode } from "@/lib/bucketing/nodes/dsa";
import { stageArbiterNode } from "@/lib/bucketing/nodes/stage-arbiter";
import { finalVerifierNode, routeAfterFinalReview } from "@/lib/bucketing/nodes/final-verifier";
import { emptyDsa, type BucketingCandidateInput, type BucketingResult } from "@/lib/bucketing/types";

/**
 * Candidate Bucketing — the LangGraph.js workflow for ONE candidate.
 *
 *   START → ingest ─(not a resume / unreadable)──────────────────────────┐
 *             └─(ok)→ ┬ domain_review  [domain_analyst ⇄ domain_verifier] │
 *                     ├ project_evidence (GitHub, commits, demos)         │
 *                     └ dsa_review     [dsa_collector → dsa_verifier]     │
 *   [domain_review + project_evidence] → bucket_review                    │
 *                                        [bucketing_agent ⇄ bucket_verifier]
 *   [bucket_review + dsa_review] → stage_arbiter ←─────────────────────────┘
 *   stage_arbiter → final_verifier ─(repairable invariant, once)→ stage_arbiter
 *                                  └→ END
 *
 * Each producer/verifier pair is a subgraph with its own bounded revise loop, so
 * the three evidence branches run truly in parallel (a slow GitHub audit never
 * holds up the domain review). Every node is guarded: a crash or timeout
 * becomes a recorded error and a degraded output, never a thrown graph.
 */

// ── Guards ───────────────────────────────────────────────────────────────────

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([work.finally(() => clearTimeout(timer)), timeout]);
}

function guard(name: string, fn: (s: State) => Promise<Update> | Update, ms: number, fallback: (s: State, error: string) => Update) {
  return async (s: State): Promise<Update> => {
    const t0 = Date.now();
    try {
      return await withTimeout(Promise.resolve().then(() => fn(s)), ms, name);
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 300) : String(err);
      console.error(`[bucketing:${s.input?.mobile}] ${name} failed:`, msg);
      return {
        ...fallback(s, msg),
        errors: [`${name}: ${msg}`],
        trace: [{ node: name, ms: Date.now() - t0, decision: `failed — ${msg}` }],
      };
    }
  };
}

/** Run a compiled subgraph on the parent state; return only the keys it owns plus its own trace. */
function subgraph(compiled: { invoke: (input: Update) => Promise<unknown> }, keys: (keyof State)[]) {
  return async (s: State): Promise<Update> => {
    const out = (await compiled.invoke({ ...s, trace: [], errors: [], models: [] })) as State;
    const update: Record<string, unknown> = { trace: out.trace, errors: out.errors, models: out.models, attempts: out.attempts };
    for (const k of keys) update[k] = out[k];
    return update as Update;
  };
}

// ── Subgraphs: producer ⇄ verifier ──────────────────────────────────────────

const domainReview = new StateGraph(BucketingState)
  .addNode(
    "domain_analyst",
    guard("domain_analyst", domainAnalystNode, TIMEOUTS.domainBranchMs / 2, (s, e) => ({
      domainAnalysis: { domains: [], primary: null, model: "", attempt: (s.attempts.domain_analyst ?? 0) + 1, error: e },
      attempts: { domain_analyst: (s.attempts.domain_analyst ?? 0) + 1 },
    })),
  )
  .addNode(
    "domain_verifier",
    guard("domain_verifier", domainVerifierNode, TIMEOUTS.domainBranchMs / 2, () => ({
      domainReview: { verdict: "fail", trust: 0, coverage: 0, agreement: null, issues: ["Domain verifier failed"], model: "", adjusted: [], primary: null },
    })),
  )
  .addEdge(START, "domain_analyst")
  .addEdge("domain_analyst", "domain_verifier")
  .addConditionalEdges("domain_verifier", routeAfterDomainReview, ["domain_analyst", END])
  .compile();

const bucketReview = new StateGraph(BucketingState)
  .addNode(
    "bucketing_agent",
    guard("bucketing_agent", bucketingAgentNode, TIMEOUTS.bucketingMs / 2, (s, e) => ({
      bucketing: {
        bucket: null,
        flagshipId: "",
        supportingIds: [],
        basis: "",
        flagshipStrength: 0,
        projectStrengths: {},
        rationale: "",
        eligible: [],
        noBucketReason: "",
        tierCBacked: false,
        model: "",
        attempt: (s.attempts.bucketing_agent ?? 0) + 1,
        error: e,
      },
      attempts: { bucketing_agent: (s.attempts.bucketing_agent ?? 0) + 1 },
    })),
  )
  .addNode(
    "bucket_verifier",
    guard("bucket_verifier", bucketVerifierNode, TIMEOUTS.bucketingMs / 2, () => ({
      bucketReview: { verdict: "fail", trust: 0, coverage: 0, agreement: null, issues: ["Bucket verifier failed"], model: "", betterBucket: null },
    })),
  )
  .addEdge(START, "bucketing_agent")
  .addEdge("bucketing_agent", "bucket_verifier")
  .addConditionalEdges("bucket_verifier", routeAfterBucketReview, ["bucketing_agent", END])
  .compile();

const dsaReview = new StateGraph(BucketingState)
  .addNode(
    "dsa_collector",
    guard("dsa_collector", dsaCollectorNode, TIMEOUTS.dsaBranchMs, (_s, e) => ({ dsa: { ...emptyDsa(), flags: [`DSA lookup failed: ${e}`] } })),
  )
  .addNode(
    "dsa_verifier",
    guard("dsa_verifier", dsaVerifierNode, 10_000, (_s, e) => ({
      dsaReview: { verdict: "pass", trust: 0, coverage: 0, agreement: null, issues: [`DSA verifier failed: ${e}`], model: "" },
    })),
  )
  .addEdge(START, "dsa_collector")
  .addEdge("dsa_collector", "dsa_verifier")
  .addEdge("dsa_verifier", END)
  .compile();

// ── Main graph ───────────────────────────────────────────────────────────────

const PARALLEL = ["domain_review", "project_evidence", "dsa_review"] as const;

export const bucketingGraph = new StateGraph(BucketingState)
  .addNode(
    "ingest",
    guard("ingest", ingestNode, TIMEOUTS.ingestMs, (_s, e) => ({
      resume: { status: "error", source: "", transcribed: false, chars: 0, note: `Resume step failed: ${e}`, model: "" },
    })),
  )
  .addNode("domain_review", guard("domain_review", subgraph(domainReview, ["domainAnalysis", "domainReview"]), TIMEOUTS.domainBranchMs, (_s, e) => ({
    domainAnalysis: { domains: [], primary: null, model: "", attempt: 1, error: e },
  })))
  .addNode(
    "project_evidence",
    guard("project_evidence", projectEvidenceNode, TIMEOUTS.projectEvidenceMs, (_s, e) => ({
      projectEvidence: { githubUser: "", githubUserSource: "", projects: [], oss: [], callsUsed: 0, unavailable: true, notes: [e] },
    })),
  )
  .addNode("dsa_review", guard("dsa_review", subgraph(dsaReview, ["dsa", "dsaReview"]), TIMEOUTS.dsaBranchMs + 10_000, (_s, e) => ({
    dsa: { ...emptyDsa(), flags: [`DSA lookup failed: ${e}`] },
    dsaReview: { verdict: "pass", trust: 0, coverage: 0, agreement: null, issues: [e], model: "" },
  })))
  .addNode("bucket_review", guard("bucket_review", subgraph(bucketReview, ["bucketing", "bucketReview"]), TIMEOUTS.bucketingMs, (_s, e) => ({
    bucketing: {
      bucket: null,
      flagshipId: "",
      supportingIds: [],
      basis: "",
      flagshipStrength: 0,
      projectStrengths: {},
      rationale: "",
      eligible: [],
      noBucketReason: "",
      tierCBacked: false,
      model: "",
      attempt: 1,
      error: e,
    },
  })))
  .addNode("stage_arbiter", guard("stage_arbiter", stageArbiterNode, 10_000, (s, e) => ({
    final: {
      status: "retry_needed",
      bucket: null,
      stageLabel: "",
      priorityTier: 3,
      validated: false,
      reasonCodes: ["PIPELINE_ERROR"],
      flags: [],
      flagshipId: "",
      scores: { overall: 0, validation: 0, domain: 0, flagship: 0, dsa: 0 },
      remarks: [`Stage arbiter failed: ${e}`],
      trackBacked: null,
      attempt: (s.attempts.stage_arbiter ?? 0) + 1,
    },
    attempts: { stage_arbiter: (s.attempts.stage_arbiter ?? 0) + 1 },
  })))
  .addNode("final_verifier", guard("final_verifier", finalVerifierNode, 10_000, (_s, e) => ({
    finalReview: {
      verdict: "fail",
      trust: null,
      band: null,
      needsReview: true,
      components: { domain: null, bucket: null, dsa: null, final: 0 },
      caps: [],
      issues: [`Final verifier failed: ${e}`],
      model: "",
    },
  })))
  .addEdge(START, "ingest")
  .addConditionalEdges("ingest", (s: State) => (s.resume?.status === "ok" ? [...PARALLEL] : "stage_arbiter"), [...PARALLEL, "stage_arbiter"])
  .addEdge(["domain_review", "project_evidence"], "bucket_review")
  .addEdge(["bucket_review", "dsa_review"], "stage_arbiter")
  .addEdge("stage_arbiter", "final_verifier")
  .addConditionalEdges("final_verifier", routeAfterFinalReview, ["stage_arbiter", END])
  .compile();

// ── Entry point ──────────────────────────────────────────────────────────────

/** Everything a result depends on — same hash, same inputs, same prompts. */
export function inputHash(c: BucketingCandidateInput): string {
  const parts = [c.resumeUrl, c.resumeText ?? "", c.stage, c.track ?? "", c.githubUrl ?? "", c.leetcodeUrl ?? "", c.codechefUrl ?? "", c.codeforcesUrl ?? "", BUCKETING_PROMPT_VERSION];
  return createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

/** Run the whole workflow for one candidate and flatten the state into the result the browser stores. */
export async function runBucketing(input: BucketingCandidateInput): Promise<BucketingResult> {
  const started = Date.now();
  const s = (await bucketingGraph.invoke({ input }, { recursionLimit: 40 })) as State;
  return toResult(s, Date.now() - started);
}

export function toResult(s: State, durationMs: number): BucketingResult {
  const c = s.input;
  const f = s.final;
  const x = s.extraction;
  const pe = s.projectEvidence;
  const evidence = new Map((pe?.projects ?? []).map((p) => [p.projectId, p]));
  const domains = s.domainReview?.adjusted?.length ? s.domainReview.adjusted : (s.domainAnalysis?.domains ?? []);
  const flagshipP = f?.flagshipId ? x?.projects.find((p) => p.id === f.flagshipId) : undefined;
  const flagshipE = flagshipP ? evidence.get(flagshipP.id) : undefined;
  const primary = domains.find((d) => d.score > 0);
  const review = s.finalReview ?? {
    verdict: "fail" as const,
    trust: null,
    band: null,
    needsReview: true,
    components: { domain: null, bucket: null, dsa: null, final: 0 },
    caps: [],
    issues: ["No final review"],
    model: "",
  };

  return {
    id: c.id,
    mobile: c.mobile,
    name: c.name || x?.candidateName || "",
    batch: c.batch,
    stage: c.stage,
    track: c.track,
    stageLabel: f?.stageLabel ?? "",
    priorityTier: f?.priorityTier ?? 3,
    status: f?.status ?? "retry_needed",
    bucket: f?.bucket ?? null,
    validated: f?.validated ?? false,
    reasonCodes: f?.reasonCodes ?? ["PIPELINE_ERROR"],
    flags: f?.flags ?? [],
    remarks: f?.remarks ?? [],
    scores: f?.scores ?? { overall: 0, validation: 0, domain: 0, flagship: 0, dsa: 0 },
    trust: review,
    primaryDomain: primary ? { domain: primary.domain, score: primary.score } : null,
    domains,
    flagship:
      flagshipP && flagshipE
        ? {
            id: flagshipP.id,
            title: flagshipP.title,
            tier: flagshipE.tier,
            github: flagshipE.repos.map((r) => r.url),
            demo: flagshipE.demo?.status === "reachable" ? flagshipE.demo.url : "",
            techs: flagshipE.repos.flatMap((r) => r.techs.map((t) => t.label)).filter((v, i, a) => a.indexOf(v) === i),
            strength: f?.scores.flagship ?? 0,
          }
        : null,
    projects: (x?.projects ?? []).map((p) => ({ ...p, evidence: evidence.get(p.id) ?? null })),
    experience: x?.experience ?? [],
    openSource: (x?.openSource ?? []).map((o) => ({ ...o, evidence: (pe?.oss ?? []).filter((e) => e.claimId === o.id) })),
    dsa: s.dsa ?? emptyDsa(),
    reviews: { domain: s.domainReview, bucket: s.bucketReview, dsa: s.dsaReview },
    resume: s.resume ?? { status: "error", source: "", transcribed: false, chars: 0, note: "not read", model: "" },
    githubUser: pe?.githubUser ?? "",
    documentUrls: x?.urls ?? [],
    extractionDropped: x?.dropped ?? [],
    trace: s.trace,
    errors: s.errors,
    promptVersion: BUCKETING_PROMPT_VERSION,
    inputHash: inputHash(c),
    models: Array.from(new Set(s.models.filter(Boolean))),
    durationMs,
    evaluatedAt: new Date().toISOString(),
  };
}
