import type {
  AssignmentSpec,
  CandidateEvaluation,
  CandidateInput,
  CriterionResult,
  CriterionStatus,
  CtcBand,
  SelectionStatus,
  Thresholds,
} from "@/lib/assignment-types";

/**
 * Deterministic scoring for Assignment Evaluation. The model only judges each
 * criterion (status + 0–10 score + evidence); every total, status and chance is
 * computed here so it is explainable, consistent across models, and can be
 * recomputed on the client when thresholds change or copy detection fires —
 * without another LLM call. Pure module: safe on client and server.
 */

export const CTC_BANDS: { value: CtcBand; label: string; thresholds: Thresholds }[] = [
  { value: "lt6", label: "Below 6 LPA", thresholds: { strong: 75, shortlist: 60, borderline: 50 } },
  { value: "6to8", label: "6 – 8 LPA", thresholds: { strong: 80, shortlist: 68, borderline: 55 } },
  { value: "8to12", label: "8 – 12 LPA", thresholds: { strong: 85, shortlist: 72, borderline: 60 } },
  { value: "12to20", label: "12 – 20 LPA", thresholds: { strong: 88, shortlist: 78, borderline: 65 } },
  { value: "20plus", label: "20+ LPA", thresholds: { strong: 90, shortlist: 82, borderline: 70 } },
];

export const DEFAULT_BAND: CtcBand = "8to12";

export function bandThresholds(band: CtcBand): Thresholds {
  return { ...(CTC_BANDS.find((b) => b.value === band) ?? CTC_BANDS[2]).thresholds };
}

export function bandLabel(band: CtcBand): string {
  return (CTC_BANDS.find((b) => b.value === band) ?? CTC_BANDS[2]).label;
}

/** Score range each status may carry — a "met" can't score 2, a "not_met" can't score 8. */
const STATUS_RANGE: Record<CriterionStatus, [number, number]> = {
  met: [6, 10],
  partial: [2, 7],
  not_met: [0, 1],
  unverified: [0, 5],
};

export function clampCriterionScore(status: CriterionStatus, score: number): number {
  const [lo, hi] = STATUS_RANGE[status];
  const s = Number.isFinite(score) ? score : lo;
  return Math.round(Math.min(hi, Math.max(lo, s)) * 10) / 10;
}

/** Share of the final score that comes from the model's architecture + code-quality judgement. */
const QUALITY_SHARE = 0.15;
/** Pairs at or above this Jaccard similarity are flagged as possible copies. */
export const SIMILARITY_FLAG = 0.6;

function pct(results: CriterionResult[], weights: Map<string, number>): number {
  let got = 0;
  let max = 0;
  for (const r of results) {
    const w = weights.get(r.id) ?? 0;
    got += (r.score / 10) * w;
    max += w;
  }
  return max > 0 ? Math.round((got / max) * 1000) / 10 : 0;
}

/**
 * Recompute overall score, sub-scores, mandatory coverage, selection status
 * and shortlist chance from the per-criterion judgements.
 *
 * Overall = 85% weighted criteria score + 15% (architecture + code quality).
 * Status (critical = restriction violation, possible copy, prompt injection,
 * commits after the deadline):
 *  - Invalid Submission — repo missing / private / empty / not code.
 *  - Strongly Shortlisted — every mandatory "met", overall ≥ strong, nothing critical.
 *  - Shortlisted — every mandatory "met", overall ≥ shortlist, nothing critical.
 *  - Borderline – Manual Review — overall ≥ borderline and no mandatory "not_met"
 *    (i.e. gaps are only partial / unverified, or something critical needs a human).
 *  - Not Shortlisted — otherwise. A mandatory requirement that is clearly
 *    missing can never be better than this.
 *  - AI Generated – Review Manually — replaces any of the three positive
 *    statuses when the AI review found hard evidence of AI-generated work, so
 *    such a submission is never auto-shortlisted (it also counts as critical).
 *
 * Chance = logistic((overall − shortlist) / 6) × mandatoryCoverage², ×0.25 when
 * a mandatory is missing, ×0.5 when something critical was flagged; 0–99.
 */
export function scoreEvaluation(ev: CandidateEvaluation, spec: AssignmentSpec, t: Thresholds): CandidateEvaluation {
  if (ev.error || ev.invalid) {
    return {
      ...ev,
      status: ev.invalid ? "Invalid Submission" : "Error",
      overall: 0,
      chance: 0,
      mandatoryMet: 0,
      mandatoryTotal: spec.criteria.filter((c) => c.enabled && c.type === "mandatory").length,
      scores: { mandatory: 0, good: 0, excellence: 0, architecture: 0, codeQuality: 0 },
    };
  }

  const enabled = spec.criteria.filter((c) => c.enabled);
  const weights = new Map(enabled.map((c) => [c.id, Math.max(1, c.weight)]));
  const byId = new Map(ev.criteria.map((r) => [r.id, r]));
  // A criterion the model skipped counts as unverified with no credit.
  const results = enabled.map<CriterionResult>(
    (c) => byId.get(c.id) ?? { id: c.id, status: "unverified", score: 0, evidence: "Not assessed by the model.", files: [] },
  );
  const typeOf = new Map(enabled.map((c) => [c.id, c.type]));
  const of = (type: string) => results.filter((r) => typeOf.get(r.id) === type);

  const mandatory = of("mandatory");
  const criteriaPct = pct(results, weights);
  const architecture = Math.round(ev.architecture.score * 10);
  const codeQuality = Math.round(ev.codeQuality.score * 10);
  const overall = Math.round((criteriaPct * (1 - QUALITY_SHARE) + ((architecture + codeQuality) / 2) * QUALITY_SHARE) * 10) / 10;

  const mandatoryMet = mandatory.filter((r) => r.status === "met").length;
  const mandatoryMissing = mandatory.some((r) => r.status === "not_met");
  const allMandatoryMet = mandatoryMet === mandatory.length;
  const coverage = mandatory.length ? mandatory.reduce((s, r) => s + r.score / 10, 0) / mandatory.length : 1;

  const critical =
    ev.restrictionViolations.length > 0 ||
    ev.similarity.some((s) => s.ratio >= SIMILARITY_FLAG) ||
    ev.redFlags.some((f) => /prompt.?injection/i.test(f)) ||
    (ev.repo?.commitsAfterDeadline ?? 0) > 0 ||
    ev.aiReview?.verdict === "ai-generated";

  let status: SelectionStatus;
  if (allMandatoryMet && !critical && overall >= t.strong) status = "Strongly Shortlisted";
  else if (allMandatoryMet && !critical && overall >= t.shortlist) status = "Shortlisted";
  else if (!mandatoryMissing && overall >= t.borderline) status = "Borderline – Manual Review";
  else status = "Not Shortlisted";
  if (ev.aiReview?.verdict === "ai-generated" && status !== "Not Shortlisted") status = "AI Generated – Review Manually";

  let chance = (100 / (1 + Math.exp(-(overall - t.shortlist) / 6))) * coverage * coverage;
  if (mandatoryMissing) chance *= 0.25;
  if (critical) chance *= 0.5;
  chance = Math.round(Math.min(99, Math.max(0, chance)));

  return {
    ...ev,
    criteria: results,
    status,
    overall,
    chance,
    mandatoryMet,
    mandatoryTotal: mandatory.length,
    scores: {
      mandatory: pct(mandatory, weights),
      good: pct(of("good"), weights),
      excellence: pct(of("excellence"), weights),
      architecture,
      codeQuality,
    },
  };
}

/** Sort key: best first; errors and invalid submissions last. */
export const STATUS_ORDER: Record<SelectionStatus, number> = {
  "Strongly Shortlisted": 0,
  Shortlisted: 1,
  "Borderline – Manual Review": 2,
  "AI Generated – Review Manually": 3,
  "Not Shortlisted": 4,
  "Invalid Submission": 5,
  Error: 6,
};

export function rankEvaluations(list: CandidateEvaluation[]): CandidateEvaluation[] {
  return [...list].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.overall - a.overall);
}

/** Canonical `owner/repo` of a resolved link, lower-cased. */
function repoKey(ev: CandidateEvaluation): string {
  const m = (ev.repo?.resolvedRepo ?? "").match(/github\.com\/([^/]+\/[^/#?]+)/i);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Cross-candidate copy detection over the whole run:
 *  - the same repository submitted by two candidates;
 *  - one candidate's repo is a fork of another candidate's repo;
 *  - Jaccard similarity of source-file fingerprints ≥ SIMILARITY_FLAG, after
 *    discarding hashes shared by many candidates (starter-template boilerplate).
 * Returns a new map with `similarity` filled for every candidate.
 */
export function applySimilarity(results: Record<string, CandidateEvaluation>): Record<string, CandidateEvaluation> {
  const list = Object.values(results).filter((r) => !r.error && !r.invalid);
  const n = list.length;
  const df = new Map<string, number>();
  for (const r of list) for (const h of new Set(r.fingerprint)) df.set(h, (df.get(h) ?? 0) + 1);
  const commonCut = Math.max(2, Math.ceil(n * 0.2));
  const sets = new Map(list.map((r) => [r.id, new Set(r.fingerprint.filter((h) => (df.get(h) ?? 0) <= commonCut))]));

  const out: Record<string, CandidateEvaluation> = {};
  for (const [id, r] of Object.entries(results)) out[id] = { ...r, similarity: [] };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = list[i];
      const b = list[j];
      let ratio = 0;
      let reason = "";
      const ka = repoKey(a);
      const kb = repoKey(b);
      if (ka && ka === kb) {
        ratio = 1;
        reason = "same repository submitted";
      } else if (a.repo?.forkOf && a.repo.forkOf.toLowerCase() === kb) {
        ratio = 1;
        reason = `fork of ${b.id}'s repository`;
      } else if (b.repo?.forkOf && b.repo.forkOf.toLowerCase() === ka) {
        ratio = 1;
        reason = `fork of ${a.id}'s repository`;
      } else {
        const sa = sets.get(a.id)!;
        const sb = sets.get(b.id)!;
        if (sa.size >= 5 && sb.size >= 5) {
          let inter = 0;
          for (const h of sa) if (sb.has(h)) inter++;
          const jac = inter / (sa.size + sb.size - inter);
          if (inter >= 5 && jac >= SIMILARITY_FLAG) {
            ratio = Math.round(jac * 100) / 100;
            reason = `${inter} identical source files`;
          }
        }
      }
      if (ratio >= SIMILARITY_FLAG) {
        out[a.id].similarity.push({ with: b.id, ratio, reason });
        out[b.id].similarity.push({ with: a.id, ratio, reason });
      }
    }
  }
  return out;
}

/** Similarity + scoring for every result — the single "finalize" step used everywhere. */
export function finalizeResults(
  results: Record<string, CandidateEvaluation>,
  spec: AssignmentSpec,
  t: Thresholds,
): Record<string, CandidateEvaluation> {
  const withSim = applySimilarity(results);
  const out: Record<string, CandidateEvaluation> = {};
  for (const [id, r] of Object.entries(withSim)) out[id] = scoreEvaluation(r, spec, t);
  return out;
}

/** An empty evaluation for a candidate (status "Error" until filled in). */
export function blankEvaluation(c: CandidateInput): CandidateEvaluation {
  return {
    id: c.id,
    githubUrl: c.githubUrl,
    status: "Error",
    overall: 0,
    chance: 0,
    mandatoryMet: 0,
    mandatoryTotal: 0,
    scores: { mandatory: 0, good: 0, excellence: 0, architecture: 0, codeQuality: 0 },
    criteria: [],
    implementedFeatures: [],
    missingFeatures: [],
    architecture: { score: 0, pattern: "", strengths: [], issues: [] },
    codeQuality: { score: 0, notes: "" },
    restrictionViolations: [],
    redFlags: [],
    similarity: [],
    remarks: "",
    repo: null,
    fingerprint: [],
    model: "",
    error: "",
    invalid: false,
    evaluatedAt: new Date().toISOString(),
  };
}
