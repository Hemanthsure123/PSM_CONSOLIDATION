import "server-only";
import { BUCKETS, DOMAIN_CAPS, DOMAIN_KEYS, JUDGE, LIMITS, type DomainKey } from "@/lib/bucketing/config";
import { callAgent, fence, verifierChain } from "@/lib/bucketing/llm";
import { DOMAINS_SCHEMA, readDomains } from "@/lib/bucketing/nodes/domain-analyst";
import { DOMAIN_GUIDE, RUBRIC, evidenceItems, traceEntry } from "@/lib/bucketing/nodes/shared";
import { verifierTrust } from "@/lib/bucketing/scoring";
import type { DomainReview, DomainScore, Extraction } from "@/lib/bucketing/types";
import type { State, Update } from "@/lib/bucketing/state";

/**
 * Agent 2 — domain verifier. Two independent checks on Agent 1:
 *  1. deterministic — every score rests on real evidence items, and the rubric's
 *     evidence-count caps hold (one project can't make a 70+, 90+ needs two
 *     projects and an in-domain internship);
 *  2. a judge on a different model scores the SAME raw items blind (it never
 *     sees Agent 1's reasoning), and the two are compared.
 * Large disagreement on the primary domain sends Agent 1 back once with the
 * issues; final scores are the capped analyst scores, averaged with the judge's
 * where they differ by more than JUDGE.blendGap points.
 */

const SYSTEM = `You are an independent reviewer of a placement screening. Score how well ONE candidate fits each domain using ONLY the evidence items given (projects, internships / jobs, open-source work — verified from the resume; skills lists were removed on purpose). Another reviewer scored the same items; your scores are compared with theirs, so judge on your own.

${DOMAIN_GUIDE}

${RUBRIC}

For each domain return: domain, score, evidence (item ids that show it, with a short "why"), rationale (one sentence). "primary": the domain with the strongest evidence ("NONE" if nothing scores).`;

const SHAPE = `Return ONLY a JSON object:
{"domains":[{"domain":string,"score":number,"evidence":[{"itemId":string,"why":string}],"rationale":string}],"primary":string}`;

/** Rubric caps by evidence count. Returns the capped score and the issue, if any. */
function capByEvidence(d: DomainScore, x: Extraction): { score: number; issue: string } {
  const projects = new Set(d.evidence.filter((e) => e.itemId.startsWith("P") || e.itemId.startsWith("O")).map((e) => e.itemId));
  const roles = new Set(d.evidence.filter((e) => e.itemId.startsWith("E")).map((e) => e.itemId));
  // A role counts as in-domain experience only if it really is an internship / job.
  const realRoles = [...roles].filter((id) => x.experience.find((e) => e.id === id && e.kind !== "other"));
  const items = projects.size + roles.size;
  if (d.score > DOMAIN_CAPS.none && items === 0) {
    return { score: DOMAIN_CAPS.none, issue: `${d.domain} scored ${d.score} with no evidence item — capped at ${DOMAIN_CAPS.none}` };
  }
  if (d.score > DOMAIN_CAPS.single && projects.size <= 1 && realRoles.length === 0) {
    return { score: DOMAIN_CAPS.single, issue: `${d.domain} scored ${d.score} on a single project and no in-domain role — capped at ${DOMAIN_CAPS.single}` };
  }
  if (d.score > DOMAIN_CAPS.belowTop && !(projects.size >= 2 && realRoles.length >= 1)) {
    return { score: DOMAIN_CAPS.belowTop, issue: `${d.domain} scored ${d.score} without two projects and an in-domain role — capped at ${DOMAIN_CAPS.belowTop}` };
  }
  return { score: d.score, issue: "" };
}

export async function domainVerifierNode(s: State): Promise<Update> {
  const t0 = Date.now();
  const x = s.extraction!;
  const a = s.domainAnalysis;
  if (!a || a.error) {
    const review: DomainReview = {
      verdict: "fail",
      trust: 0,
      coverage: 0,
      agreement: null,
      issues: [`Domain analyst failed: ${a?.error ?? "no output"}`],
      model: "",
      adjusted: [],
      primary: null,
    };
    return { domainReview: review, ...traceEntry("domain_verifier", t0, "analyst failed — nothing to verify") };
  }

  // 1) Deterministic: evidence-count caps.
  const issues: string[] = [];
  const scored = a.domains.filter((d) => d.score > 0);
  let violations = 0;
  const capped = a.domains.map((d) => {
    const c = capByEvidence(d, x);
    if (c.issue) {
      issues.push(c.issue);
      violations += 1;
    }
    return { ...d, score: c.score };
  });
  const coverage = scored.length ? Math.max(0, 1 - violations / scored.length) : 1;

  // 2) Independent judge on the same raw items.
  const judge = await callAgent<unknown>({
    label: `bucketing:${s.input.mobile}:domain-judge`,
    chain: verifierChain(),
    system: SYSTEM,
    schema: DOMAINS_SCHEMA,
    shapeHint: SHAPE,
    prompt: `Score this candidate's domains.\n\n${fence("evidence items", evidenceItems(x))}`,
    accept: (j) => Array.isArray((j as { domains?: unknown }).domains),
  });

  const analystBy = new Map(capped.map((d) => [d.domain, d]));
  let agreement: number | null = null;
  let adjusted: DomainScore[] = capped;
  let judgePrimary: DomainKey | null = null;
  let primaryGap = 0;
  if (judge.ok) {
    const j = readDomains(judge.json, x);
    judgePrimary = j.primary;
    const judgeBy = new Map(j.domains.map((d) => [d.domain, d]));
    const keys = DOMAIN_KEYS.filter((k) => Math.max(analystBy.get(k)?.score ?? 0, judgeBy.get(k)?.score ?? 0) >= 20);
    const gaps = keys.map((k) => Math.abs((analystBy.get(k)?.score ?? 0) - (judgeBy.get(k)?.score ?? 0)));
    agreement = keys.length ? 1 - gaps.reduce((s2, g) => s2 + g, 0) / keys.length / 100 : 1;

    adjusted = DOMAIN_KEYS.map((k): DomainScore | null => {
      const an = analystBy.get(k);
      const ju = judgeBy.get(k);
      if (!an && !ju) return null;
      const aScore = an?.score ?? 0;
      const jScore = ju?.score ?? 0;
      const gap = Math.abs(aScore - jScore);
      if (gap > JUDGE.blendGap) issues.push(`${k}: analyst ${aScore} vs judge ${jScore} — averaged`);
      const base = an && an.evidence.length ? an : (ju ?? an)!;
      const blended = { ...base, score: gap > JUDGE.blendGap ? Math.round((aScore + jScore) / 2) : aScore };
      // The caps hold for the blended score too.
      return { ...blended, score: capByEvidence(blended, x).score };
    })
      .filter((d): d is DomainScore => d !== null && (d.score > 0 || (BUCKETS as readonly string[]).includes(d.domain)))
      .sort((p, q) => q.score - p.score);

    if (a.primary) primaryGap = Math.abs((analystBy.get(a.primary)?.score ?? 0) - (judgeBy.get(a.primary)?.score ?? 0));
    if (judgePrimary && a.primary && judgePrimary !== a.primary) {
      const jGap = (judgeBy.get(judgePrimary)?.score ?? 0) - (judgeBy.get(a.primary)?.score ?? 0);
      if (jGap > JUDGE.reviseGap) issues.push(`The judge's primary domain is ${judgePrimary}, not ${a.primary} (by ${jGap} points)`);
      primaryGap = Math.max(primaryGap, jGap);
    }
  } else {
    issues.push(`Judge unavailable (${judge.error.slice(0, 120)}) — scores checked deterministically only`);
  }

  const big = primaryGap > JUDGE.reviseGap;
  const canRevise = (s.attempts.domain_analyst ?? 1) <= LIMITS.MAX_REVISE_LOOPS;
  const verdict = big ? (canRevise ? "revise" : "fail") : "pass";
  let trust = verifierTrust(coverage, agreement);
  if (!judge.ok) trust = Math.min(trust, 70);
  const primary = adjusted.find((d) => d.score > 0)?.domain ?? null;

  const review: DomainReview = {
    verdict,
    trust,
    coverage: Number(coverage.toFixed(2)),
    agreement: agreement === null ? null : Number(agreement.toFixed(2)),
    issues: issues.slice(0, 12),
    model: judge.ok ? judge.model : "",
    adjusted,
    primary,
  };
  return {
    domainReview: review,
    ...(judge.ok ? { models: [judge.model] } : {}),
    ...traceEntry(
      "domain_verifier",
      t0,
      `${verdict}; trust ${trust}; agreement ${review.agreement ?? "n/a"}; primary ${primary ?? "none"}${big ? ` (primary gap ${primaryGap})` : ""}`,
      review.model,
    ),
  };
}

/** Back to the analyst once on "revise"; otherwise the branch is done. */
export function routeAfterDomainReview(s: State): "domain_analyst" | "__end__" {
  return s.domainReview?.verdict === "revise" && (s.attempts.domain_analyst ?? 1) <= LIMITS.MAX_REVISE_LOOPS ? "domain_analyst" : "__end__";
}
