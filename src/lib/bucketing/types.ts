import {
  BUCKETING_PROMPT_VERSION,
  STAGE_TIER,
  stageLabel,
  type Bucket,
  type DomainKey,
  type ReasonCode,
  type Stage,
  type Track,
} from "@/lib/bucketing/config";

/**
 * Candidate Bucketing — data shapes shared by the graph (server) and the UI
 * (browser). Client-safe: types plus one pure helper.
 */

// ── Input ────────────────────────────────────────────────────────────────────

export interface BucketingCandidateInput {
  /** Normalised mobile number — the candidate's id. */
  id: string;
  mobile: string;
  name: string;
  resumeUrl: string;
  /** Pasted resume text (used only when there is no readable link). */
  resumeText?: string;
  /** Highest cleared stage. */
  stage: Stage;
  /** TR-2 track (null for TR-1 / Assessment, or a TR-2 row without one). */
  track: Track | null;
  /** Sheet columns override links found in the resume. */
  githubUrl?: string;
  leetcodeUrl?: string;
  codechefUrl?: string;
  codeforcesUrl?: string;
  batch: number;
}

// ── Ingest ───────────────────────────────────────────────────────────────────

export type ResumeStatus = "ok" | "not_resume" | "unreadable" | "error";

export interface ResumeInfo {
  status: ResumeStatus;
  /** pdf / docx / text / image / pasted ("" when it never loaded). */
  source: string;
  /** Read from an image / scanned PDF by transcription (trust is capped). */
  transcribed: boolean;
  chars: number;
  /** Why it failed, or what the file was. */
  note: string;
  model: string;
}

/**
 * How we know a link belongs to a project: written inside its block, the repo /
 * site name matches its title, the repo's code matches its stated tech after the
 * model put the link on another project ("code-match"), or only the model says so.
 */
export type LinkPlacement = "in-section" | "name-match" | "code-match" | "model" | "none";

export interface ExtractedProject {
  /** P1, P2 … in resume order. */
  id: string;
  title: string;
  /** The project's own wording (verified against the resume text; "" when it failed). */
  description: string;
  /** 2-25 words copied from the project's section, verified. */
  quote: string;
  /** Heading the quote sits under: projects / experience / unknown … */
  section: string;
  /** Technologies named in THIS project's own text — never the skills list. */
  claimedTech: string[];
  claimedTechKeys: string[];
  /** GitHub URLs taken only from the document's own links. */
  github: string[];
  live: string[];
  linkPlacement: LinkPlacement;
  period: string;
}

export type ExperienceKind = "internship" | "job" | "freelance" | "research" | "other";

export interface ExtractedExperience {
  /** E1, E2 … */
  id: string;
  company: string;
  role: string;
  kind: ExperienceKind;
  /** As written. */
  duration: string;
  /** Only when the resume writes dates / a duration that give it. */
  months: number | null;
  tech: string[];
  techKeys: string[];
  description: string;
  quote: string;
  section: string;
}

export interface OssClaim {
  /** O1, O2 … */
  id: string;
  title: string;
  description: string;
  quote: string;
  /** PR / repo URLs from the document's own links. */
  urls: string[];
}

export type ProfileSource = "row" | "annotation" | "text" | "llm";

export interface ProfileLink {
  url: string;
  handle: string;
  source: ProfileSource;
}

export interface Extraction {
  candidateName: string;
  projects: ExtractedProject[];
  experience: ExtractedExperience[];
  openSource: OssClaim[];
  profiles: {
    github: ProfileLink | null;
    leetcode: ProfileLink | null;
    codechef: ProfileLink | null;
    codeforces: ProfileLink | null;
  };
  /** Every URL in the document (annotations + text). */
  urls: string[];
  /** Items or fields dropped by the grounding checks, with the reason. */
  dropped: string[];
  model: string;
}

// ── Reviews ──────────────────────────────────────────────────────────────────

export type Verdict = "pass" | "revise" | "fail";

export interface Review {
  verdict: Verdict;
  /** 0-100. */
  trust: number;
  /** 0-1 share of deterministic checks that held. */
  coverage: number;
  /** 0-1 producer vs judge agreement (null when no judge ran). */
  agreement: number | null;
  issues: string[];
  model: string;
}

// ── Domains (Agents 1-2) ─────────────────────────────────────────────────────

export interface DomainEvidence {
  /** P1 / E2 / O1. */
  itemId: string;
  /** The item's verified resume quote. */
  quote: string;
  why: string;
}

export interface DomainScore {
  domain: DomainKey;
  score: number;
  evidence: DomainEvidence[];
  rationale: string;
}

export interface DomainAnalysis {
  domains: DomainScore[];
  primary: DomainKey | null;
  model: string;
  attempt: number;
  error: string;
}

export interface DomainReview extends Review {
  /** Final scores after caps and analyst/judge blending. */
  adjusted: DomainScore[];
  primary: DomainKey | null;
}

// ── Project evidence ─────────────────────────────────────────────────────────

export interface CommitOffense {
  sha: string;
  author: string;
  date: string;
  /** What made it foreign / AI: "author rahul-dev", "Co-authored-by: Claude <noreply@anthropic.com>" … */
  signature: string;
}

export interface CommitIntegrity {
  /** Non-merge commits audited. */
  audited: number;
  candidateCommits: number;
  /** Merges by the candidate and ordinary automation (dependabot …) — listed, not held against them. */
  exempt: number;
  foreignCount: number;
  aiCount: number;
  /** First few offending commits, for the audit trail. */
  foreign: CommitOffense[];
  ai: CommitOffense[];
  truncated: boolean;
  /** Behavioural flags (bursts, single dump) — lower trust, never invalidate. */
  flags: string[];
  verdict: "clean" | "foreign" | "ai" | "empty";
}

export type RepoStatus = "verified" | "invalid" | "unavailable";

export interface RepoEvidence {
  url: string;
  owner: string;
  repo: string;
  status: RepoStatus;
  invalidReason: ReasonCode | null;
  message: string;
  /** The resume linked a profile, and the repo was matched by name (lower confidence). */
  resolvedFromProfile: boolean;
  /** Upstream "owner/repo" when the repo is a fork. */
  fork: string;
  /** Technologies the code proves (confidence ≥ TECH_CONF, hard evidence). */
  techs: { key: string; label: string; conf: number; detail: string }[];
  traceFiles: string[];
  integrity: CommitIntegrity | null;
  homepage: string;
  srcFiles: number;
}

export interface DemoCheck {
  url: string;
  status: "reachable" | "unreachable" | "soft-404" | "none";
  httpStatus: number;
  /** <title> of the page, when read. */
  title: string;
  /** The page / URL names the project (needed for a demo-only project to count). */
  matchesProject: boolean;
  note: string;
}

/** A valid GitHub + live demo · B valid GitHub · C demo only · D not evidence. */
export type Tier = "A" | "B" | "C" | "D";

export type ProjectStatus = "verified" | "invalid" | "unavailable" | "demo_only" | "no_link" | "not_audited";

export interface ProjectEvidence {
  projectId: string;
  title: string;
  status: ProjectStatus;
  /** Tier A, B or C. */
  valid: boolean;
  tier: Tier;
  invalidReason: ReasonCode | null;
  repos: RepoEvidence[];
  demo: DemoCheck | null;
  /** Proven in code (A/B) or claimed in the resume (C) — catalogue keys + synthetic ones (next-api, jsp, db …). */
  techKeys: string[];
  /** Bucket rules this project satisfies. */
  buckets: Bucket[];
  /** Has a backend of its own. */
  backend: boolean;
  note: string;
}

export interface OssEvidence {
  claimId: string;
  url: string;
  status: "verified" | "unverified" | "unavailable";
  note: string;
}

export interface ProjectEvidenceResult {
  githubUser: string;
  githubUserSource: "row" | "resume" | "repo-owner" | "";
  projects: ProjectEvidence[];
  oss: OssEvidence[];
  callsUsed: number;
  /** Some GitHub check could not run (rate limit / outage / token). */
  unavailable: boolean;
  notes: string[];
}

// ── Bucketing (Agents 3-4) ───────────────────────────────────────────────────

export interface BucketDecision {
  bucket: Bucket | null;
  flagshipId: string;
  supportingIds: string[];
  basis: "flagship" | "internship" | "both" | "";
  flagshipStrength: number;
  /** 0-100 per project id — lets the stage arbiter re-pick a flagship. */
  projectStrengths: Record<string, number>;
  rationale: string;
  /** Buckets the verified evidence allows (deterministic). */
  eligible: Bucket[];
  noBucketReason: string;
  /** The bucket rests on a demo-only project + internship (trust capped). */
  tierCBacked: boolean;
  model: string;
  attempt: number;
  error: string;
}

export interface BucketReview extends Review {
  betterBucket: Bucket | null;
}

// ── DSA (Agents 5-6) ─────────────────────────────────────────────────────────

export const DSA_PLATFORMS = ["codeforces", "codechef", "leetcode"] as const;
export type DsaPlatformKey = (typeof DSA_PLATFORMS)[number];

export interface DsaPlatform {
  url: string;
  handle: string;
  source: ProfileSource | "";
  found: boolean | null;
  solved: number | null;
  contests: number | null;
  rating: number | null;
  maxRating: number | null;
  note: string;
  /** 0-1 platform score (after the verifier's sanity checks). */
  score: number;
  ratingIgnored: boolean;
}

export interface DsaResult {
  platforms: Record<DsaPlatformKey, DsaPlatform>;
  /** 0-100. */
  score: number;
  flags: string[];
}

// ── Final (Agents 7-8) ───────────────────────────────────────────────────────

export type BucketingStatus = "bucketed" | "not_bucketed" | "retry_needed";

export interface Scores {
  overall: number;
  validation: number;
  /** Verified domain score of the final bucket. */
  domain: number;
  flagship: number;
  dsa: number;
}

export interface FinalDecision {
  status: BucketingStatus;
  bucket: Bucket | null;
  stageLabel: string;
  priorityTier: 1 | 2 | 3;
  validated: boolean;
  /** Why there is no bucket (or why a re-run is needed). */
  reasonCodes: ReasonCode[];
  /** Flags on a bucketed candidate (TRACK_MISMATCH, LOW_TRUST). */
  flags: ReasonCode[];
  flagshipId: string;
  scores: Scores;
  remarks: string[];
  /** TR-2 track backed by the resume (null = not a bucket track / not TR-2). */
  trackBacked: boolean | null;
  attempt: number;
}

export type TrustBand = "High" | "Medium" | "Low";

export interface FinalReview {
  verdict: Verdict;
  /** null when a re-run is needed — no trust is given on missing evidence. */
  trust: number | null;
  band: TrustBand | null;
  needsReview: boolean;
  components: { domain: number | null; bucket: number | null; dsa: number | null; final: number };
  caps: string[];
  issues: string[];
  model: string;
}

export interface TraceEntry {
  node: string;
  ms: number;
  model?: string;
  decision: string;
}

// ── The result the API returns and the browser stores ───────────────────────

export interface BucketingResult {
  id: string;
  mobile: string;
  name: string;
  batch: number;
  stage: Stage;
  track: Track | null;
  stageLabel: string;
  priorityTier: 1 | 2 | 3;
  status: BucketingStatus;
  bucket: Bucket | null;
  validated: boolean;
  reasonCodes: ReasonCode[];
  flags: ReasonCode[];
  remarks: string[];
  scores: Scores;
  trust: FinalReview;
  primaryDomain: { domain: DomainKey; score: number } | null;
  domains: DomainScore[];
  flagship: {
    id: string;
    title: string;
    tier: Tier;
    github: string[];
    demo: string;
    techs: string[];
    strength: number;
  } | null;
  projects: (ExtractedProject & { evidence: ProjectEvidence | null })[];
  experience: ExtractedExperience[];
  openSource: (OssClaim & { evidence: OssEvidence[] })[];
  dsa: DsaResult;
  reviews: {
    domain: DomainReview | null;
    bucket: BucketReview | null;
    dsa: Review | null;
  };
  resume: ResumeInfo;
  githubUser: string;
  /** Every link the resume carries (annotations + text) — for checking a "no GitHub link" verdict by eye. */
  documentUrls: string[];
  extractionDropped: string[];
  trace: TraceEntry[];
  errors: string[];
  promptVersion: string;
  /** Hash of everything the result depends on (resume, stage, track, links, prompt version) — the browser's cache key. */
  inputHash: string;
  models: string[];
  durationMs: number;
  evaluatedAt: string;
}

// ── A saved run (browser) ────────────────────────────────────────────────────

export interface BucketingBatch {
  n: number;
  addedAt: string;
  count: number;
}

export interface BucketingRunStats {
  evaluated: number;
  bucketed: number;
  notBucketed: number;
  retry: number;
  needsReview: number;
  byBucket: Record<Bucket, number>;
}

export interface BucketingRunMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  concurrency: number;
  defaultStage: Stage;
  batches: BucketingBatch[];
  candidates: BucketingCandidateInput[];
  stats: BucketingRunStats;
}

/** A results file the browser can import: the batch runner's output, with or without its candidate list. */
export interface BucketingImportFile {
  name?: string;
  candidates?: BucketingCandidateInput[];
  results: BucketingResult[];
}

const EMPTY_PLATFORM: DsaPlatform = {
  url: "",
  handle: "",
  source: "",
  found: null,
  solved: null,
  contests: null,
  rating: null,
  maxRating: null,
  note: "",
  score: 0,
  ratingIgnored: false,
};

export function emptyDsa(): DsaResult {
  return {
    platforms: { codeforces: { ...EMPTY_PLATFORM }, codechef: { ...EMPTY_PLATFORM }, leetcode: { ...EMPTY_PLATFORM } },
    score: 0,
    flags: [],
  };
}

/** A sheet row with no resume link: recorded (so every candidate is accounted for), never sent to the models. */
export function noResumeResult(c: BucketingCandidateInput): BucketingResult {
  const r = failedBucketingResult(c, "No resume link in the sheet — add the resume and re-run this candidate.");
  return {
    ...r,
    status: "not_bucketed",
    reasonCodes: ["NO_RESUME_LINK"],
    trust: { ...r.trust, verdict: "pass", trust: 100, band: "High", needsReview: true, issues: [] },
    resume: { status: "unreadable", source: "", transcribed: false, chars: 0, note: "No resume link in the sheet", model: "" },
    errors: [],
  };
}

/** A row that could not be evaluated (timeout, crash) — always "re-run", never a rejection. */
export function failedBucketingResult(c: BucketingCandidateInput, error: string, durationMs = 0): BucketingResult {
  return {
    id: c.id,
    mobile: c.mobile,
    name: c.name,
    batch: c.batch,
    stage: c.stage,
    track: c.track,
    stageLabel: stageLabel(c.stage, c.track),
    priorityTier: STAGE_TIER[c.stage],
    status: "retry_needed",
    bucket: null,
    validated: false,
    reasonCodes: ["PIPELINE_ERROR"],
    flags: [],
    remarks: [error],
    scores: { overall: 0, validation: 0, domain: 0, flagship: 0, dsa: 0 },
    trust: {
      verdict: "fail",
      trust: null,
      band: null,
      needsReview: true,
      components: { domain: null, bucket: null, dsa: null, final: 0 },
      caps: [],
      issues: [error],
      model: "",
    },
    primaryDomain: null,
    domains: [],
    flagship: null,
    projects: [],
    experience: [],
    openSource: [],
    dsa: emptyDsa(),
    reviews: { domain: null, bucket: null, dsa: null },
    resume: { status: "error", source: "", transcribed: false, chars: 0, note: error, model: "" },
    githubUser: "",
    documentUrls: [],
    extractionDropped: [],
    trace: [],
    errors: [error],
    promptVersion: BUCKETING_PROMPT_VERSION,
    inputHash: "",
    models: [],
    durationMs,
    evaluatedAt: new Date().toISOString(),
  };
}
