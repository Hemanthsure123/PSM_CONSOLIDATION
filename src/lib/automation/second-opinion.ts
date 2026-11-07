import { shortlistBar } from "@/lib/domain-scoring";
import { clearsGates, rankedPlaces, type BoundsConfig } from "@/lib/automation/ranking-bounds";
import type { InternalStanding } from "@/lib/pool/types";
import type { DomainCandidate, SecondOpinion } from "@/lib/types";

/**
 * Second opinions — who gets one, and when two judgements disagree (pure; tested in
 * scripts/screening-perf-selftest.ts).
 *
 * A model's judgement is least reliable exactly where it matters most: next to the shortlist's
 * cut-off. Those candidates are judged again by an independent model (OpenAI, which reads the
 * same file), grounded by the same evidence checks. The second opinion NEVER changes a score or
 * the ranking — a disagreement becomes a review flag ("needs a human look"), so the result stays
 * deterministic and a person decides the close calls.
 */

type Cand = DomainCandidate & { internal?: InternalStanding | null };

/** Fit scores this close to the domain bar count as "near the bar". */
export const NEAR_BAR_POINTS = 8;
/** Places on either side of the top-N cut-off that get a second opinion. */
export const AROUND_CUTOFF = { above: 3, below: 4 };
/** At most this many second opinions per job (cost and time stay bounded). */
export const MAX_SECOND_OPINIONS = 15;
/** Fit scores further apart than this disagree even on the same side of the bar. */
export const SCORE_GAP = 15;

/**
 * The candidates (ids) to judge again, most useful first:
 *  1. the model said every must-have was met but the evidence never names one (overruled) and
 *     the fit would otherwise reach the bar — a wrongly dropped candidate is the costliest miss;
 *  2. the places just above and below the top-N cut-off;
 *  3. fit within NEAR_BAR_POINTS of the bar (with the must-haves met).
 * Candidates who already have a second opinion are skipped.
 */
export function secondOpinionPicks(cands: Cand[], cfg: BoundsConfig | null, max = MAX_SECOND_OPINIONS): string[] {
  const todo = cands.filter((c) => !c.secondOpinion);
  const out: string[] = [];
  const add = (c: Cand) => {
    if (out.length < max && !out.includes(c.id)) out.push(c.id);
  };
  const mandatoryActive = cfg?.mandatoryActive ?? true;

  todo
    .filter((c) => (c.mandatoryOverruled ?? []).length > 0 && c.domainScore >= shortlistBar(c) - NEAR_BAR_POINTS)
    .sort((a, b) => b.domainScore - a.domainScore)
    .forEach(add);

  if (cfg?.topN) {
    const ranked = rankedPlaces(cands.filter((c) => clearsGates(c, cfg)), cfg);
    const from = Math.max(0, cfg.topN - AROUND_CUTOFF.above);
    const to = Math.min(ranked.length, cfg.topN + AROUND_CUTOFF.below);
    const ids = new Set(todo.map((c) => c.id));
    for (const c of ranked.slice(from, to)) if (ids.has(c.id)) add(c);
  }

  todo
    .filter((c) => (!mandatoryActive || c.meetsMandatory) && Math.abs(c.domainScore - shortlistBar(c)) <= NEAR_BAR_POINTS)
    .sort((a, b) => Math.abs(a.domainScore - shortlistBar(a)) - Math.abs(b.domainScore - shortlistBar(b)))
    .forEach(add);
  return out;
}

/** Compare a second judgement with the first, on what decides the shortlist. */
export function compareOpinions(
  first: Pick<Cand, "domainScore" | "meetsMandatory" | "internal" | "mandatoryOverruled"> & Partial<Cand>,
  second: { domainScore: number; meetsMandatory: boolean; scoredBy: string },
  mandatoryActive: boolean,
): Pick<SecondOpinion, "agrees" | "difference"> {
  const bar = shortlistBar(first as Cand);
  const diffs: string[] = [];
  if (mandatoryActive && first.meetsMandatory !== second.meetsMandatory) {
    diffs.push(
      second.meetsMandatory
        ? `${second.scoredBy} finds every must-have met${(first.mandatoryOverruled ?? []).length ? ` (first judgement couldn't find ${first.mandatoryOverruled!.join(", ")})` : ""}`
        : `${second.scoredBy} finds a must-have missing`,
    );
  }
  const firstPasses = first.domainScore >= bar;
  const secondPasses = second.domainScore >= bar;
  if (firstPasses !== secondPasses || Math.abs(first.domainScore - second.domainScore) >= SCORE_GAP) {
    diffs.push(`domain fit ${first.domainScore} vs ${second.domainScore} by ${second.scoredBy} (bar ${bar})`);
  }
  return { agrees: diffs.length === 0, difference: diffs.join("; ") };
}

/** The review flag for a shortlisted candidate whose second opinion disagrees ("" = none). */
export function secondOpinionFlag(c: Cand): string {
  const o = c.secondOpinion;
  return o && !o.agrees ? `Second opinion disagrees — ${o.difference}` : "";
}

/** The flag for a candidate NOT shortlisted whom the second opinion would have let through ("" = none). */
export function possibleMissFlag(c: Cand, mandatoryActive: boolean): string {
  const o = c.secondOpinion;
  if (!o || o.agrees) return "";
  const passes = o.domainScore >= shortlistBar(c) && (!mandatoryActive || o.meetsMandatory);
  return passes ? `Possible miss — the second opinion (${o.scoredBy}) would shortlist: ${o.difference}` : "";
}
