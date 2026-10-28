import { githubStrengthNotOnResume, githubTechsNotOnResume, rankParts } from "@/lib/domain-scoring";
import { bestRating } from "@/lib/dsa-scoring";
import { DSA_PLATFORMS } from "@/lib/dsa-types";
import { isAssessed } from "@/lib/pool/match";
import { PRODUCT_LABEL, type InternalStanding } from "@/lib/pool/types";
import type { DomainCandidateOutcome, DomainGithubStatus } from "@/lib/types";

/**
 * Domain Shortlisting — "Signals": why each candidate is where they are, as short lines a
 * recruiter can read in the CSV (one bullet each): the outcome and its priority, how the rank
 * score is made, the internal assessment, the domain fit and the resume's own words behind it,
 * the skills proven in projects / experience, mandatory and experience, GitHub (code, review,
 * identity, AI-commit signal), DSA and presentation. Pure; built from the same numbers the
 * ranking used, so the explanation always matches the order.
 */

export interface SignalsContext {
  useGithub: boolean;
  /** Any GitHub inspection ran (the rank, the commits gate or the latest-commit lookup). */
  githubChecked: boolean;
  useDsa: boolean;
  checkPresentation: boolean;
  mandatoryActive: boolean;
  requireExperience: boolean;
  /** How many were shortlisted. */
  shortlisted: number;
  /** The eligible pool was looked up for this run (a phone / user id column was mapped). */
  poolChecked: boolean;
}

export const GITHUB_STATUS_TEXT: Record<DomainGithubStatus, string> = {
  off: "not run",
  "no-link": "no GitHub link on the resume",
  "not-inspected": "not inspected",
  checked: "checked",
  "no-repos": "no public repositories with code",
  "not-found": "the GitHub user on the resume doesn't exist",
  failed: "the check failed",
};

const PRIORITY_TEXT: Record<1 | 2 | 3, string> = {
  1: "priority 1 — internally assessed, good resume (domain fit 55+)",
  2: "priority 2 — internally assessed, average resume (domain fit 40–54)",
  3: "priority 3 — external candidate, good resume (domain fit 55+)",
};

const STAGE_TEXT: Record<1 | 2 | 3 | 4, string> = { 1: "TR-2 cleared / top level", 2: "TR-1 cleared", 3: "assessment cleared", 4: "assessed, not eligible" };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function candidateSignals(c: DomainCandidateOutcome, ctx: SignalsContext): string[] {
  const out: string[] = [];
  const parts = rankParts(c, ctx.useGithub, ctx.checkPresentation, ctx.useDsa);
  const prio = c.priority && c.priority > 0 ? PRIORITY_TEXT[c.priority as 1 | 2 | 3] : "";

  // Where they landed, and why there.
  if (c.shortlisted) out.push(`Shortlisted at rank ${c.rank} of ${ctx.shortlisted}${prio ? ` · ${prio}` : ""}`);
  else if (c.rank) out.push(`${c.outcomeReason}${prio ? ` · ${prio}` : ""}`);
  else out.push(`Not shortlisted — ${c.outcomeReason}`);
  if (c.rank) {
    const bits = [`domain fit ${parts.fit}`];
    if (ctx.useGithub) bits.push(`GitHub +${parts.github}`);
    if (ctx.useDsa) bits.push(`DSA +${parts.dsa}`);
    if (ctx.checkPresentation) bits.push(`presentation +${parts.presentation}`);
    out.push(
      `Rank score ${parts.total} = ${bits.join(" + ")}${isAssessed(c.internal) ? " — assessed candidates are ordered by internal stage first (TR-2 → TR-1 → assessment), then by this score" : ""}`,
    );
  }

  // Internal assessments.
  if (isAssessed(c.internal)) {
    out.push(`Internal assessment: ${c.internal.label} — ${STAGE_TEXT[c.internal.tier]} in ${PRODUCT_LABEL[c.internal.product]} (matched by ${c.internal.matchedBy === "phone" ? "phone" : "user id"})`);
  } else if (c.internal) {
    out.push(`In the eligible pool but not eligible: ${(c.internal as InternalStanding).label}`);
  } else if (ctx.poolChecked) {
    out.push("External — not in the eligible pool (Edge 1.0, Edge 2.0, Academy)");
  }

  // Resume: domain fit and its evidence.
  out.push(
    `Domain fit ${c.domainScore}/100${c.domainCapped ? ` (the model said ${c.rawDomainScore}; lowered: ${c.domainCapped})` : ""}${c.evidence ? ` — ${clip(c.evidence, 160)}` : ""}`,
  );
  for (const p of (c.domainProofs ?? []).slice(0, 2)) {
    out.push(`Resume ${p.source === "skill" ? `— ${p.skill}` : `(${p.source})`}: “${clip(p.quote, 160)}”`);
  }
  if (c.coreSkills.length) out.push(`Skills shown in projects / experience: ${c.coreSkills.join(", ")}`);
  if (ctx.mandatoryActive) out.push(c.meetsMandatory ? "Meets every mandatory requirement" : "Misses at least one mandatory requirement");
  if (c.hasDomainExperience && c.experience) out.push(`Domain experience: ${clip(c.experience, 160)}`);
  else if (ctx.requireExperience) out.push("No domain internship / job on the resume (required)");

  // GitHub.
  if (ctx.githubChecked) {
    if (c.githubStatus === "checked") {
      const repos = `${c.githubMatches} domain repo${c.githubMatches === 1 ? "" : "s"}, ${c.githubCommits2y} commits in 2 years`;
      const techs = c.githubTechs.length ? `; their code proves ${c.githubTechs.slice(0, 6).join(", ")}` : "";
      out.push(`GitHub ${c.githubScore}/100${ctx.useGithub ? ` (+${parts.github} rank points)` : ""}: ${repos}${techs}`);
      if (c.githubIdentity === "mismatch") out.push(`GitHub account name “${c.githubAccountName}” doesn't match the candidate — GitHub isn't counted in the rank`);
      const review = c.projectReview;
      if (review?.status === "reviewed" && review.reviews[0]) out.push(`Code review ${review.score}/100 of ${review.reviews[0].repo}: ${clip(review.reviews[0].summary, 180)}`);
      const gaps = (c.githubMandatoryGaps ?? []).map((g) => g.tech);
      if (gaps.length) out.push(`Mandatory not proven in their code: ${gaps.join(", ")}`);
      if (c.githubClaimedNotFound?.length) out.push(`On the resume but not found in their code: ${c.githubClaimedNotFound.join(", ")}`);
      const extra = githubTechsNotOnResume(c);
      if (githubStrengthNotOnResume(c)) out.push(`Strong domain code on GitHub that the resume doesn't show${extra.length ? ` (${extra.join(", ")})` : ""}`);
      if (c.githubAiLikelihood === "medium" || c.githubAiLikelihood === "high") out.push(`AI-commit signal ${c.githubAiLikelihood}: ${clip(c.githubAiSummary, 160)}`);
    } else if (c.githubStatus !== "off") {
      out.push(`GitHub: ${GITHUB_STATUS_TEXT[c.githubStatus]}${c.githubNote ? ` — ${clip(c.githubNote, 140)}` : ""}`);
    }
  }

  // DSA.
  if (ctx.useDsa) {
    const d = c.dsa;
    const lines = d
      ? DSA_PLATFORMS.map(({ key, label }) => {
          const p = d[key];
          if (!p?.url || p.found !== true) return "";
          const r = bestRating(p);
          return [label, typeof p.solved === "number" ? `${p.solved} solved` : "", typeof p.contests === "number" ? `${p.contests} contests` : "", r ? `rating ${r}` : ""].filter(Boolean).join(" ");
        }).filter(Boolean)
      : [];
    out.push(lines.length ? `DSA ${d!.score}/100 (+${parts.dsa} rank points): ${lines.join("; ")}` : "DSA: no coding profile could be read");
  }

  // Presentation.
  if (ctx.checkPresentation) out.push(`Resume presentation ${c.presentationScore}/100 (+${parts.presentation})${c.presentationNotes ? `: ${clip(c.presentationNotes, 140)}` : ""}`);
  return out;
}
