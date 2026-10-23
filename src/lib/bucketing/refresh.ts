import { isBucket, stageLabel, type Bucket } from "@/lib/bucketing/config";
import { internalScore, overallScore } from "@/lib/bucketing/scoring";
import { hireTrackBuckets, journeyClosed, tierOf, type BucketingCandidateInput, type BucketingResult } from "@/lib/bucketing/types";

/**
 * Candidate Bucketing — loading a newer interview export into a saved run.
 * Client-safe and pure, so the dashboard and the terminal runner plan it the same way:
 *  - new phones are added and run;
 *  - a change that can move the bucket (the TR-2 hire tracks, a closed / reopened
 *    journey, a new resume link) re-runs the candidate;
 *  - a change that only moves the tier, the tag or the internal-assessment score
 *    (a verdict upgrade within the same track, TR-1 cleared, new scores) is re-scored
 *    here from the saved evidence — no model or GitHub calls;
 *  - everything else stays as it is.
 */

export interface RefreshPlan {
  /** Phones not in the run yet. */
  added: BucketingCandidateInput[];
  /** Updated records whose bucket may change — evaluate again. */
  rerun: BucketingCandidateInput[];
  /** Updated records re-scored from the saved evidence, with their new results. */
  rescored: { candidate: BucketingCandidateInput; result: BucketingResult }[];
  /** Updated records with no result yet (they run when the run resumes). */
  waiting: BucketingCandidateInput[];
  unchanged: number;
}

const LINKS = ["resumeUrl", "githubUrl", "leetcodeUrl", "codechefUrl", "codeforcesUrl"] as const;

/** The newer record, keeping links the run already had when the newer file has none (e.g. no resume sheet this time). */
function merge(prev: BucketingCandidateInput, next: BucketingCandidateInput): BucketingCandidateInput {
  const out: BucketingCandidateInput = { ...next, batch: prev.batch };
  for (const k of LINKS) if (!out[k] && prev[k]) out[k] = prev[k];
  if (!out.name && prev.name) out.name = prev.name;
  return out;
}

const interviewKey = (c: BucketingCandidateInput) =>
  JSON.stringify([c.stage, c.track ?? "", c.verdict ?? "", c.interview ?? null, c.externalId ?? "", c.email ?? "", c.college ?? "", c.name]);
const linksKey = (c: BucketingCandidateInput) => LINKS.map((k) => c[k] ?? "").join("|");

/** Would the change move the bucket? Then only a fresh evaluation is right. */
function bucketMayMove(prev: BucketingCandidateInput, next: BucketingCandidateInput, r: BucketingResult): boolean {
  return (
    r.status === "retry_needed" ||
    linksKey(prev) !== linksKey(next) ||
    journeyClosed(prev) !== journeyClosed(next) ||
    hireTrackBuckets(prev).join() !== hireTrackBuckets(next).join()
  );
}

/** The strongest bucket domain the saved result scored. */
function topBucket(r: BucketingResult): Bucket | null {
  const top = r.domains.filter((d) => isBucket(d.domain) && d.score > 0).sort((a, b) => b.score - a.score)[0];
  return top && isBucket(top.domain) ? top.domain : null;
}

/** A saved result with the newer interview data: tier, tag, internal-assessment and overall scores. */
export function rescoreResult(r: BucketingResult, c: BucketingCandidateInput): BucketingResult {
  const sb = (isBucket(r.bucket) ? r.bucket : null) ?? hireTrackBuckets(c)[0] ?? topBucket(r);
  const internal = internalScore(c.interview, c.verdict, sb);
  const scores = { ...r.scores, internal: internal.score };
  scores.overall = overallScore(scores);
  const label = stageLabel(c.stage, c.track, c.verdict ?? null);
  const before = `${r.stageLabel} · internal ${r.scores.internal}`;
  return {
    ...r,
    name: c.name || r.name,
    stage: c.stage,
    track: c.track,
    verdict: c.verdict ?? null,
    stageLabel: label,
    priorityTier: tierOf(c),
    interview: c.interview ?? null,
    internalParts: internal.parts,
    scores,
    trace: [...r.trace, { node: "refresh", ms: 0, decision: `newer interview export: ${before} → ${label} · internal ${internal.score}` }],
  };
}

/**
 * Plan loading `incoming` (a newer export, already parsed) into a run holding
 * `current` candidates and their `results`.
 */
export function planRefresh(
  current: BucketingCandidateInput[],
  results: Record<string, BucketingResult>,
  incoming: BucketingCandidateInput[],
): RefreshPlan {
  const byId = new Map(current.map((c) => [c.id, c]));
  const plan: RefreshPlan = { added: [], rerun: [], rescored: [], waiting: [], unchanged: 0 };
  for (const raw of incoming) {
    const prev = byId.get(raw.id);
    if (!prev) {
      plan.added.push(raw);
      continue;
    }
    const next = merge(prev, raw);
    if (interviewKey(prev) === interviewKey(next) && linksKey(prev) === linksKey(next)) {
      plan.unchanged += 1;
      continue;
    }
    const r = results[next.id];
    if (!r) plan.waiting.push(next);
    else if (bucketMayMove(prev, next, r)) plan.rerun.push(next);
    else plan.rescored.push({ candidate: next, result: rescoreResult(r, next) });
  }
  return plan;
}
