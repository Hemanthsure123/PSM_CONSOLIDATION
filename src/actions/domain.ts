"use server";

import { htmlToPdf } from "@/lib/pdf";
import { buildDomainReportHtml, type DomainCardInput } from "@/lib/domain-report-template";
import { storePdf } from "@/lib/report-storage";
import { fetchResumeBytes } from "@/lib/resume";
import { extractProfileLinksFromResume, collectResumeUrls } from "@/lib/resume-links";
import { getLeetCodeSolved, getCodeforcesSolved, getGithubContributions, parseGithubUser } from "@/lib/coding-stats";
import {
  analyzeGithubProfile,
  buildJdTechSpec,
  checkGithubAccess,
  describeJdTechSpec,
  type GithubFailure,
} from "@/lib/github-analysis";
import { mapWithConcurrency } from "@/lib/rate-limit";
import { GITHUB_BATCH_SIZE, MIN_DOMAIN_SCORE, combinedScore } from "@/lib/domain-scoring";
import { slugify } from "@/lib/utils";
import { analyzeCandidateForDomain } from "@/actions/llm";
import type {
  ActionResult,
  DomainCandidate,
  DomainCandidateOutcome,
  DomainCandidateRow,
  DomainCommit,
  DomainGithubRepo,
  DomainGithubStatus,
  DomainReportResult,
} from "@/lib/types";

/** github.com first path segments that are GitHub's own pages, never a user. */
const GITHUB_NON_USER =
  /^(orgs|features|about|pricing|topics|sponsors|marketplace|settings|apps|login|join|signup|explore|trending|collections|events|readme|new|notifications|codespaces|enterprise|customer-stories|security|site|contact|resources|solutions|team|search|issues|pulls|gist)$/i;

/**
 * Split the resume's GitHub URLs into the candidate's profile URL + repo URLs. The
 * candidate is the user the resume links as a PROFILE; failing that, the owner of most
 * of the linked repos (so a teammate's or a course's repo listed first doesn't win);
 * failing that, the user behind a `<user>.github.io` portfolio.
 */
function splitGithub(urls: string[]): { profile: string; repos: string[] } {
  const repos: string[] = [];
  const profileUsers: string[] = [];
  const owners = new Map<string, { user: string; count: number }>();
  let pagesUser = "";
  for (const u of urls) {
    const pages = u.match(/^https?:\/\/([a-z0-9][a-z0-9-]*)\.github\.io(?:[/?#]|$)/i);
    if (pages) {
      pagesUser ||= pages[1];
      continue;
    }
    if (!/^https?:\/\/(www\.)?github\.com\//i.test(u)) continue;
    const path = u.replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
    const parts = path.split("/").filter(Boolean);
    if (!parts.length || GITHUB_NON_USER.test(parts[0])) continue;
    const user = parseGithubUser(u);
    if (!user) continue;
    if (parts.length >= 2) {
      repos.push(u);
      const key = user.toLowerCase();
      owners.set(key, { user, count: (owners.get(key)?.count ?? 0) + 1 });
    } else {
      profileUsers.push(user);
    }
  }
  const topOwner = [...owners.values()].sort((a, b) => b.count - a.count)[0]?.user ?? "";
  const user = profileUsers[0] || topOwner || pagesUser;
  return { profile: user ? `https://github.com/${user}` : "", repos };
}

/**
 * Assess ONE candidate's fit for `domain`. When `useDsa`, the resume's LeetCode /
 * Codeforces profiles are resolved (including links hidden behind an icon) and
 * their solved counts are folded in as a secondary strength signal. Called per
 * row by the client so progress is visible and one bad resume can't fail the run.
 */
export async function analyzeDomainCandidate(
  row: DomainCandidateRow,
  opts: {
    domain: string;
    /** Fetch + weigh LeetCode/Codeforces (also forced on by a min-LeetCode gate). */
    useDsa: boolean;
    /** Capture the resume's GitHub links for later live inspection. */
    useGithub: boolean;
    /** Strict must-haves the model checks (meetsMandatory). */
    mandatory: string;
    /** Emphasise that domain internship/work experience is required. */
    requireExperience: boolean;
    /** Also grade the resume's structure / alignment / visual presentation. */
    checkPresentation: boolean;
  },
): Promise<ActionResult<DomainCandidate>> {
  const { domain, useDsa, useGithub, mandatory, requireExperience, checkPresentation } = opts;
  if (!domain.trim()) return { ok: false, error: "Enter the domain to shortlist for first." };
  if (!/^https?:\/\//i.test((row.resumeUrl ?? "").trim())) {
    return { ok: false, error: "No resume link in the sheet." };
  }

  const resume = await fetchResumeBytes(row.resumeUrl);
  if (!resume) {
    return {
      ok: false,
      error:
        "Couldn't download the resume from the sheet link. Ensure the file is " +
        "shared with the service account (or publicly viewable).",
    };
  }

  // DSA signal — resolve profiles from the resume, then fetch counts. Stored on
  // the candidate (shown in the report/CSV and used by the min-LeetCode gate).
  let dsaContext = "";
  let leetcodeSolved = 0;
  let codeforcesSolved = 0;
  if (useDsa) {
    try {
      const profiles = await extractProfileLinksFromResume(resume, false);
      const [lc, cf] = await Promise.all([
        profiles.leetcode ? getLeetCodeSolved(profiles.leetcode.url) : Promise.resolve(null),
        profiles.codeforces ? getCodeforcesSolved(profiles.codeforces.url) : Promise.resolve(null),
      ]);
      if (typeof lc === "number" && lc > 0) leetcodeSolved = lc;
      if (typeof cf === "number" && cf > 0) codeforcesSolved = cf;
      const parts: string[] = [];
      if (leetcodeSolved) parts.push(`LeetCode ${leetcodeSolved} solved`);
      if (codeforcesSolved) parts.push(`Codeforces ${codeforcesSolved} solved`);
      dsaContext = parts.join(", ");
    } catch {
      dsaContext = "";
    }
  }

  // GitHub links (for later inspection of the shortlisted candidates only).
  let githubProfile = "";
  let githubRepos: string[] = [];
  if (useGithub) {
    try {
      const urls = await collectResumeUrls(resume);
      const gh = splitGithub(urls);
      githubProfile = gh.profile;
      githubRepos = gh.repos.slice(0, 20);
    } catch {
      /* best-effort */
    }
  }

  const res = await analyzeCandidateForDomain(
    resume,
    domain,
    dsaContext,
    mandatory,
    requireExperience,
    checkPresentation,
  );
  if (!res.ok) return res;

  return {
    ok: true,
    data: {
      ...row,
      domainScore: res.data.domainScore,
      coreSkills: res.data.coreSkills,
      evidence: res.data.evidence,
      meetsMandatory: res.data.meetsMandatory,
      hasDomainExperience: res.data.hasDomainExperience,
      experience: res.data.experience,
      presentationScore: checkPresentation ? res.data.presentationScore : 0,
      presentationNotes: checkPresentation ? res.data.presentationNotes : "",
      githubProfile,
      githubRepos,
      githubStatus: !useGithub ? "off" : githubProfile || githubRepos.length ? "not-inspected" : "no-link",
      githubNote: "",
      githubScore: 0,
      githubMatches: 0,
      githubTechs: [],
      githubTopRepos: [],
      githubAiLikelihood: "",
      githubAiSummary: "",
      leetcodeSolved,
      codeforcesSolved,
      githubCommits2y: 0,
      githubLastDomainCommit: null,
    },
  };
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

/** One candidate to inspect (the client sends a few per call). */
export interface GithubInspectInput {
  id: string;
  githubProfile: string;
  githubRepos: string[];
}

/** Everything the deep GitHub inspection learned about one candidate. */
export interface GithubInspectResult {
  id: string;
  status: DomainGithubStatus;
  note: string;
  score: number;
  matches: number;
  techs: string[];
  topRepos: DomainGithubRepo[];
  commits2y: number;
  lastDomainCommit: DomainCommit | null;
  aiLikelihood: "" | "none" | "low" | "medium" | "high";
  aiSummary: string;
}

const FAILURE_STATUS: Record<GithubFailure, DomainGithubStatus> = {
  "no-username": "no-link",
  "not-found": "not-found",
  "no-repos": "no-repos",
  "no-token": "failed",
  auth: "failed",
  "rate-limited": "failed",
  error: "failed",
};

/**
 * Deep GitHub inspection for one candidate: what their public repos' CODE actually
 * uses (manifests, imports, config — not repo names), scored 0-100 against the domain,
 * plus the domain-relevant repos, the newest own commit to one of them, the commit-
 * authorship signal, and 2-year commit activity. Never throws; every failure comes back
 * as a status + note rather than a silent 0.
 */
async function inspectOne(input: GithubInspectInput, domain: string, mandatory: string): Promise<GithubInspectResult> {
  const empty: GithubInspectResult = {
    id: input.id,
    status: "failed",
    note: "",
    score: 0,
    matches: 0,
    techs: [],
    topRepos: [],
    commits2y: 0,
    lastDomainCommit: null,
    aiLikelihood: "",
    aiSummary: "",
  };
  try {
    const spec = buildJdTechSpec(mandatory, domain, { modelledOnly: true });
    // The profile URL, or any repo URL — its owner is the candidate.
    const who = input.githubProfile || input.githubRepos[0] || "";
    const [deep, commits] = await Promise.all([
      analyzeGithubProfile(input.githubProfile, input.githubRepos, spec),
      getGithubContributions(who),
    ]);
    if (!deep.ok) {
      return { ...empty, status: FAILURE_STATUS[deep.reason], note: deep.message, commits2y: commits ?? 0 };
    }

    const a = deep.analysis;
    const notes: string[] = [];
    if (!a.assessable) {
      notes.push("The domain names no technology GitHub can verify — add tools / frameworks to “What defines it”.");
    }
    if (a.warning) notes.push(a.warning);
    if (commits === null) notes.push("2-year commit count unavailable (GitHub GraphQL error).");
    return {
      id: input.id,
      status: "checked",
      note: notes.join(" "),
      score: a.overallMatchPct,
      matches: a.matchingCount,
      techs: a.provenTechs,
      topRepos: a.topRepos
        .filter((r) => r.relevant)
        .slice(0, 3)
        .map((r) => ({ name: r.name, url: r.url, matchPct: r.matchPct, techs: [...r.mandatoryHit, ...r.goodToHaveHit] })),
      commits2y: commits ?? 0,
      lastDomainCommit: a.lastDomainCommit,
      aiLikelihood: a.authenticity.aiLikelihood,
      aiSummary: a.authenticity.summary,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "GitHub inspection failed.";
    console.warn("[domain] github inspection failed:", message);
    return { ...empty, note: message.slice(0, 160) };
  }
}

/**
 * Deep-inspect a small batch of domain-fit candidates concurrently. The client sends
 * batches (server actions run one at a time) and shows progress between them. Called
 * only for candidates that already cleared the resume domain-fit bar, so the API cost
 * is bounded.
 */
export async function inspectGithubBatch(
  inputs: GithubInspectInput[],
  domain: string,
  mandatory: string,
): Promise<ActionResult<GithubInspectResult[]>> {
  try {
    const results = await mapWithConcurrency(inputs, GITHUB_BATCH_SIZE, (input) => inspectOne(input, domain, mandatory));
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
    minLeetcode: number;
    minCommits: number;
    mandatoryActive: boolean;
    requireExperience: boolean;
    /** Resume presentation was graded (shows the score in the report/CSV). */
    checkPresentation: boolean;
    /** Presentation gate; 0 = grade and rank on it, but exclude nobody. */
    minPresentation: number;
  },
): Promise<ActionResult<DomainReportResult>> {
  const { domain, topN, limitToTopN, runName, resumesScanned, useDsa, useGithub, showDomainCommit, showStats, minLeetcode, minCommits, mandatoryActive, requireExperience, checkPresentation, minPresentation } = opts;

  // Domain-fit floor first, then the STRICT gates — a candidate must clear every
  // enabled one and is dropped at the first it fails. Track how many each gate
  // removes so the UI can explain the funnel, and keep the reason per candidate
  // for the all-candidates view.
  const excluded = { mandatory: 0, leetcode: 0, commits: 0, experience: 0, presentation: 0 };
  const presentationGate = checkPresentation && minPresentation > 0;
  const rejectionReason = (c: DomainCandidate): string => {
    if (c.domainScore < MIN_DOMAIN_SCORE) return `Domain fit ${c.domainScore} is below the ${MIN_DOMAIN_SCORE} bar`;
    if (mandatoryActive && !c.meetsMandatory) { excluded.mandatory++; return "Missing a mandatory skill"; }
    if (requireExperience && !c.hasDomainExperience) { excluded.experience++; return "No domain internship / experience"; }
    if (minLeetcode > 0 && c.leetcodeSolved < minLeetcode) {
      excluded.leetcode++;
      return `${c.leetcodeSolved} LeetCode solved, below the ${minLeetcode} minimum`;
    }
    if (minCommits > 0 && c.githubCommits2y < minCommits) {
      excluded.commits++;
      // Say WHY the count is low — unknown (failed check) is not the same as zero.
      if (c.githubStatus === "failed") return `GitHub check failed, commits unknown (${c.githubNote || "error"})`;
      if (c.githubStatus === "no-link") return `No GitHub link in the resume — commits gate needs one`;
      if (c.githubStatus === "not-found") return `GitHub user in the resume does not exist — commits gate`;
      return `${c.githubCommits2y} GitHub commits (2y), below the ${minCommits} minimum`;
    }
    if (presentationGate && c.presentationScore < minPresentation) {
      excluded.presentation++;
      return `Resume presentation ${c.presentationScore}, below the ${minPresentation} minimum`;
    }
    return "";
  };
  const judged = candidates.map((c) => ({ c, reason: rejectionReason(c) }));

  // Final rank folds the live GitHub signal — and, when graded, the resume's
  // presentation polish — into the resume domain fit.
  const byRank = (a: DomainCandidate, b: DomainCandidate) =>
    combinedScore(b, useGithub, checkPresentation) - combinedScore(a, useGithub, checkPresentation);
  const matches = judged.filter((j) => !j.reason).map((j) => j.c).sort(byRank);
  const considered = matches.length;
  const ranked = limitToTopN ? matches.slice(0, Math.max(1, topN)) : matches;

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
    githubMatches: useGithub ? c.githubMatches : 0,
    githubScore: useGithub ? c.githubScore : 0,
    githubTechs: useGithub ? c.githubTechs : [],
    githubTopRepos: useGithub ? c.githubTopRepos : [],
    // Presentation shown only when it was actually graded this run.
    presentationScore: checkPresentation ? c.presentationScore : 0,
    presentationNotes: checkPresentation ? c.presentationNotes : "",
    showPresentation: checkPresentation,
    // Coding stats shown only when the relevant fetch was enabled.
    leetcodeSolved: useDsa ? c.leetcodeSolved : 0,
    codeforcesSolved: useDsa ? c.codeforcesSolved : 0,
    githubCommits2y: useGithub ? c.githubCommits2y : 0,
    lastDomainCommit: showDomainCommit ? c.githubLastDomainCommit : null,
    showCoding: useDsa || useGithub || showDomainCommit,
  }));

  // Every evaluated candidate gets an outcome (the shortlist CSV and the
  // complete-screening CSV are both cut from this on the client):
  //   1. the shortlist, best first — rank = position;
  //   2. with a top-N limit, those who cleared every gate but ranked below it —
  //      their rank continues (N+1, N+2 …);
  //   3. everyone a gate or the domain-fit bar dropped — strongest first, with the reason.
  const outcomes: DomainCandidateOutcome[] = ranked.map((c, i) => ({ ...c, rank: i + 1, shortlisted: true, outcomeReason: "" }));
  if (limitToTopN) {
    matches.slice(ranked.length).forEach((c, i) => {
      const rank = ranked.length + i + 1;
      outcomes.push({
        ...c,
        rank,
        shortlisted: false,
        outcomeReason: `Cleared every gate — ranked #${rank} of ${considered}, outside the top ${ranked.length}`,
      });
    });
  }
  const dropped = judged.filter((j) => j.reason).sort((a, b) => byRank(a.c, b.c));
  for (const { c, reason } of dropped) outcomes.push({ ...c, rank: 0, shortlisted: false, outcomeReason: reason });
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
