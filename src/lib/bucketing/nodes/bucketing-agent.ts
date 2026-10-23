import "server-only";
import { SchemaType, type Schema } from "@google/generative-ai";
import { BUCKET_LABEL, BUCKET_RULE, BUCKETS, DOMAIN_LABEL, TRACK_BUCKET, type Bucket } from "@/lib/bucketing/config";
import { bucketsFor } from "@/lib/bucketing/bucket-rules";
import { callAgent, fence, num, producerChain, str, strList } from "@/lib/bucketing/llm";
import { evidenceItems, interviewLines, traceEntry } from "@/lib/bucketing/nodes/shared";
import type { BucketDecision, DomainScore, ExtractedExperience, ProjectEvidence } from "@/lib/bucketing/types";
import type { State, Update } from "@/lib/bucketing/state";

/**
 * Agent 3 — bucketing agent. Picks the candidate's flagship project and ONE
 * bucket among the buckets the verified evidence makes eligible (bucket-rules.ts):
 *  - a valid project whose GitHub code meets the rule (tier A / B), or an ML / GenAI
 *    project described on the resume (tier R — GitHub is optional there);
 *  - a demo-only project plus an in-domain internship (tier C, weaker);
 *  - an internship / job in that domain on its own (experience is the third signal).
 * A TR-2 hire track is decided later by the stage arbiter (internal assessments
 * come first); the agent still picks the flagship and rates every project.
 */

export interface Eligibility {
  eligible: Bucket[];
  /** Bucket → valid project / role ids whose evidence meets its rule. */
  backers: Record<string, string[]>;
  /** Buckets backed only by a demo-only project + internship. */
  tierCOnly: Bucket[];
  /** Buckets backed only by an internship / job (no project). */
  roleOnly: Bucket[];
}

/** Internships / jobs whose own text names technologies that meet a bucket rule. */
export function roleBuckets(e: ExtractedExperience): Bucket[] {
  return e.kind === "other" ? [] : bucketsFor(new Set(e.techKeys));
}

export function eligibility(projects: ProjectEvidence[], experience: ExtractedExperience[]): Eligibility {
  const backers: Record<string, string[]> = {};
  const roleBacked = new Set(experience.flatMap(roleBuckets));
  const strong = new Set<Bucket>();
  const weak = new Set<Bucket>();
  const roles = new Set<Bucket>();
  for (const p of projects) {
    if (!p.valid) continue;
    for (const b of p.buckets) {
      if (p.tier === "A" || p.tier === "B" || p.tier === "R") {
        strong.add(b);
        (backers[b] ??= []).push(p.projectId);
      } else if (p.tier === "C" && roleBacked.has(b)) {
        weak.add(b);
        (backers[b] ??= []).push(p.projectId);
      }
    }
  }
  for (const e of experience) {
    for (const b of roleBuckets(e)) {
      roles.add(b);
      (backers[b] ??= []).push(e.id);
    }
  }
  const eligible = BUCKETS.filter((b) => strong.has(b) || weak.has(b) || roles.has(b));
  return {
    eligible,
    backers,
    tierCOnly: eligible.filter((b) => !strong.has(b) && weak.has(b)),
    roleOnly: eligible.filter((b) => !strong.has(b) && !weak.has(b)),
  };
}

const SYSTEM = `You place ONE candidate in exactly one of six placement buckets and pick their flagship project.

Buckets and what each needs:
${BUCKETS.map((b) => `- ${b} (${BUCKET_LABEL[b]}): ${BUCKET_RULE[b]}`).join("\n")}

The signals, strongest first: 1) the company's own interviews (TR-2 verdict, TR-1 and assessment scores) · 2) projects with verifiable GitHub (a live demo is a bonus; for DS/ML and GenAI a well-described project counts without GitHub, a notebook on GitHub is a bonus) · 3) internships / jobs · 4) achievements.

Rules:
- Choose ONLY from the ELIGIBLE buckets listed. If none is eligible answer "NONE".
- A TR-2 hire track, when given and eligible, is the bucket unless the evidence clearly contradicts it.
- Otherwise choose the bucket the strongest verified work supports best — the flagship project and/or an internship in that domain. Use the verified domain scores as a guide.
- Flagship: the most substantial VALID project in the chosen bucket (tier A > B > R > C on equal merit) — depth, real features, integrations, deployment, recency. Never an INVALID project. "" when only an internship backs the bucket.
- Rate EVERY valid project's strength 0-100: 90+ production-grade; 70-89 solid, complete feature set; 50-69 decent; 30-49 tutorial-level / clone; below 30 trivial.
- basis: "flagship" (the project carries it), "internship" (an in-domain internship carries it), or "both".`;

const SHAPE = `Return ONLY a JSON object:
{"bucket":${[...BUCKETS, "NONE"].map((b) => `"${b}"`).join("|")},"flagshipId":string,"supportingIds":[string],"basis":"flagship"|"internship"|"both","flagshipStrength":number,"projectStrengths":[{"id":string,"strength":number}],"rationale":string}`;

const SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    bucket: { type: SchemaType.STRING, format: "enum", enum: [...BUCKETS, "NONE"] },
    flagshipId: { type: SchemaType.STRING },
    supportingIds: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    basis: { type: SchemaType.STRING, format: "enum", enum: ["flagship", "internship", "both"] },
    flagshipStrength: { type: SchemaType.NUMBER },
    projectStrengths: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: { id: { type: SchemaType.STRING }, strength: { type: SchemaType.NUMBER } },
        required: ["id", "strength"],
      },
    },
    rationale: { type: SchemaType.STRING },
  },
  required: ["bucket", "flagshipId", "supportingIds", "basis", "flagshipStrength", "projectStrengths", "rationale"],
};

export function domainLines(domains: DomainScore[]): string {
  return (
    domains
      .filter((d) => d.score > 0)
      .map((d) => `${d.domain} (${DOMAIN_LABEL[d.domain]}): ${d.score}${d.evidence.length ? ` — items ${d.evidence.map((e) => e.itemId).join(", ")}` : ""}`)
      .join("\n") || "(no domain scored)"
  );
}

export function eligibilityLines(e: Eligibility): string {
  return e.eligible.length
    ? e.eligible
        .map(
          (b) =>
            `${b}: backed by ${e.backers[b]?.join(", ")}${e.tierCOnly.includes(b) ? " (demo-only project + internship — weaker)" : ""}${e.roleOnly.includes(b) ? " (internship / job only — no project)" : ""}`,
        )
        .join("\n")
    : "NONE — no valid project or in-domain role meets any bucket rule.";
}

export async function bucketingAgentNode(s: State): Promise<Update> {
  const t0 = Date.now();
  const x = s.extraction!;
  const pe = s.projectEvidence;
  const attempt = (s.attempts.bucketing_agent ?? 0) + 1;
  const projects = pe?.projects ?? [];
  const elig = eligibility(projects, x.experience);
  const domains = s.domainReview?.adjusted?.length ? s.domainReview.adjusted : (s.domainAnalysis?.domains ?? []);
  const trackBucket = s.input.stage === "TR2" && s.input.track ? TRACK_BUCKET[s.input.track] : undefined;

  const base: BucketDecision = {
    bucket: null,
    flagshipId: "",
    supportingIds: [],
    basis: "",
    flagshipStrength: 0,
    projectStrengths: {},
    rationale: "",
    eligible: elig.eligible,
    noBucketReason: "",
    tierCBacked: false,
    roleOnly: elig.roleOnly,
    model: "",
    attempt,
    error: "",
  };
  const validProjects = projects.filter((p) => p.valid);
  if (!elig.eligible.length && !validProjects.length) {
    const decision = { ...base, noBucketReason: "No valid project or in-domain role — nothing to bucket on." };
    return { bucketing: decision, attempts: { bucketing_agent: attempt }, ...traceEntry("bucketing_agent", t0, "no evidence — no bucket (no model call)") };
  }
  if (!elig.eligible.length && !trackBucket) {
    const decision = { ...base, noBucketReason: "No valid project's code (or in-domain role) meets any bucket rule." };
    return { bucketing: decision, attempts: { bucketing_agent: attempt }, ...traceEntry("bucketing_agent", t0, "no eligible bucket — no bucket (no model call)") };
  }
  // Only roles back the eligible buckets and there is no project to rate: decide without a model.
  if (!validProjects.length) {
    const ranked = [...elig.eligible].sort(
      (a, b) => (b === trackBucket ? 1 : 0) - (a === trackBucket ? 1 : 0) || (domains.find((d) => d.domain === b)?.score ?? 0) - (domains.find((d) => d.domain === a)?.score ?? 0),
    );
    const bucket = ranked[0] ?? null;
    const decision: BucketDecision = {
      ...base,
      bucket,
      basis: bucket ? "internship" : "",
      rationale: bucket ? `Backed by ${elig.backers[bucket]?.join(", ")} (internship / job in this domain).` : "",
      noBucketReason: bucket ? "" : "No eligible bucket.",
    };
    return { bucketing: decision, attempts: { bucketing_agent: attempt }, ...traceEntry("bucketing_agent", t0, `${bucket ?? "NONE"} from experience only (no model call)`) };
  }

  const prior = s.bucketReview && s.bucketReview.verdict === "revise" && s.bucketing ? s.bucketing : null;
  const feedback = prior
    ? `\n\nA reviewer rejected your previous answer (bucket ${prior.bucket ?? "NONE"}, flagship ${prior.flagshipId || "none"}):\n- ${s.bucketReview!.issues.join("\n- ")}\nFix it.`
    : "";
  const prompt =
    `INTERNAL ASSESSMENTS:\n${interviewLines(s.input)}\n\nELIGIBLE BUCKETS:\n${eligibilityLines(elig)}\n\nVERIFIED DOMAIN SCORES:\n${domainLines(domains)}\n\n` +
    `${fence("evidence items (with verification results)", evidenceItems(x, projects))}${feedback}`;

  const res = await callAgent<Record<string, unknown>>({
    label: `bucketing:${s.input.mobile}:bucket`,
    chain: producerChain(),
    system: SYSTEM,
    schema: SCHEMA,
    shapeHint: SHAPE,
    prompt,
    accept: (j) => typeof (j as { bucket?: unknown }).bucket === "string",
  });
  if (!res.ok) {
    return {
      bucketing: { ...base, error: res.error },
      attempts: { bucketing_agent: attempt },
      ...traceEntry("bucketing_agent", t0, `failed — ${res.error.slice(0, 120)}`),
    };
  }
  const j = res.json;
  const ids = new Set(projects.map((p) => p.projectId).concat(x.experience.map((e) => e.id), x.openSource.map((o) => o.id)));
  const raw = str(j.bucket, 20).toUpperCase();
  const bucket = (BUCKETS as readonly string[]).includes(raw) ? (raw as Bucket) : null;
  const strengths: Record<string, number> = {};
  for (const o of (Array.isArray(j.projectStrengths) ? j.projectStrengths : []) as Record<string, unknown>[]) {
    const id = str(o.id, 8).toUpperCase();
    if (projects.some((p) => p.projectId === id && p.valid)) strengths[id] = num(o.strength);
  }
  const flagshipId = str(j.flagshipId, 8).toUpperCase();
  const decision: BucketDecision = {
    ...base,
    bucket,
    flagshipId: projects.some((p) => p.projectId === flagshipId) ? flagshipId : "",
    supportingIds: strList(j.supportingIds, 8, 8)
      .map((v) => v.toUpperCase())
      .filter((v) => ids.has(v) && v !== flagshipId),
    basis: (["flagship", "internship", "both"] as const).find((b) => b === j.basis) ?? "flagship",
    flagshipStrength: strengths[flagshipId] ?? num(j.flagshipStrength),
    projectStrengths: strengths,
    rationale: str(j.rationale, 500),
    noBucketReason: bucket ? "" : elig.eligible.length ? "The agent chose no bucket although some are eligible." : "No valid project's code meets any bucket rule.",
    tierCBacked: bucket ? elig.tierCOnly.includes(bucket) : false,
    model: res.model,
  };
  return {
    bucketing: decision,
    attempts: { bucketing_agent: attempt },
    models: [res.model],
    ...traceEntry(
      "bucketing_agent",
      t0,
      `${attempt > 1 ? "revised: " : ""}${bucket ?? "NONE"} (eligible ${elig.eligible.join(", ") || "none"}); flagship ${decision.flagshipId || "—"} strength ${decision.flagshipStrength}`,
      res.model,
    ),
  };
}
