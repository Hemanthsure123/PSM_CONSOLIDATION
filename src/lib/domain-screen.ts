import "server-only";
import { fetchResume, type ResumeBytes } from "@/lib/resume";
import { contentFromBytes, looksLikeResume, transcribeDocument, visionTiers, DOC_LABEL } from "@/lib/resume-content";
import { env } from "@/lib/env";
import { extractProfileLinksFromResume, collectResumeUrls } from "@/lib/resume-links";
import { getGithubContributions, parseGithubUser } from "@/lib/coding-stats";
import { DSA_KEYS, resolveDsaPlatforms } from "@/lib/dsa-resolve";
import { dsaScore } from "@/lib/dsa-scoring";
import { EMPTY_PLATFORM, type DsaLinkSource, type DsaPlatform, type DsaSnapshot } from "@/lib/dsa-types";
import {
  analyzeGithubProfile,
  buildJdTechSpec,
  githubBudget,
  githubGetJson,
  githubUsernameFor,
  mandatoryTechsAbsent,
  techsNamedIn,
  GITHUB_ANALYSIS_VERSION,
  type GithubFailure,
  type JdTechSpec,
} from "@/lib/github-analysis";
import { coalesce, inspectionCacheKey, readInspectionCache, writeInspectionCache } from "@/lib/github-inspect-cache";
import { evidenceText } from "@/lib/resume-sections";
import { githubIdentity, groundDomainFit } from "@/lib/domain-evidence";
import { analyzeCandidateForDomain } from "@/actions/llm";
import type {
  DomainCandidate,
  DomainCandidateRow,
  DomainCommit,
  DomainGithubEvidence,
  DomainGithubGap,
  DomainGithubRepo,
  DomainGithubStatus,
} from "@/lib/types";

/**
 * Domain Shortlisting — screening ONE candidate and inspecting ONE candidate's
 * GitHub, as self-contained jobs the browser can run many of in parallel (see
 * /api/domain/*). The judgement runs on Gemini, then OpenAI when Gemini is rate-limited,
 * then Mistral when OpenAI is too (see analyzeCandidateForDomain), and every result is
 * checked before it is trusted:
 *
 *  - a download that failed for a passing reason (network, rate limit, 5xx) and a
 *    model run that failed (quota, overload, an unusable answer) come back as
 *    RETRYABLE, so the browser tries again instead of dropping the candidate;
 *  - a file with no usable text (photo, certificate, scanned page) is identified
 *    first and only a real resume is screened — from its transcription, so the model
 *    can't invent a resume from a photo; a .docx is read as text;
 *  - domain evidence is only projects, experience, certifications and achievements: the
 *    Skills section and the profile summary are taken out of what the model reads (when
 *    the layout allows) and out of every check below;
 *  - core skills the model names must appear in that evidence text, and a mandatory
 *    technology it never names can't be "met";
 *  - a fit that rests only on the Skills / Summary sections is capped below every bar.
 */

/**
 * Tiers that can read an image / scanned page (transcription only): Gemini, then OpenAI
 * when Gemini is rate-limited — so photos and scans are still told apart from resumes.
 */
const ocrChain = () =>
  visionTiers(
    "gemini:gemini-3.8-flash,gemini:gemini-3.6-flash,gemini:gemini-3.5-flash,gemini:gemini-3-flash-preview,gemini:gemini-3.1-flash-lite,gemini:gemini-2.5-flash," +
      `openai:${env.openai.model}`,
  );
const OCR_TIMEOUT_MS = 60_000;

export interface DomainScreenOptions {
  domain: string;
  useDsa: boolean;
  useGithub: boolean;
  mandatory: string;
  requireExperience: boolean;
  checkPresentation: boolean;
}

export type DomainScreenResult =
  | { ok: true; candidate: DomainCandidate; source: string }
  /** invalid = the file is not a resume (never retried); error = could not be screened. */
  | { ok: false; kind: "invalid" | "error"; error: string; retryable: boolean };

/** github.com first path segments that are GitHub's own pages, never a user. */
const GITHUB_NON_USER =
  /^(orgs|features|about|pricing|topics|sponsors|marketplace|settings|apps|login|join|signup|explore|trending|collections|events|readme|new|notifications|codespaces|enterprise|customer-stories|security|site|contact|resources|solutions|team|search|issues|pulls|gist)$/i;

/**
 * Split the resume's GitHub URLs into the candidate's profile URL + repo URLs. The
 * candidate is the user the resume links as a PROFILE; failing that, the owner of most
 * of the linked repos (so a teammate's or a course's repo listed first doesn't win);
 * failing that, the user behind a `<user>.github.io` portfolio.
 */
export function splitGithub(urls: string[]): { profile: string; repos: string[] } {
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

const asText = (text: string): ResumeBytes => ({ data: Buffer.from(text, "utf8"), mimeType: "text/plain" });

/** The whole DSA read (link search + all three platforms) is cut off here — CodeChef paces requests hard. */
const DSA_READ_MS = 120_000;

/**
 * One candidate's DSA, read exactly as DSA Consolidation reads it: profile links from
 * the resume (link annotations, text, short links; a model only when the resume names a
 * platform it gives no link for), then solved / contests / rating from every platform.
 * Never throws — a platform that can't be read is "unknown" and the snapshot is marked
 * partial, so a rate limit is never mistaken for a weak candidate.
 */
async function readDsa(forLinks: ResumeBytes): Promise<DsaSnapshot> {
  const links = Object.fromEntries(DSA_KEYS.map((k) => [k, { url: "", source: "none" as DsaLinkSource }])) as Record<
    DsaPlatform,
    { url: string; source: DsaLinkSource }
  >;
  const empty = (note: string): DsaSnapshot => ({
    leetcode: { ...EMPTY_PLATFORM, note },
    codeforces: { ...EMPTY_PLATFORM, note },
    codechef: { ...EMPTY_PLATFORM, note },
    totalSolved: null,
    totalContests: null,
    score: 0,
    partial: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async (): Promise<DsaSnapshot> => {
    try {
      const found = await extractProfileLinksFromResume(forLinks, "if-mentioned");
      for (const k of DSA_KEYS) {
        const f = found[k];
        if (f) links[k] = { url: f.url, source: f.source };
      }
    } catch {
      return empty("Profile links could not be read from the resume");
    }
    const r = await resolveDsaPlatforms(links);
    return {
      leetcode: r.leetcode,
      codeforces: r.codeforces,
      codechef: r.codechef,
      totalSolved: r.totalSolved,
      totalContests: r.totalContests,
      score: dsaScore(r),
      // Partial = a linked profile that couldn't be read (rate limit, network). A profile
      // that doesn't exist is a definite answer, not a partial read.
      partial: DSA_KEYS.some((k) => Boolean(r[k].url) && r[k].found !== false && (r[k].found !== true || r[k].solved === null)),
    };
  })();
  const timedOut = new Promise<DsaSnapshot>((resolve) => {
    timer = setTimeout(() => {
      const s = empty(`Timed out after ${DSA_READ_MS / 1000}s — re-run`);
      for (const k of DSA_KEYS) if (links[k].url) s[k] = { ...s[k], url: links[k].url, source: links[k].source };
      resolve(s);
    }, DSA_READ_MS);
  });
  return Promise.race([work.finally(() => clearTimeout(timer)), timedOut]);
}

/**
 * Screen ONE candidate for the domain. Never throws: every outcome is a scored
 * candidate, "not a resume" (with what the file is), or an error marked retryable or
 * not.
 */
export async function screenDomainCandidate(row: DomainCandidateRow, opts: DomainScreenOptions): Promise<DomainScreenResult> {
  const { domain, useDsa, useGithub, mandatory, requireExperience, checkPresentation } = opts;
  const fail = (error: string, retryable = false): DomainScreenResult => ({ ok: false, kind: "error", error, retryable });
  const invalid = (error: string): DomainScreenResult => ({ ok: false, kind: "invalid", error, retryable: false });
  if (!domain.trim()) return fail("Enter the domain to shortlist for first.");
  if (!/^https?:\/\//i.test((row.resumeUrl ?? "").trim())) return fail("No resume link in the sheet.");

  try {
    // 1. Download — a passing failure is retried; a missing / unshared file is final.
    const fetched = await fetchResume(row.resumeUrl);
    if (!fetched.ok) {
      return fetched.transient
        ? fail(`Resume download failed temporarily (${fetched.error.slice(0, 80)}) — retrying.`, true)
        : fail("Couldn't download the resume from the sheet link. Ensure the file is shared with the service account (or publicly viewable).");
    }
    const bytes = fetched.bytes;

    // 2. What the file really is, and what the model may read.
    const content = await contentFromBytes(bytes);
    if (typeof content === "string") return fail(content);
    let resumeText = content.text;
    // Gemini reads a PDF with a real text layer natively (layout-aware — the presentation
    // grade needs it); everything else is screened from TEXT.
    let forModel: ResumeBytes = content.source === "pdf" && looksLikeResume(resumeText) ? bytes : asText(resumeText);
    if (!looksLikeResume(resumeText)) {
      if (!content.inline) return invalid("The file has no readable resume text (no skills / projects / experience / education).");
      const doc = await transcribeDocument(content.inline, { chain: ocrChain(), label: `domain-ocr:${row.id}`, timeoutMs: OCR_TIMEOUT_MS });
      if (!doc.ok) return fail(`Could not read the scanned resume: ${doc.error.slice(0, 160)}`, true);
      if (doc.type !== "resume") {
        return invalid(`The resume link is ${DOC_LABEL[doc.type]}${doc.description ? ` — ${doc.description}` : ""}.`);
      }
      if (!looksLikeResume(doc.text)) return invalid(`The uploaded resume can't be read (${doc.description || "too little text"}).`);
      resumeText = doc.text;
      forModel = asText(resumeText);
    }
    // Links: a PDF's hidden link annotations come from the file itself; otherwise the text.
    const forLinks: ResumeBytes = content.source === "pdf" ? bytes : asText(resumeText);

    // Evidence only: without the Skills / Summary sections. When the sections were found
    // cleanly the model reads that text (the presentation grade needs the page itself, so a
    // run that grades presentation keeps the PDF and relies on the prompt's rule).
    const evidence = evidenceText(resumeText);
    if (evidence.trusted && evidence.removed.length && !checkPresentation) forModel = asText(evidence.text);

    // 3. GitHub links (independent of the model — read alongside it).
    const githubLinks = useGithub
      ? collectResumeUrls(forLinks)
          .then((urls) => {
            const gh = splitGithub(urls);
            return { profile: gh.profile, repos: gh.repos.slice(0, 20) };
          })
          .catch(() => ({ profile: "", repos: [] as string[] }))
      : Promise.resolve({ profile: "", repos: [] as string[] });

    // 4. DSA — the DSA consolidation's own lookup (LeetCode / Codeforces / CodeChef: problems
    //    solved, rated contests, rating), read alongside the model and never fed into it: the
    //    shortlist screens on these numbers directly (dsa-scoring.ts), so the domain score
    //    stays about the domain.
    const dsaRead = useDsa ? readDsa(forLinks) : Promise.resolve(undefined);

    // 5. The judgement.
    const [res, gh, dsa] = await Promise.all([
      analyzeCandidateForDomain(forModel, domain, "", mandatory, requireExperience, checkPresentation),
      githubLinks,
      dsaRead,
    ]);
    if (!res.ok) return fail(res.error, true);
    const leetcodeSolved = dsa?.leetcode.solved ?? 0;
    const codeforcesSolved = dsa?.codeforces.solved ?? 0;

    // 6. Ground the model's answer in the resume's EVIDENCE text (projects, experience,
    //    certifications, achievements — never the Skills list or the summary): core skills
    //    need their quote there, the domain score needs quoted evidence (domain-evidence.ts),
    //    and every plainly required technology the model says is met must be named there.
    const proof = evidence.text;
    const grounded = proof
      ? groundDomainFit(res.data, proof, { sectionsRemoved: evidence.removed.length > 0 })
      : { domainScore: res.data.domainScore, rawScore: res.data.domainScore, coreSkills: res.data.coreSkills, proofs: res.data.proofs, capped: "" };
    const absent = res.data.meetsMandatory && mandatory.trim() ? mandatoryTechsAbsent(mandatory, proof) : [];
    // The domain's technologies the resume's evidence names — compared later with what the GitHub code proves.
    const resumeTechs = useGithub && proof ? techsNamedIn(specLabels(buildJdTechSpec(mandatory, domain, { modelledOnly: true })), proof) : [];
    if (absent.length) console.warn(`[domain] ${row.id}: ${res.data.scoredBy} said every mandatory item is met, but the evidence never names ${absent.join(", ")}`);
    if (grounded.capped) console.warn(`[domain] ${row.id}: fit ${grounded.rawScore} → ${grounded.domainScore} (${grounded.capped})`);
    const domainScore = grounded.domainScore;
    const coreSkills = grounded.coreSkills;

    return {
      ok: true,
      source: content.source === "pdf" && forModel === bytes ? "pdf" : `${content.source} (as text)`,
      candidate: {
        ...row,
        domainScore,
        coreSkills,
        evidence: grounded.capped && grounded.domainScore <= 35 && !grounded.proofs.length ? "No domain work quoted from the projects, experience or achievements" : res.data.evidence,
        domainProofs: grounded.proofs,
        ...(grounded.capped ? { rawDomainScore: grounded.rawScore, domainCapped: grounded.capped } : {}),
        meetsMandatory: res.data.meetsMandatory && absent.length === 0,
        hasDomainExperience: res.data.hasDomainExperience,
        experience: res.data.experience,
        presentationScore: checkPresentation ? res.data.presentationScore : 0,
        presentationNotes: checkPresentation ? res.data.presentationNotes : "",
        scoredBy: res.data.scoredBy,
        githubProfile: gh.profile,
        githubRepos: gh.repos,
        githubStatus: !useGithub ? "off" : gh.profile || gh.repos.length ? "not-inspected" : "no-link",
        githubNote: "",
        githubScore: 0,
        githubMatches: 0,
        githubTechs: [],
        githubTopRepos: [],
        githubAiLikelihood: "",
        githubAiSummary: "",
        leetcodeSolved,
        codeforcesSolved,
        ...(dsa ? { dsa } : {}),
        githubCommits2y: 0,
        githubLastDomainCommit: null,
        ...(useGithub ? { resumeTechs } : {}),
      },
    };
  } catch (err) {
    console.error(`[domain] ${row.id} failed:`, err);
    return fail(err instanceof Error ? err.message.slice(0, 300) : "Screening failed.", true);
  }
}

// ── GitHub inspection ────────────────────────────────────────────────────────

/** One candidate to inspect. */
export interface GithubInspectInput {
  id: string;
  githubProfile: string;
  githubRepos: string[];
  /** The domain's technologies the resume names (from screening) — compared with what the code proves. */
  claimedTechs?: string[];
  /** The candidate's name — compared with the GitHub account's name. */
  name?: string;
}

/** Every technology label a spec looks for, mandatory first. */
const specLabels = (spec: JdTechSpec): string[] => [...spec.mandatory, ...spec.goodToHave];

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
  /** One quotable proof per proven technology. */
  evidence: DomainGithubEvidence[];
  /** Mandatory technologies the code doesn't prove, with why. */
  mandatoryGaps: DomainGithubGap[];
  /** Technologies the resume claims for this domain that the code doesn't prove. */
  claimedNotFound: string[];
  /** When the inspection ran (ISO) — earlier than this request when reused from the cache. */
  checkedAt: string;
  /** Reused from the 24 h cache. */
  fromCache: boolean;
  /** The GitHub account's display name ("" = none shown). */
  accountName?: string;
  /** Does the account look like the candidate's (name vs the account's name / login)? */
  identity?: "match" | "mismatch" | "unknown";
  /** Failed for a passing reason (network) — worth one more try. */
  retryable?: boolean;
  /** Stopped by GitHub's rate limit — worth retrying after the hourly reset. */
  rateLimited?: boolean;
}

/** The part of an inspection that depends only on the GitHub account + domain (what the cache stores). */
type InspectionOutcome = Omit<GithubInspectResult, "id" | "claimedNotFound" | "fromCache" | "identity">;

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
 * plus the domain-relevant repos, the proof behind each proven technology, the mandatory
 * technologies the code doesn't prove, what the resume claims but the code doesn't show,
 * the newest own commit to a domain repo, the commit-authorship signal, and 2-year commit
 * activity. Never throws; every failure comes back as a status + note rather than a silent 0.
 *
 * A complete answer is reused for 24 h (github-inspect-cache.ts) — keyed by the GitHub user,
 * the resume's repo links, the technologies looked for and the analyzer version — unless
 * `refresh` asks for a fresh look. Identical requests in flight share one inspection.
 */
export async function inspectDomainGithub(
  input: GithubInspectInput,
  domain: string,
  mandatory: string,
  opts: { refresh?: boolean } = {},
): Promise<GithubInspectResult> {
  const spec = buildJdTechSpec(mandatory, domain, { modelledOnly: true });
  const claimed = new Set((input.claimedTechs ?? []).filter((t) => specLabels(spec).includes(t)));
  const user = githubUsernameFor(input.githubProfile, input.githubRepos);
  const finish = (o: InspectionOutcome, fromCache: boolean): GithubInspectResult => ({
    ...o,
    id: input.id,
    fromCache,
    claimedNotFound: o.status === "checked" ? [...claimed].filter((t) => !o.techs.includes(t)) : [],
    identity: o.status === "checked" ? githubIdentity(input.name ?? "", o.accountName ?? "", user ?? "") : undefined,
  });

  const key = user
    ? inspectionCacheKey({
        v: GITHUB_ANALYSIS_VERSION,
        // 2: the outcome carries the account's display name (identity check).
        outcome: 2,
        user: user.toLowerCase(),
        repos: [...new Set(input.githubRepos.map((r) => r.trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "")))].sort(),
        mandatory: [...spec.mandatory].sort(),
        groups: (spec.mandatoryGroups ?? []).map((g) => [...g].sort().join("|")).sort(),
        goodToHave: [...spec.goodToHave].sort(),
      })
    : null;
  if (!key) return finish((await inspectFresh(input, spec)).outcome, false);

  if (!opts.refresh) {
    const hit = await readInspectionCache<InspectionOutcome>(key);
    if (hit) return finish(hit.value, true);
  }
  // One inspection per key at a time; the one that runs stores a complete answer.
  const outcome = await coalesce(key, async () => {
    const fresh = await inspectFresh(input, spec);
    if (fresh.cacheable) await writeInspectionCache(key, fresh.outcome);
    return fresh.outcome;
  });
  return finish(outcome, false);
}

/** Inspect now. `cacheable` = a complete, definitive answer (never a failure or a partial read). */
async function inspectFresh(input: GithubInspectInput, spec: JdTechSpec): Promise<{ outcome: InspectionOutcome; cacheable: boolean }> {
  const checkedAt = new Date().toISOString();
  const empty: InspectionOutcome = {
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
    evidence: [],
    mandatoryGaps: [],
    checkedAt,
  };
  try {
    // The profile URL, or any repo URL — its owner is the candidate.
    const who = input.githubProfile || input.githubRepos[0] || "";
    const login = githubUsernameFor(input.githubProfile, input.githubRepos);
    const [deep, commits, account] = await Promise.all([
      analyzeGithubProfile(input.githubProfile, input.githubRepos, spec),
      getGithubContributions(who),
      // The account's display name — to check the account is the candidate's (one REST call).
      login ? githubGetJson<{ name?: string | null }>(`/users/${encodeURIComponent(login)}`, githubBudget(2)).catch(() => null) : Promise.resolve(null),
    ]);
    const accountName = (account?.ok && account.data?.name ? String(account.data.name) : "").trim().slice(0, 120);
    if (!deep.ok) {
      const status = FAILURE_STATUS[deep.reason];
      return {
        outcome: {
          ...empty,
          status,
          note: deep.message,
          commits2y: commits ?? 0,
          retryable: deep.reason === "error",
          rateLimited: deep.reason === "rate-limited",
        },
        // A user that doesn't exist / has no public code is a definite answer; anything else may pass.
        cacheable: (status === "not-found" || status === "no-repos") && commits !== null,
      };
    }

    const a = deep.analysis;
    const notes: string[] = [];
    if (!a.assessable) {
      notes.push("The domain names no technology GitHub can verify — add tools / frameworks to “What defines it”.");
    }
    if (a.warning) notes.push(a.warning);
    if (commits === null) notes.push("2-year commit count unavailable (GitHub GraphQL error).");
    return {
      outcome: {
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
        evidence: a.techEvidence.map((e) => ({ tech: e.tech, repo: e.repo, repoUrl: e.repoUrl, detail: e.detail })),
        mandatoryGaps: a.mandatoryGaps.map((g) => ({ tech: g.tech, reason: g.reason, detail: g.detail })),
        accountName,
        checkedAt,
      },
      // A run cut short (rate limit / call budget) or a missing commit count is not reused.
      cacheable: !a.warning && commits !== null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "GitHub inspection failed.";
    console.warn("[domain] github inspection failed:", message);
    return {
      outcome: { ...empty, note: message.slice(0, 160), retryable: true, rateLimited: /rate limit|secondary rate|abuse detection/i.test(message) },
      cacheable: false,
    };
  }
}
