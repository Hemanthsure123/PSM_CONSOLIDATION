"use server";

import { htmlToPdf } from "@/lib/pdf";
import { buildDomainReportHtml, type DomainCardInput } from "@/lib/domain-report-template";
import { storePdf } from "@/lib/report-storage";
import { buildJdTechSpec, checkGithubAccess, describeJdTechSpec } from "@/lib/github-analysis";
import { mapWithConcurrency } from "@/lib/rate-limit";
import { GITHUB_BATCH_SIZE, MIN_DOMAIN_SCORE, combinedScore, compareShortlist, gateFailure, githubEvidenceScore, priorityGroup, shortlistBar } from "@/lib/domain-scoring";
import { candidateSignals } from "@/lib/domain-signals";
import { isAssessed } from "@/lib/pool/match";
import type { InternalStanding } from "@/lib/pool/types";
import { bestRating, type DsaGates } from "@/lib/dsa-scoring";
import {
  inspectDomainGithub,
  screenDomainCandidate,
  type DomainScreenOptions,
  type GithubInspectInput,
  type GithubInspectResult,
} from "@/lib/domain-screen";
import { slugify } from "@/lib/utils";
import type { ActionResult, DomainCandidate, DomainCandidateOutcome, DomainCandidateRow, DomainReportResult } from "@/lib/types";

/**
 * Assess ONE candidate's fit for `domain`. The browser now screens candidates in
 * parallel through /api/domain/analyze (server actions from one page run one at a
 * time); this action stays for callers that still use it. See domain-screen.ts.
 */
export async function analyzeDomainCandidate(
  row: DomainCandidateRow,
  opts: DomainScreenOptions,
): Promise<ActionResult<DomainCandidate>> {
  const res = await screenDomainCandidate(row, opts);
  return res.ok ? { ok: true, data: res.candidate } : { ok: false, error: res.error };
}

/**
 * Before a run that inspects GitHub: is the token usable, how much quota is left, and
 * which technologies will the deep inspection look for? A rejected or exhausted token
 * fails the run up front with a clear message — instead of every candidate silently
 * scoring 0 on GitHub (and a commits gate then dropping all of them).
 */
export async function checkGithubForDomain(
  domain: string,
  mandatory: string,
): Promise<ActionResult<{ remaining: number; limit: number; resetAt: string; core: string[]; languages: string[] }>> {
  const access = await checkGithubAccess();
  if (!access.ok) return { ok: false, error: access.message };
  const techs = describeJdTechSpec(buildJdTechSpec(mandatory, domain, { modelledOnly: true }));
  return { ok: true, data: { remaining: access.remaining, limit: access.limit, resetAt: access.resetAt, ...techs } };
}

/**
 * Deep-inspect a small batch of domain-fit candidates concurrently. The browser now
 * inspects in parallel through /api/domain/github; this action stays for callers that
 * still use it.
 */
export async function inspectGithubBatch(
  inputs: GithubInspectInput[],
  domain: string,
  mandatory: string,
): Promise<ActionResult<GithubInspectResult[]>> {
  try {
    const results = await mapWithConcurrency(inputs, GITHUB_BATCH_SIZE, (input) => inspectDomainGithub(input, domain, mandatory));
    return { ok: true, data: results };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "GitHub inspection failed." };
  }
}

/**
 * Keep the domain-fit candidates, rank them, take the best `topN` (or all of them
 * when `limitToTopN` is off), render the shortlist report and store it (Drive,
 * falling back to a local file). The returned `candidates` feed the CSV +
 * preview table: the top-N, or with the limit off every scanned candidate with
 * its shortlist outcome.
 */
export async function buildDomainReport(
  candidates: DomainCandidate[],
  opts: {
    domain: string;
    topN: number;
    /** Cut the shortlist to the best `topN`; off = shortlist everyone who clears the gates. */
    limitToTopN: boolean;
    runName: string;
    resumesScanned: number;
    useDsa: boolean;
    useGithub: boolean;
    /** Show each candidate's latest domain commit date (looked up during GitHub inspection). */
    showDomainCommit: boolean;
    /** Show the scan-summary stat strip in the report. */
    showStats: boolean;
    /** Build and store the PDF report. Off = rank and return the outcomes only (table + CSVs). Default on. */
    generateReport?: boolean;
    /** Strict gates. 0 disables a numeric gate; the *Active flags gate on booleans. */
    /** @deprecated LeetCode-only gate of older clients — use `dsaGates.minSolved`. */
    minLeetcode?: number;
    /** DSA gates (solved / contests / rating / DSA score across LeetCode, Codeforces, CodeChef). */
    dsaGates?: DsaGates;
    minCommits: number;
    mandatoryActive: boolean;
    requireExperience: boolean;
    /** Resume presentation was graded (shows the score in the report/CSV). */
    checkPresentation: boolean;
    /** Presentation gate; 0 = grade and rank on it, but exclude nobody. */
    minPresentation: number;
    /** The eligible pool was looked up (a phone / user id column was mapped) — for the Signals. */
    poolChecked?: boolean;
  },
): Promise<ActionResult<DomainReportResult>> {
  const { domain, topN, limitToTopN, runName, resumesScanned, useDsa, useGithub, showDomainCommit, showStats, minCommits, mandatoryActive, requireExperience, checkPresentation, minPresentation } = opts;
  const gates = {
    mandatoryActive,
    requireExperience,
    minLeetcode: opts.minLeetcode ?? 0,
    dsaGates: opts.dsaGates,
    minCommits,
    checkPresentation,
    minPresentation,
  };

  // Domain-fit floor first, then the STRICT gates — a candidate must clear every
  // enabled one and is dropped at the first it fails. Track how many each gate
  // removes so the UI can explain the funnel, and keep the reason per candidate
  // for the all-candidates view.
  const excluded = { mandatory: 0, leetcode: 0, dsa: 0, commits: 0, experience: 0, presentation: 0 };
  const rejectionReason = (c: DomainCandidate): string => {
    const bar = shortlistBar(c);
    if (c.domainScore < bar) {
      return isAssessed(c.internal)
        ? `Domain fit ${c.domainScore} is below the ${bar} bar for internally assessed candidates`
        : `Domain fit ${c.domainScore} is below the ${MIN_DOMAIN_SCORE} bar`;
    }
    const failed = gateFailure(c, gates);
    if (!failed) return "";
    excluded[failed.gate]++;
    return failed.reason;
  };
  const judged = candidates.map((c) => ({ c, reason: rejectionReason(c) }));

  // Internally assessed people first (eligible pool): priority group, then their internal
  // stage, then the combined score — resume domain fit plus the live GitHub signal and,
  // when graded, DSA and the resume's presentation polish.
  const byRank = (a: DomainCandidate, b: DomainCandidate) => compareShortlist(a, b, useGithub, checkPresentation, useDsa);
  const matches = judged.filter((j) => !j.reason).map((j) => j.c).sort(byRank);
  const considered = matches.length;
  const ranked = limitToTopN ? matches.slice(0, Math.max(1, topN)) : matches;

  // GitHub shown on a card only when it counted: an account that clearly belongs to someone else doesn't.
  const ghShown = (c: DomainCandidate) => useGithub && c.githubIdentity !== "mismatch";
  const cards: DomainCardInput[] = ranked.map((c, i) => ({
    rank: i + 1,
    name: c.name,
    coreSkills: c.coreSkills,
    evidence: c.evidence,
    experience: c.experience,
    resumeUrl: c.resumeUrl,
    assessmentReport: c.assessmentReport,
    tr1Panelist: c.tr1Panelist,
    tr1PanelLinkedin: c.tr1PanelLinkedin,
    tr1Recording: c.tr1Recording,
    tr2Panelist: c.tr2Panelist,
    tr2PanelLinkedin: c.tr2PanelLinkedin,
    tr2Recording: c.tr2Recording,
    placedCompany: c.placedCompany,
    ctc: c.ctc,
    githubProfile: c.githubProfile,
    githubMatches: ghShown(c) ? c.githubMatches : 0,
    githubScore: ghShown(c) ? githubEvidenceScore(c) : 0,
    githubTechs: ghShown(c) ? c.githubTechs : [],
    projectReview:
      ghShown(c) && c.projectReview?.status === "reviewed" && c.projectReview.reviews[0]
        ? {
            repo: c.projectReview.reviews[0].repo,
            repoUrl: c.projectReview.reviews[0].repoUrl,
            summary: c.projectReview.reviews[0].summary,
            features: c.projectReview.reviews[0].features.map((f) => f.name).slice(0, 5),
          }
        : undefined,
    githubTopRepos: ghShown(c) ? c.githubTopRepos : [],
    // Presentation shown only when it was actually graded this run.
    presentationScore: checkPresentation ? c.presentationScore : 0,
    presentationNotes: checkPresentation ? c.presentationNotes : "",
    showPresentation: checkPresentation,
    // Coding stats shown only when the relevant fetch was enabled.
    leetcodeSolved: useDsa ? c.leetcodeSolved : 0,
    codeforcesSolved: useDsa ? c.codeforcesSolved : 0,
    codechefSolved: useDsa ? (c.dsa?.codechef.solved ?? 0) : 0,
    dsaScore: useDsa ? (c.dsa?.score ?? 0) : 0,
    ratings: useDsa && c.dsa
      ? { codeforces: bestRating(c.dsa.codeforces), codechef: bestRating(c.dsa.codechef), leetcode: bestRating(c.dsa.leetcode) }
      : { codeforces: null, codechef: null, leetcode: null },
    githubCommits2y: ghShown(c) ? c.githubCommits2y : 0,
    lastDomainCommit: showDomainCommit ? c.githubLastDomainCommit : null,
    assessedLine: assessedLine(c.internal),
    showCoding: useDsa || useGithub || showDomainCommit,
  }));

  // Every evaluated candidate gets an outcome (the shortlist CSV and the
  // complete-screening CSV are both cut from this on the client):
  //   1. the shortlist, best first — rank = position;
  //   2. with a top-N limit, those who cleared every gate but ranked below it —
  //      their rank continues (N+1, N+2 …);
  //   3. everyone a gate or the domain-fit bar dropped — strongest first, with the reason.
  const outcomes: DomainCandidateOutcome[] = ranked.map((c, i) => ({ ...c, rank: i + 1, shortlisted: true, outcomeReason: "", priority: priorityGroup(c) ?? 0 }));
  if (limitToTopN) {
    matches.slice(ranked.length).forEach((c, i) => {
      const rank = ranked.length + i + 1;
      outcomes.push({
        ...c,
        rank,
        shortlisted: false,
        outcomeReason: `Cleared every gate — ranked #${rank} of ${considered}, outside the top ${ranked.length}`,
        priority: priorityGroup(c) ?? 0,
      });
    });
  }
  const dropped = judged.filter((j) => j.reason).sort((a, b) => byRank(a.c, b.c));
  for (const { c, reason } of dropped) outcomes.push({ ...c, rank: 0, shortlisted: false, outcomeReason: reason, priority: 0 });
  // The rank score and, line by line, why each candidate is where they are (the CSV's Signals).
  const signalCtx = {
    useGithub,
    githubChecked: useGithub || minCommits > 0 || showDomainCommit,
    useDsa,
    checkPresentation,
    mandatoryActive,
    requireExperience,
    shortlisted: ranked.length,
    poolChecked: Boolean(opts.poolChecked),
  };
  for (const o of outcomes) {
    o.rankScore = combinedScore(o, useGithub, checkPresentation, useDsa);
    o.signals = candidateSignals(o, signalCtx);
  }
  const base = { shortlisted: cards.length, considered, candidates: outcomes, excluded, limitedToTopN: limitToTopN };

  // Report switched off: same ranking and outcomes, just no PDF render / upload.
  if (opts.generateReport === false) {
    return { ok: true, data: { link: "", storage: "local", ...base, reportSkipped: true } };
  }

  try {
    const html = buildDomainReportHtml({
      runName,
      domain: domain.trim(),
      resumesScanned,
      candidatesConsidered: considered,
      candidates: cards,
      showStats,
      limitedToTopN: limitToTopN,
    });
    // Multi-page: a top-10 will not fit on one A4 and must not be clipped.
    const pdf = await htmlToPdf(html, { singlePage: false });
    const fileName = `Domain-${slugify(domain || "shortlist")}-${limitToTopN ? "top" : "shortlisted"}${cards.length}.pdf`;
    const stored = await storePdf(pdf, fileName);
    return { ok: true, data: { link: stored.link, storage: stored.storage, ...base } };
  } catch (err) {
    // The PDF failed (commonly Chromium can't start under memory pressure) — but
    // the analysis is done, so return the ranked shortlist anyway. The client
    // still shows the table and offers the CSV; only the PDF link is missing.
    const message = err instanceof Error ? err.message : "Unknown error.";
    console.error("[buildDomainReport] pdf/store failed (shortlist preserved):", message);
    return { ok: true, data: { link: "", storage: "local", ...base, pdfError: message } };
  }
}

/**
 * The company-facing line for an internally assessed candidate — what they cleared, in
 * plain words (internal product names stay internal). "" = external.
 */
function assessedLine(internal: InternalStanding | null | undefined): string {
  if (!isAssessed(internal)) return "";
  if (internal.tier === 1) return "Cleared NxtWave's top-level technical interview";
  if (internal.tier === 2) return "Cleared NxtWave's first-round technical interview";
  return "Cleared NxtWave's coding assessment";
}
