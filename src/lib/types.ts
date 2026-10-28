import type { DsaSnapshot } from "@/lib/dsa-types";
import type { InternalStanding } from "@/lib/pool/types";
/** Shared domain types. */

export type SearchType = "uuid" | "phone" | "name" | "email";

/** Identifier types usable for batch BigQuery matching (name is too ambiguous). */
export type IdentifierType = Exclude<SearchType, "name">;

/**
 * One consolidated candidate row — the unit that flows into the company sheet.
 * Built primarily from the internal Google Sheet, optionally enriched from
 * BigQuery, and decorated with a generated AI screening report link.
 */
export interface ConsolidatedRow {
  /** Stable key (identifier value, or a synthesized fallback). */
  id: string;
  /** The company this sheet is for (entered at the start of the flow). */
  company: string;
  /** Which subsheet this row came from. */
  subsheet: string;
  /** Internal-sheet values, keyed by the original column header. */
  sheetValues: Record<string, string>;
  /** BigQuery enrichment values, keyed by logical column id. */
  bqValues: Record<string, string>;
  /** Identifier value used to match against BigQuery. */
  identifier: string;
  /** Resume URL taken from the internal sheet. */
  resumeUrl: string;
  /** Raw `source_track` value from BigQuery (drives the dashboard split). */
  sourceTrack: string;
  /** Whether this row found a BigQuery match. */
  matched: boolean;
  /**
   * TR/assessment links + interview panel names read straight from the uploaded
   * sheet. Populated from the raw sheet row regardless of which columns were
   * ticked for export, so the report can use them without exporting them.
   */
  reviewValues: ReviewValues;
}

/** Interview/assessment values sourced from the uploaded sheet. */
export interface ReviewValues {
  tr1Recording: string;
  tr2Recording: string;
  assessmentReport: string;
  /** Interviewer/panel names — surfaced on the report's recording cards. */
  tr1Panel: string;
  tr2Panel: string;
  /** Panel members' LinkedIn profiles — linked from the TR recording cards. */
  tr1PanelLinkedin: string;
  tr2PanelLinkedin: string;
}

/** Where the report's TR/assessment links are read from. */
export type ReviewLinkSource = "bigquery" | "sheet";

/** Screening criteria used to tailor the resume highlights to the role. */
export interface ReportCriteria {
  jobDescription: string;
  mandatorySkills: string;
  optionalSkills: string;
}

/** A labelled link extracted from the resume. */
export interface ResumeLink {
  label: string;
  url: string;
}

/** A GitHub project repository extracted from the resume. */
export interface GithubProject {
  name: string;
  url: string;
}

/** Result of the AI resume extraction. */
export interface ResumeAnalysis {
  /** Top highlight one-liners (the report is only generated when these exist). */
  points: string[];
  /** Technical skills present in the resume, ordered core/distinctive first. */
  skills: string[];
  /** HR-readable evaluation key points (Skill Set & Remarks feature). */
  remarks: string[];
  /** GitHub project repos as { name, url }. */
  github: GithubProject[];
  /** GitHub profile/portfolio URL (used when there are no project repos). */
  githubProfile: string;
  /** LeetCode profile URL. */
  leetcode: string;
  /** Codeforces profile URL. */
  codeforces: string;
  /** Personal portfolio / website URL. */
  portfolio: string;
  /** Any other relevant professional links. */
  otherLinks: ResumeLink[];
}

/** A platform's verified solved-problem count (real number from its API). */
export interface ProblemStat {
  platform: string;
  solved: number;
}

/** Count of repos per language. */
export interface LanguageCount {
  lang: string;
  count: number;
}

/** A candidate's most recent commit to a JD / domain-relevant repository. */
export interface DomainCommit {
  /** ISO timestamp of the commit (author date). */
  date: string;
  repo: string;
  repoUrl: string;
  /** The author is linked to the candidate's account; false = an unlinked git email in their own repo. */
  linked: boolean;
}

/** JD-matching GitHub project stats. */
export interface GithubProjectStats {
  matchingCount: number;
  languages: LanguageCount[];
  /** Notable JD-matching repos (name + url) for the projects list. */
  projects: GithubProject[];
  /** Newest commit by the candidate to a matching repo (null = not requested / none found). */
  lastDomainCommit: DomainCommit | null;
}

/** Optional "Technical Work" subsections the user can include in the report. */
export interface ReportSections {
  skills: boolean;
  github: boolean;
  leetcode: boolean;
  portfolio: boolean;
  otherLinks: boolean;
}

/** Result of the PDF generation + Drive upload pipeline. */
export interface ReportResult {
  candidateId: string;
  webViewLink: string;
  /** Where the PDF ended up — "drive" (shareable) or "local" (fallback). */
  storage: "drive" | "local";
}

/** Discriminated result wrapper used by server actions. */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * The minimum a row needs for projects consolidation. Deliberately NOT the
 * wizard's ConsolidatedRow — the feature runs standalone off any sheet that has
 * a resume link column.
 */
export interface ProjectSourceRow {
  id: string;
  candidate: string;
  resumeUrl: string;
  /** Company the candidate was placed in, when the sheet has it ("" = none). */
  placedCompany: string;
  /** CTC / pay scale of the placement, verbatim from the sheet ("" = none). */
  ctc: string;
}

/**
 * How the shortlist is prioritised. Each flag boosts projects that have the
 * attribute; `strict` turns the enabled LINK flags (live/github) into hard
 * requirements so only projects carrying that proof appear at all.
 */
export interface ProjectPriorities {
  live: boolean;
  github: boolean;
  placed: boolean;
  strict: boolean;
}

/** A resume project, scored against the brief and tagged with its candidate. */
export interface CandidateProject {
  title: string;
  /** The project's wording as written in the resume (not paraphrased). */
  description: string;
  tech: string[];
  github: string;
  live: string;
  relevance: number;
  quality: number;
  candidateId: string;
  candidate: string;
  resumeUrl: string;
  /** Company the candidate was placed in, when known ("" = none). */
  placedCompany: string;
  /** CTC / pay scale of the placement, verbatim from the sheet ("" = none). */
  ctc: string;
}

/** Outcome of a projects-consolidation run. */
export interface ProjectsReportResult {
  link: string;
  storage: "drive" | "local";
  shortlisted: number;
  considered: number;
  /** Projects excluded because strict mode required links they lacked. */
  droppedByStrict: number;
}

/**
 * Raw input row for domain shortlisting, mapped from the interview sheet
 * (UUID, name, resume, assessment, TR-1/TR-2 panel + recordings, placement).
 */
export interface DomainCandidateRow {
  id: string;
  name: string;
  resumeUrl: string;
  assessmentReport: string;
  tr1Panelist: string;
  tr1PanelLinkedin: string;
  tr1Recording: string;
  tr2Panelist: string;
  tr2PanelLinkedin: string;
  tr2Recording: string;
  placedCompany: string;
  /** Package / CTC, verbatim from the sheet ("" = none). */
  ctc: string;
  /** Phone number from the sheet — the first way to find the person in the eligible pool ("" / absent = none). */
  phone?: string;
  /** The sheet's user id / UUID — the second way ("" / absent = none). */
  userId?: string;
}

/** One of a candidate's repositories that deep GitHub inspection found relevant to the domain. */
export interface DomainGithubRepo {
  name: string;
  url: string;
  /** 0-100 match of the repo's real contents (code, manifests, config) to the domain. */
  matchPct: number;
  /** Domain technologies the repo's code / manifests / config prove. */
  techs: string[];
}

/** The quotable proof behind one technology the candidate's GitHub code proves. */
export interface DomainGithubEvidence {
  tech: string;
  /** The repo that proves it best. */
  repo: string;
  repoUrl: string;
  /** The finding, e.g. "import torch in src/train.py" or "fastapi declared in requirements.txt". */
  detail: string;
}

/**
 * A piece of domain evidence quoted from the resume's projects / experience / achievements /
 * certifications ("skill" = the quote the model gave for one of the core skills).
 */
export interface DomainProof {
  source: "project" | "experience" | "achievement" | "certification" | "skill";
  quote: string;
  /** The core skill the quote backs (source "skill"). */
  skill?: string;
}

/** One repository's code review against the domain (deep project review). */
export interface DomainProjectReview {
  repo: string;
  repoUrl: string;
  /** 0-100: relevance 45% + completeness 30% + depth 25%, capped when no feature is tied to a file. */
  score: number;
  /** 0-100 how squarely the project sits in the domain, in real code. */
  relevance: number;
  /** 0-100 working end to end vs stub / starter / tutorial. */
  completeness: number;
  /** 0-100 engineering depth: structure, data model, error handling, tests, real logic. */
  depth: number;
  /** One factual sentence on what the project is and how strong it is for the domain. */
  summary: string;
  /** Features the code implements, each with the files it lives in (paths checked against the repo). */
  features: { name: string; files: string[] }[];
  /** Requirements / core technologies the code proves, with the files that prove them. */
  covered: { requirement: string; files: string[] }[];
  /** Mandatory requirements the project doesn't show. */
  missing: string[];
  concerns: string[];
  /** Files the reviewer read, of all files in the repo. */
  filesRead: number;
  filesTotal: number;
  /** e.g. "gemini/gemini-3.6-flash". */
  model: string;
}

/** The deep project review of one candidate's top domain repositories. */
export interface DomainProjectReviewResult {
  id: string;
  /** reviewed = at least one repo reviewed; failed = none could be; no-repos = nothing to review. */
  status: "reviewed" | "failed" | "no-repos";
  note: string;
  /** The best reviewed project's score (0 = none). */
  score: number;
  reviews: DomainProjectReview[];
  reviewedAt: string;
  fromCache: boolean;
  /** Failed for a passing reason — worth another try. */
  retryable?: boolean;
  /** Stopped by GitHub's or the model's rate limit. */
  rateLimited?: boolean;
}

/** A mandatory technology the candidate's GitHub code does not prove. */
export interface DomainGithubGap {
  tech: string;
  /** none = no trace; readme-only = only named in a README / topics; weak = some evidence, below the bar. */
  reason: "none" | "readme-only" | "weak";
  /** The best (insufficient) finding with its repo ("" = none). */
  detail: string;
}

/**
 * Where a candidate's GitHub inspection ended up:
 *  - "off": the run did not inspect GitHub;
 *  - "no-link": no GitHub profile or repo link was found in the resume;
 *  - "not-inspected": below the domain-fit bar (or past the inspection cap), so not looked at;
 *  - "checked": inspected — the numbers are real;
 *  - "no-repos": the profile exists but has no public, non-fork repositories with code;
 *  - "not-found": the GitHub username in the resume does not exist;
 *  - "failed": token / rate-limit / network trouble — the numbers are UNKNOWN, not zero.
 */
export type DomainGithubStatus = "off" | "no-link" | "not-inspected" | "checked" | "no-repos" | "not-found" | "failed";

/** A candidate scored for a domain — everything the report + CSV need. */
export interface DomainCandidate extends DomainCandidateRow {
  /** 0-100 fit for the target domain (projects + experience + github [+ DSA]). */
  domainScore: number;
  /** Domain skills the candidate is genuinely strong in (evidence-backed). */
  coreSkills: string[];
  /** One factual line naming the strongest domain proof. */
  evidence: string;
  /** GitHub profile URL found in the resume ("" = none). */
  githubProfile: string;
  /** GitHub repo URLs found in the resume (fed to live inspection). */
  githubRepos: string[];
  /** Outcome of the GitHub inspection — tells "nothing found" apart from "not checked" / "failed". */
  githubStatus: DomainGithubStatus;
  /** Human-readable detail for the status ("" when checked cleanly). */
  githubNote: string;
  /** 0-100 deep GitHub fit for the domain, from what the repos' code actually uses (0 = none / not checked). */
  githubScore: number;
  /** PUBLIC repos whose code / manifests / config prove a domain technology (0 if none). */
  githubMatches: number;
  /** Domain technologies proven across the candidate's repos, strongest first. */
  githubTechs: string[];
  /** The best domain-relevant repos (at most 3). */
  githubTopRepos: DomainGithubRepo[];
  /** Commit-authorship signal: hard vendor AI-agent signatures in the inspected commits ("" = not checked). */
  githubAiLikelihood: "" | "none" | "low" | "medium" | "high";
  /** One factual line behind the authorship signal ("" = not checked). */
  githubAiSummary: string;
  /** One quotable proof per technology the code proves (absent in older runs / when not checked). */
  githubEvidence?: DomainGithubEvidence[];
  /** Mandatory technologies the inspected code doesn't prove, with why. */
  githubMandatoryGaps?: DomainGithubGap[];
  /** The domain's technologies the resume names that the inspected code doesn't prove. */
  githubClaimedNotFound?: string[];
  /** When the GitHub inspection behind these numbers ran (ISO; "" / absent = not run). */
  githubCheckedAt?: string;
  /** The inspection was reused from the 24 h cache rather than run for this sheet. */
  githubFromCache?: boolean;
  /** The domain's catalogued technologies the resume names (GitHub runs only) — compared with what the code proves. */
  resumeTechs?: string[];
  /** LeetCode problems solved (0 = none found / not fetched). */
  leetcodeSolved: number;
  /** Codeforces problems solved (0 = none found / not fetched). */
  codeforcesSolved: number;
  /** Full DSA read the DSA-consolidation way — LeetCode / Codeforces / CodeChef solved, contests, rating (absent when DSA was off). */
  dsa?: DsaSnapshot;
  /** Total GitHub commit contributions in the last ~2 years (0 = none/unknown). */
  githubCommits2y: number;
  /** Latest commit to a domain-relevant repo, from live GitHub inspection (null = none / off). */
  githubLastDomainCommit: DomainCommit | null;
  /** Whether ALL mandatory requirements are met (true when none were set). */
  meetsMandatory: boolean;
  /** Whether the resume shows domain-relevant internship/work experience. */
  hasDomainExperience: boolean;
  /** One-line summary of the most relevant internship/experience ("" = none). */
  experience: string;
  /** 0-100 resume structure / alignment / visual quality (0 = check was off). */
  presentationScore: number;
  /** One line naming what drives the presentation score ("" = check was off). */
  presentationNotes: string;
  /** The model that judged the resume, e.g. "openai/gpt-5.4-mini" (absent in older runs). */
  scoredBy?: string;
  /** Internal assessment standing from the eligible pool (null = external; absent = not looked up). */
  internal?: InternalStanding | null;
  /** Code review of the top domain repositories (absent = not reviewed). */
  projectReview?: DomainProjectReviewResult;
  /** The quoted evidence behind domainScore that held up against the resume (absent in older runs). */
  domainProofs?: DomainProof[];
  /** The model's domain score before the program's caps (absent = not capped / older runs). */
  rawDomainScore?: number;
  /** Why the domain score was lowered ("" / absent = not lowered). */
  domainCapped?: string;
  /** The GitHub account's display name ("" = none shown). */
  githubAccountName?: string;
  /** Does the GitHub account look like the candidate's? A clear mismatch isn't counted in the rank. */
  githubIdentity?: "match" | "mismatch" | "unknown";
}

/** A scored candidate plus where they landed in the shortlist. */
export interface DomainCandidateOutcome extends DomainCandidate {
  /**
   * 1-based position among the candidates who cleared every gate (the shortlist
   * first, then — with a top-N limit — those ranked below it); 0 = dropped by a gate.
   */
  rank: number;
  shortlisted: boolean;
  /** Why the candidate was not shortlisted ("" when shortlisted). */
  outcomeReason: string;
  /**
   * Shortlisting priority: 1 = internally assessed + good resume, 2 = assessed + average
   * resume, 3 = external with a good resume; 0 = dropped (absent in older runs).
   */
  priority?: 0 | 1 | 2 | 3;
  /** The number the shortlist is ordered by inside a priority group (domain fit + GitHub + DSA + presentation points). */
  rankScore?: number;
  /** Why the candidate is where they are, one line each (the CSV's Signals column). */
  signals?: string[];
}

/** Outcome of a domain-shortlisting run. */
export interface DomainReportResult {
  /** Shareable PDF link, or "" when PDF generation failed (CSV still works). */
  link: string;
  storage: "drive" | "local";
  shortlisted: number;
  considered: number;
  /**
   * For the CSV and preview table. With the top-N limit on: the top-N shortlisted.
   * With it off: EVERY scanned candidate — shortlisted first (ranked), then the
   * rest with the reason they were not shortlisted.
   */
  candidates: DomainCandidateOutcome[];
  /** Whether the shortlist was cut to the top N. */
  limitedToTopN: boolean;
  /** How many domain-fit candidates each strict gate removed (funnel transparency). */
  /** Removed per gate. `leetcode` is the old LeetCode-only gate (0 in new runs); `dsa` = the DSA gates. */
  excluded: { mandatory: number; leetcode: number; dsa?: number; commits: number; experience: number; presentation: number };
  /** Set when the PDF couldn't be produced (e.g. Chromium OOM); CSV is unaffected. */
  pdfError?: string;
  /** True when the run was asked not to build a PDF report (link is ""). */
  reportSkipped?: boolean;
}

/** Per-source-bucket count, used by dashboards. */
export interface BucketCount {
  bucket: "edge" | "academy" | "external";
  count: number;
}

/**
 * One candidate's persisted detail, captured at save time so the company
 * drill-down can show a per-candidate table (and export it) with the
 * Edge/Academy/External split. `fields` mirrors the exported company-sheet
 * columns (label → value); `bucket` is the classified `source_track`.
 */
export interface CandidateDetail {
  id: string;
  subsheet: string;
  bucket: "edge" | "academy" | "external";
  /** Raw `source_track` value that drove the classification. */
  sourceTrack: string;
  matched: boolean;
  /** Company-sheet values, keyed by the display column label. */
  fields: Record<string, string>;
}

/** Analytics snapshot for one subsheet (treated as a company). */
export interface SubsheetSummary {
  name: string;
  total: number;
  matched: number;
  buckets: BucketCount[];
}

/** Saved snapshot of a completed consolidation — shown on the home dashboard. */
export interface CompanySummary {
  id: string;
  companyName: string;
  sheetName: string;
  createdAt: string;
  total: number;
  matched: number;
  reportsGenerated: number;
  columnCount: number;
  buckets: BucketCount[];
  subsheets: SubsheetSummary[];
  /**
   * Ordered display columns for the candidate drill-down table. Optional so
   * snapshots saved before this feature still load.
   */
  candidateColumns?: string[];
  /** Per-candidate detail powering the drill-down table + export. Optional. */
  candidates?: CandidateDetail[];
}
