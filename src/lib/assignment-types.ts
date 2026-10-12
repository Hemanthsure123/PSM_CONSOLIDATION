/**
 * Shared types for Assignment Evaluation (client + server). Plain data only —
 * everything here must survive JSON (server actions + localStorage).
 */

export type CtcBand = "lt6" | "6to8" | "8to12" | "12to20" | "20plus";

export type CriterionType = "mandatory" | "good" | "excellence";

export const CRITERION_CATEGORIES = [
  "functional",
  "technical",
  "architecture",
  "code-quality",
  "testing",
  "documentation",
  "deployment",
  "ui-ux",
  "security",
  "performance",
  "other",
] as const;
export type CriterionCategory = (typeof CRITERION_CATEGORIES)[number];

/** How the criterion's source quote was matched against the assignment text. */
export type QuoteCheck = "exact" | "approx" | "missing" | "skipped";

export interface AssignmentCriterion {
  /** "C1", "C2", … — stable within a run; used as the CSV column key. */
  id: string;
  title: string;
  description: string;
  category: CriterionCategory;
  type: CriterionType;
  /** Relative importance, 1–10. */
  weight: number;
  /** Verbatim excerpt from the assignment that states this requirement ("" for excellence). */
  sourceQuote: string;
  quoteCheck: QuoteCheck;
  /** What to look for in the code. */
  howToVerify: string;
  enabled: boolean;
}

export interface AssignmentSpec {
  title: string;
  summary: string;
  requiredStack: string[];
  restrictions: string[];
  deliverables: string[];
  criteria: AssignmentCriterion[];
  /** "provider/model" that extracted the rubric. */
  model: string;
}

export interface Thresholds {
  strong: number;
  shortlist: number;
  borderline: number;
}

export interface AssignmentRunConfig {
  runName: string;
  company: string;
  ctcBand: CtcBand;
  /** Submission deadline, `YYYY-MM-DD` (IST) or "". */
  deadline: string;
  thresholds: Thresholds;
  /** Candidates evaluated in parallel on the server (1–4). */
  concurrency: number;
}

/** One pasted row. `id` is the mobile number, used as the candidate's UUID. */
export interface CandidateInput {
  id: string;
  githubUrl: string;
}

export type CriterionStatus = "met" | "partial" | "not_met" | "unverified";

export interface CriterionResult {
  id: string;
  status: CriterionStatus;
  /** 0–10, already clamped to the band its status allows. */
  score: number;
  evidence: string;
  files: string[];
}

export type SelectionStatus =
  | "Strongly Shortlisted"
  | "Shortlisted"
  | "Borderline – Manual Review"
  | "AI Generated – Review Manually"
  | "Not Shortlisted"
  | "Invalid Submission"
  | "Error";

/**
 * AI-assistance review. "ai-generated" = hard evidence (AI-agent commits, AI
 * tool config files / generator scaffolding, chat-leakage comments, emojis in
 * comments or logs, or the reviewer model quoting AI-written comments) — the
 * candidate is marked "AI Generated – Review Manually" and never auto-shortlisted.
 * "possible" = mild signs, shown but not acted on. Normal comments never count.
 */
export interface AiReview {
  verdict: "ai-generated" | "possible" | "none";
  reasons: string[];
  /** AI-agent commits and tool traces, quoted. */
  commitEvidence: string[];
  /** AI-style comments / emoji comments & logs, "path — “text”". */
  commentEvidence: string[];
  aiCommits: number;
  emojiCount: number;
}

export interface RepoFacts {
  /** Canonical link of what was analysed (…/tree/<ref>/<path> when scoped). */
  resolvedRepo: string;
  /** Repo was picked from a profile link rather than given directly. */
  autoDetected: boolean;
  autoDetectNote: string;
  ref: string;
  subPath: string;
  /** `owner/repo` of the upstream when this repo is a fork. */
  forkOf: string;
  primaryLanguage: string;
  sizeKb: number;
  filesTotal: number;
  filesInPrompt: number;
  filesNotInPrompt: number;
  hasReadme: boolean;
  hasTests: boolean;
  hasCi: boolean;
  hasDocker: boolean;
  /** Committed dependency / build folders, e.g. "node_modules (1,204 files)". */
  committedJunk: string[];
  /** Possible secrets — path + kind only, never the value. */
  secrets: string[];
  commits: number;
  firstCommit: string;
  lastCommit: string;
  commitsAfterDeadline: number;
  authors: number;
  aiLikelihood: "none" | "low" | "medium" | "high" | "unknown";
  singleDumpRepo: boolean;
  commitSignals: string[];
  liveUrl: string;
  liveStatus: "reachable" | "unreachable" | "none";
  // Git-history depth (optional: runs saved before these existed lack them).
  /** Commits with hard AI coding-agent evidence. */
  aiCommits?: number;
  commitsAnalysed?: number;
  activeDays?: number;
  spanDays?: number;
  busiestDayShare?: number;
  genericMessages?: number;
  webUploads?: number;
  conventional?: number;
  otherAuthors?: string[];
  branches?: number;
  // Code metrics.
  sourceFiles?: number;
  sourceLines?: number;
  testFiles?: number;
  testLines?: number;
  languages?: string;
  largestFiles?: string[];
  todos?: number;
  envExample?: boolean;
  usesEnvVars?: boolean;
}

export interface CandidateEvaluation {
  id: string;
  githubUrl: string;
  status: SelectionStatus;
  /** 0–100 */
  overall: number;
  /** 0–99, deterministic — see assignment-scoring.ts. */
  chance: number;
  mandatoryMet: number;
  mandatoryTotal: number;
  scores: {
    mandatory: number;
    good: number;
    excellence: number;
    architecture: number;
    codeQuality: number;
  };
  criteria: CriterionResult[];
  implementedFeatures: string[];
  missingFeatures: string[];
  architecture: { score: number; pattern: string; strengths: string[]; issues: string[] };
  codeQuality: { score: number; notes: string };
  restrictionViolations: string[];
  /** Flags from the model + deterministic repo checks. */
  redFlags: string[];
  /** Filled on the client from cross-candidate comparison. */
  similarity: { with: string; ratio: number; reason: string }[];
  remarks: string;
  repo: RepoFacts | null;
  /** Short hashes of normalised source files (copy detection). */
  fingerprint: string[];
  /** "provider/model" that judged the code. */
  model: string;
  /** Why the evaluation could not complete ("" when it did). */
  error: string;
  /** Repo was missing / private / empty / not code. */
  invalid: boolean;
  evaluatedAt: string;
  /** Wall-clock time for this candidate (download + analysis), ms. */
  durationMs?: number;
  /** AI-assistance review (absent on runs saved before it existed). */
  aiReview?: AiReview;
}

export interface AssignmentRun {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  config: AssignmentRunConfig;
  /** The assignment text the rubric was derived from (capped). */
  assignmentText: string;
  spec: AssignmentSpec;
  candidates: CandidateInput[];
  results: Record<string, CandidateEvaluation>;
}
