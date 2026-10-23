import {
  BUCKETING_PROMPT_VERSION,
  TRACK_BUCKET,
  TRACK_LABEL,
  priorityTier,
  stageLabel,
  type Bucket,
  type DomainKey,
  type ReasonCode,
  type Stage,
  type Tr2Verdict,
  type Track,
} from "@/lib/bucketing/config";

/**
 * Candidate Bucketing — data shapes shared by the graph (server) and the UI
 * (browser). Client-safe: types plus a few pure helpers.
 */

// ── Input ────────────────────────────────────────────────────────────────────

/** One TR-2 hire verdict from the interview export ("TR2 <track> Verdict"). */
export interface InterviewTr2 {
  track: Track;
  verdict: Tr2Verdict;
}

/**
 * The internal assessments from the interview export — the strongest signal there is.
 * The drive's funnel: assessment → DSA interview (TR-1; "Shortlisted" = cleared) →
 * resume-based interview (TR-2, one per track), or a single combined interview.
 * Fields marked optional were added after the first v2 runs were saved.
 */
export interface InterviewRecord {
  /** Hire verdicts by track, best first. */
  tr2: InterviewTr2[];
  /** Tracks where the candidate sat TR-2 and was rejected. */
  tr2Rejected: Track[];
  /** TR-2 tracks assigned but not interviewed yet ("TR2 <track> State" = assigned). */
  tr2Pending?: Track[];
  /** Combined-interview path verdict (no track) — counted as TR-2. */
  combined: Tr2Verdict | null;
  /** The combined interview was taken and rejected. */
  combinedRejected?: boolean;
  /** combinedInterviewState: "pending" / "completed" / "" (separate path). */
  combinedState?: string;
  /** interviewPath: "separate" / "combined". */
  interviewPath?: string;
  /** currentStage in the drive: dsa_interview / resume_based_interview / combined_interview … */
  currentStage?: string;
  /** The DSA interview (the TR-1 round): qualifying status ("shortlisted" = cleared) and its scores. */
  dsaInterview?: { qualifying: string; dsaScore: number | null; csScore: number | null };
  /** journeyStatus "closed" (not responding, placed …) — such candidates are not bucketed. */
  journey?: { status: string; reason: string; notes: string };
  tr1: {
    /** tr1Status: "pass" / "fail" / "" (not taken). */
    status: string;
    selfIntro: number | null;
    dsaOverall: number | null;
    problemSolving: number | null;
    coding: number | null;
    communication: number | null;
    debugging: number | null;
    /** tr1OverallTechnicalScore, out of 100. */
    overallTechnical: number | null;
  };
  assessment: {
    /** offlineOverallScore, out of 160 (DSA coding 120 + CS fundamentals 40). */
    offlineOverall: number | null;
    dsaCoding: number | null;
    csFundamentals: number | null;
    /** Out of 15 each. */
    sqlMcq: number | null;
    sqlCoding: number | null;
  };
}

export interface BucketingCandidateInput {
  /** Normalised mobile number — the candidate's id. */
  id: string;
  mobile: string;
  name: string;
  /** "" when the sheets have no resume link for this candidate. */
  resumeUrl: string;
  /** Pasted resume text (used only when there is no readable link). */
  resumeText?: string;
  /** Highest cleared stage. */
  stage: Stage;
  /** TR-2 track of the best hire verdict (null: TR-1 / Assessment, or a combined-interview hire). */
  track: Track | null;
  /** Best TR-2 hire verdict (TR-2 only). */
  verdict?: Tr2Verdict | null;
  /** Internal assessments, when the sheet is the interview export. */
  interview?: InterviewRecord;
  /** The export's own candidate id, email and college — for the exports; never shown to the models. */
  externalId?: string;
  email?: string;
  college?: string;
  /** Sheet columns override links found in the resume. */
  githubUrl?: string;
  leetcodeUrl?: string;
  codechefUrl?: string;
  codeforcesUrl?: string;
  batch: number;
}

/** Ranking tier of a candidate: 1 TR-2 strong hire … 5 Assessment. */
export const tierOf = (c: Pick<BucketingCandidateInput, "stage" | "verdict">) => priorityTier(c.stage, c.verdict ?? null);

/** Where the candidate stands beyond the tag: pending / rejected interviews, a closed journey. "" when nothing to add. */
export function interviewNote(iv: InterviewRecord | null | undefined): string {
  if (!iv) return "";
  const parts: string[] = [];
  if (iv.journey?.status === "closed") parts.push(`Journey closed${iv.journey.reason ? ` (${iv.journey.reason.replace(/_/g, " ")})` : ""}`);
  if (iv.tr2Pending?.length) parts.push(`TR-2 pending: ${iv.tr2Pending.map((t) => TRACK_LABEL[t]).join(", ")}`);
  if (iv.tr2Rejected.length) parts.push(`TR-2 rejected: ${iv.tr2Rejected.map((t) => TRACK_LABEL[t]).join(", ")}`);
  if (iv.combinedState === "pending") parts.push("Combined interview pending");
  else if (iv.combinedRejected) parts.push("Combined interview rejected");
  const tr1Taken = Boolean(iv.tr1.status) || Boolean(iv.dsaInterview?.qualifying);
  const tr1Cleared = /^pass/.test(iv.tr1.status) || iv.dsaInterview?.qualifying === "shortlisted";
  if (!iv.tr2.length && !iv.combined && !iv.tr2Rejected.length && !iv.tr2Pending?.length && tr1Taken && !tr1Cleared) parts.push("TR-1 not cleared");
  return parts.join(" · ");
}

/** A closed journey in the drive (not responding, placed …). */
export const journeyClosed = (c: Pick<BucketingCandidateInput, "interview">) => c.interview?.journey?.status === "closed";

/**
 * Buckets of the TR-2 tracks the candidate was hired in, at the best verdict among
 * tracks that have a bucket (Product has none). Empty for combined-interview hires,
 * TR-1 and Assessment.
 */
export function hireTrackBuckets(c: Pick<BucketingCandidateInput, "stage" | "track" | "interview">): Bucket[] {
  if (c.stage !== "TR2") return [];
  const hires = (c.interview?.tr2 ?? []).filter((t) => TRACK_BUCKET[t.track]);
  if (!hires.length) {
    const b = c.track ? TRACK_BUCKET[c.track] : undefined;
    return b ? [b] : [];
  }
  return hires.filter((t) => t.verdict === hires[0].verdict).map((t) => TRACK_BUCKET[t.track]!);
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

export type AchievementKind = "win" | "rank" | "publication" | "award" | "participation" | "certification" | "other";

export interface ExtractedAchievement {
  /** A1, A2 … */
  id: string;
  title: string;
  kind: AchievementKind;
  description: string;
  quote: string;
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
  /** Hackathons, competitions, ranks, publications, awards — good to have. */
  achievements: ExtractedAchievement[];
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
  /** Jupyter notebooks in the repo (a bonus for DS/ML and GenAI work). */
  notebooks: number;
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

/**
 * A valid GitHub + live demo · B valid GitHub · C demo only · R an ML / GenAI project
 * described on the resume with no GitHub (GitHub is optional there) · D not evidence.
 */
export type Tier = "A" | "B" | "C" | "R" | "D";

export type ProjectStatus = "verified" | "invalid" | "unavailable" | "demo_only" | "resume_only" | "no_link" | "not_audited";

export interface ProjectEvidence {
  projectId: string;
  title: string;
  status: ProjectStatus;
  /** Tier A, B, C or R. */
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
  /** Its repo holds Jupyter notebooks. */
  notebooks: boolean;
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
  /** Buckets backed only by an internship / job (no project). */
  roleOnly: Bucket[];
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
  /** 40% internal assessments + 30% projects + 20% experience + 10% achievements. */
  overall: number;
  /** TR-2 verdict, TR-1 technical score and assessment score, 0-100. */
  internal: number;
  /** Projects backing the bucket: flagship strength, verified evidence, domain fit. */
  projects: number;
  experience: number;
  achievements: number;
  /** Verified domain score of the final bucket. */
  domain: number;
  flagship: number;
  dsa: number;
  /** Kept for older results; no longer part of the overall score. */
  validation: number;
}

/** The internal-assessment parts behind `scores.internal` (null = not in the export). */
export interface InternalParts {
  tr2: number | null;
  tr1: number | null;
  assessment: number | null;
  sql: number | null;
}

export interface FinalDecision {
  status: BucketingStatus;
  bucket: Bucket | null;
  stageLabel: string;
  /** 1 TR-2 strong hire · 2 medium · 3 low · 4 TR-1 · 5 Assessment. */
  priorityTier: number;
  /** At least one verified project (tier A, B or R). */
  validated: boolean;
  /** How the bucket was decided. */
  placedBy: "tr2-track" | "evidence" | "";
  internalParts: InternalParts;
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
  verdict: Tr2Verdict | null;
  stageLabel: string;
  /** 1 TR-2 strong hire · 2 medium · 3 low · 4 TR-1 · 5 Assessment. */
  priorityTier: number;
  status: BucketingStatus;
  placedBy: "tr2-track" | "evidence" | "";
  /** The internal assessments as read from the export. */
  interview: InterviewRecord | null;
  internalParts: InternalParts;
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
  achievements: ExtractedAchievement[];
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
  /** The candidate's data changed (a newer export / resume sheet) — this result waits for a re-run. */
  stale?: boolean;
}

// ── A saved run (browser) ────────────────────────────────────────────────────

export interface BucketingBatch {
  n: number;
  addedAt: string;
  count: number;
  /** The file (or "pasted rows") the batch came from. */
  source?: string;
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

export const EMPTY_SCORES: Scores = { overall: 0, internal: 0, projects: 0, experience: 0, achievements: 0, domain: 0, flagship: 0, dsa: 0, validation: 0 };
export const EMPTY_INTERNAL: InternalParts = { tr2: null, tr1: null, assessment: null, sql: null };

/** A row that could not be evaluated (timeout, crash) — always "re-run", never a rejection. */
export function failedBucketingResult(c: BucketingCandidateInput, error: string, durationMs = 0): BucketingResult {
  return {
    id: c.id,
    mobile: c.mobile,
    name: c.name,
    batch: c.batch,
    stage: c.stage,
    track: c.track,
    verdict: c.verdict ?? null,
    stageLabel: stageLabel(c.stage, c.track, c.verdict ?? null),
    priorityTier: tierOf(c),
    status: "retry_needed",
    placedBy: "",
    interview: c.interview ?? null,
    internalParts: EMPTY_INTERNAL,
    bucket: null,
    validated: false,
    reasonCodes: ["PIPELINE_ERROR"],
    flags: [],
    remarks: [error],
    scores: EMPTY_SCORES,
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
    achievements: [],
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

/** Older saved results (bucketing-v1) lack the v2 fields — fill them so the screens never break. */
export function upgradeResult(r: BucketingResult): BucketingResult {
  const legacy = r as Partial<BucketingResult> & BucketingResult;
  return {
    ...legacy,
    verdict: legacy.verdict ?? null,
    placedBy: legacy.placedBy ?? "",
    interview: legacy.interview ?? null,
    internalParts: legacy.internalParts ?? EMPTY_INTERNAL,
    achievements: legacy.achievements ?? [],
    scores: { ...EMPTY_SCORES, ...legacy.scores },
    // v1 numbered tiers by stage only (TR-2 1, TR-1 2, Assessment 3).
    priorityTier: legacy.verdict === undefined ? priorityTier(legacy.stage, null) : legacy.priorityTier,
  };
}
