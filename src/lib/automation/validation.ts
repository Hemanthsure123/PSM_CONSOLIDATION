import { shortlistBar } from "@/lib/domain-scoring";
import type { AutomationPlan } from "@/lib/automation/types";
import type { DomainCandidateOutcome } from "@/lib/types";

/**
 * Validation agent — deterministic checks on the ranked result before anything is delivered
 * (tested in scripts/automation-selftest.ts). A flag never removes a candidate; it marks what a
 * person should look at. The job ends AWAITING_REVIEW when a shortlisted candidate is flagged
 * or the run itself is incomplete, COMPLETED otherwise.
 */

/** How close to the domain-fit bar counts as borderline. */
export const NEAR_BAR = 5;

/** Review flags for one shortlisted candidate ("" free). */
export function reviewFlags(c: DomainCandidateOutcome, plan: Pick<AutomationPlan, "github" | "dsa">): string[] {
  const flags: string[] = [];
  const bar = shortlistBar(c);
  if (c.domainScore - bar < NEAR_BAR) flags.push(`Borderline domain fit (${c.domainScore}, bar ${bar})`);
  if (c.domainCapped) flags.push(`Domain score lowered from ${c.rawDomainScore}: ${c.domainCapped}`);
  if (!(c.domainProofs ?? []).length) flags.push("No resume evidence quoted for the domain fit");
  if (plan.github !== "off" && c.githubStatus === "checked") {
    if (c.githubIdentity === "mismatch") flags.push(`GitHub account looks like someone else's (“${c.githubAccountName}”)`);
    const gaps = (c.githubMandatoryGaps ?? []).map((g) => g.tech);
    if (gaps.length) flags.push(`Mandatory not proven in their code: ${gaps.join(", ")}`);
    if (c.githubAiLikelihood === "high") flags.push("High AI-commit signal on GitHub");
  }
  if (plan.github !== "off" && c.githubStatus === "failed") flags.push("GitHub check failed");
  if (plan.dsa.use && c.dsa?.partial) flags.push("A DSA profile couldn't be read in full");
  return flags;
}

export interface RunFacts {
  shortlisted: number;
  /** "Top N" asked for (null = everyone who clears). */
  requested: number | null;
  /** Rows that couldn't be scored after every retry. */
  unscored: number;
  flaggedShortlisted: number;
  briefSource: AutomationPlan["briefSource"];
}

/** COMPLETED, or AWAITING_REVIEW with the reasons. */
export function jobVerdict(f: RunFacts): { status: "completed" | "awaiting_review"; reasons: string[] } {
  const reasons: string[] = [];
  if (f.flaggedShortlisted) reasons.push(`${f.flaggedShortlisted} shortlisted candidate${f.flaggedShortlisted === 1 ? "" : "s"} flagged`);
  if (f.unscored) reasons.push(`${f.unscored} resume${f.unscored === 1 ? "" : "s"} couldn't be screened`);
  if (f.requested !== null && f.shortlisted < f.requested) reasons.push(`only ${f.shortlisted} of ${f.requested} cleared every requirement`);
  if (f.briefSource === "focus") reasons.push("the focus text was used as is (the model couldn't draft the criteria)");
  return { status: reasons.length ? "awaiting_review" : "completed", reasons };
}
