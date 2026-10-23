import type { DsaSnapshot } from "@/lib/dsa-types";

/**
 * Academy bucketing — sort the academy-assessed pool into tech-stack buckets for
 * mentor assignment. Three Google Sheets are read (view only):
 *  1. the master pool ("Sahana Working New Criteria"): eligibility, Active Pool,
 *     placement, preference, resume link, old-process and competency results;
 *  2. the competency interview sheet (Frontend / DSA / Backend / SE tabs): the
 *     interview detail behind each level;
 *  3. the old-process assessment sheet: Bucket A–D and the section scores.
 * Eligibility is decided from sheet 1 only; sheets 2 and 3 add detail.
 */

export const AC_BUCKETS = ["frontend", "backend", "aiml", "fullstack"] as const;
export type AcBucket = (typeof AC_BUCKETS)[number];
/** Where a candidate lands: one tech bucket, or Mixed when two are nearly equal. */
export type AcPlacement = AcBucket | "mixed";

export const AC_BUCKET_LABEL: Record<AcBucket, string> = {
  frontend: "Frontend",
  backend: "Backend",
  aiml: "AI-ML",
  fullstack: "Full Stack",
};

export const AC_PLACEMENT_LABEL: Record<AcPlacement, string> = { ...AC_BUCKET_LABEL, mixed: "Mixed" };

/** What each bucket covers (shown in the UI and the workbook's summary tab). */
export const AC_BUCKET_SCOPE: Record<AcBucket, string> = {
  frontend: "UI work: React / Angular / Vue / HTML-CSS-JS apps with no server of their own.",
  backend: "Server-side work: APIs, services, databases, auth (Node, Java / Spring, Python, Go, …).",
  aiml: "AI / ML, data science and generative AI: models, data pipelines, LLM / RAG / agents.",
  fullstack: "Both sides built by the candidate: UI plus their own server / API and database (MERN, Django + React, …).",
};

export type AcScores = Record<AcBucket, number>;
export const ZERO_SCORES: AcScores = { frontend: 0, backend: 0, aiml: 0, fullstack: 0 };

// ── Sheets as read ───────────────────────────────────────────────────────────

/** One output column taken from a source sheet. */
export interface AcColumn {
  key: string;
  label: string;
  source: "s1" | "s2" | "s3";
}

/** One competency interview result from sheet 1's competency block (e.g. "Frontend Levels"). */
export interface AcCompetency {
  /** "Frontend", "DSA", "SE Fundamentals", "Backend", … */
  name: string;
  /** The bucket this competency speaks for; null = no stack (DSA, SE fundamentals). */
  bucket: AcBucket | null;
  /** "L4", "L3", "Below L1", … as written. */
  level: string;
  /** Overall Score (out of 100), when given. */
  score: number | null;
  verdict: string;
  clearance: string;
}

/** One old-process interview round (Bucket A TR 1, Bucket B TR 2, …). */
export interface AcOldRound {
  label: string;
  score: string;
  status: string;
}

export type AcPlacementInfo = "not-placed" | "placed" | "unknown";
export type AcOldBucket = "A" | "B" | "C" | "D" | "";

export interface AcEligibility {
  /** Competencies at L3 / L4 (condition 1). */
  levels: string[];
  /** DSA Offline cleared (condition 2). */
  dsaOffline: boolean;
  /** Old process Bucket A (condition 3). */
  bucketA: boolean;
  eligible: boolean;
  /** Human-readable reasons, e.g. "Frontend L4", "DSA Offline cleared", "Old Bucket A". */
  via: string[];
}

/** One competency interview from sheet 2 (the latest one per tab) — what the trust agent reads. */
export interface AcInterview {
  /** Sheet 2 tab, e.g. "Frontend Development". */
  tab: string;
  status: string;
  level: string;
  /** Interview integrity 0-5 as recorded ("" when not recorded). */
  integrityScore: string;
  /** The interviewer's integrity note (camera, screen share, "reading from somewhere" …). */
  integrityNote: string;
  /** Overall remarks / feedback. */
  remarks: string;
}

export interface AcCandidate {
  /** UID (lower-cased email when a row has no UID). The key everything joins on. */
  id: string;
  uid: string;
  name: string;
  email: string;
  mobile: string;
  resumeUrl: string;
  activePool: boolean;
  activePoolRaw: string;
  placement: AcPlacementInfo;
  placementRaw: string;
  preference: string;
  dsaOffline: string;
  oldBucket: AcOldBucket;
  competencies: AcCompetency[];
  oldRounds: AcOldRound[];
  /** Old-process section scores from sheet 3 (null = not matched / blank). */
  oldOverall: number | null;
  oldCoding: number | null;
  eligibility: AcEligibility;
  /** Output values keyed by AcColumn.key, for every source. */
  values: Record<string, string>;
  /** Sheet 2 tabs this candidate has an interview in. */
  s2Tabs: string[];
  /** The latest interview per sheet 2 tab (absent in runs saved before it existed — reload the sheets). */
  interviews?: AcInterview[];
  /** How sheet 3 was matched. */
  s3Match: "uid" | "mobile" | "email" | "";
  /** Sheet row number (1-based, as in Google Sheets) — for tracing back. */
  sheetRow: number;
}

export interface AcSourceInfo {
  url: string;
  title: string;
  tabs: string[];
}

export interface AcDataset {
  loadedAt: string;
  sources: { s1: AcSourceInfo; s2: AcSourceInfo; s3: AcSourceInfo };
  /** Output columns in order: sheet 1, then sheet 2 (per tab), then sheet 3. */
  columns: AcColumn[];
  candidates: AcCandidate[];
  warnings: string[];
}

// ── Evidence read per candidate (server) ─────────────────────────────────────

export const AC_ITEM_KINDS = ["job", "internship", "freelance", "project"] as const;
export type AcItemKind = (typeof AC_ITEM_KINDS)[number];
export const AC_STACKS = ["frontend", "backend", "fullstack", "aiml", "other"] as const;
export type AcStack = (typeof AC_STACKS)[number];
export const AC_DEPTHS = ["production", "substantial", "basic"] as const;
export type AcDepth = (typeof AC_DEPTHS)[number];
/** Which side of a web item the candidate personally worked on more. */
export const AC_FOCUS = ["frontend", "backend", "balanced", "n/a"] as const;
export type AcFocus = (typeof AC_FOCUS)[number];

/** One project / internship / job on the resume, checked against the resume text. */
export interface AcResumeItem {
  kind: AcItemKind;
  /** Project name, or the role title, exactly as written. */
  title: string;
  /** Company for a job / internship ("" for a project). */
  org: string;
  /** The model's reading of the stack (the program re-derives it from the technologies). */
  stack: AcStack;
  depth: AcDepth;
  /** Technologies named for this item that are in the resume text. */
  techs: string[];
  /** Catalogue keys of those technologies (github-analysis.ts) — what the program classifies on. */
  techKeys: string[];
  /** The resume's own words about what was built ("" when not verified). */
  quote: string;
  /** For web work: the side the candidate worked on more, as the resume describes it (absent in older readings). */
  focus?: AcFocus;
}

export type AcGithubStatus = "checked" | "no-link" | "not-found" | "no-repos" | "failed" | "off";

export interface AcGithubRepo {
  name: string;
  url: string;
  /** Technologies the repo's CODE proves (labels). */
  techs: string[];
  techKeys: string[];
  /** Proves at least one technology the buckets look for. */
  relevant: boolean;
  aiLikelihood: "none" | "low" | "medium" | "high";
  lastOwnCommit: string;
}

export interface AcGithub {
  status: AcGithubStatus;
  note: string;
  profile: string;
  repos: AcGithubRepo[];
  provenTechs: string[];
  checkedAt: string;
  fromCache: boolean;
}

/** Bump when the evaluator reads differently, so older results can be re-read. */
export const AC_EVAL_VERSION = 2;

/** Does the resume belong to this sheet row? Checked by the program against the resume text. */
export interface AcIdentity {
  /** Name at the top of the resume, as the model read it. */
  nameOnResume: string;
  /** The sheet's name and the resume's name share a name word (null = no name on either). */
  nameMatch: boolean | null;
  /** The sheet's email / mobile appears in the resume text. */
  emailFound: boolean;
  phoneFound: boolean;
}

export const AC_TRUST_CATEGORIES = [
  "identity",
  "inflated-claim",
  "timeline",
  "template-project",
  "inconsistent",
  "copied-text",
  "github-authorship",
  "interview-integrity",
] as const;
export type AcTrustCategory = (typeof AC_TRUST_CATEGORIES)[number];
export const AC_TRUST_SEVERITY = ["high", "medium", "low"] as const;
export type AcTrustSeverity = (typeof AC_TRUST_SEVERITY)[number];

/** One doubt the trust agent raised, with the exact words it rests on (checked by the program). */
export interface AcTrustFlag {
  category: AcTrustCategory;
  severity: AcTrustSeverity;
  /** Exact words from the resume or the evidence the agent was given. */
  evidence: string;
  why: string;
}

export interface AcTrustReview {
  flags: AcTrustFlag[];
  /** One or two sentences: how far the evidence can be trusted. */
  summary: string;
  model: string;
  /** Flags dropped because their evidence wasn't in what the agent was given. */
  dropped: number;
}

export interface AcEvaluation {
  id: string;
  status: "ok" | "invalid" | "error";
  error: string;
  retryable: boolean;
  /** The resume link that was read — a changed link in the sheet means a re-read. */
  resumeUrl: string;
  /** What was asked for. */
  read: { github: boolean; dsa: boolean; trust?: boolean };
  items: AcResumeItem[];
  /** Technologies in the Skills section (verified). */
  skills: string[];
  skillKeys: string[];
  primaryProfile: string;
  remarks: string;
  github: AcGithub | null;
  dsa: DsaSnapshot | null;
  /** Resume ↔ sheet identity check (absent in older readings). */
  identity?: AcIdentity | null;
  /** The trust agent's review (null when it was off or failed; absent in older readings). */
  trust?: AcTrustReview | null;
  /** Why the trust agent has no review, when it was asked for one. */
  trustError?: string;
  checks: string[];
  model: string;
  source: string;
  transcribed: boolean;
  durationMs: number;
  analyzedAt: string;
  version: number;
}

export interface AcEvalRequest {
  id: string;
  name: string;
  email?: string;
  mobile?: string;
  resumeUrl: string;
  github: boolean;
  dsa: boolean;
  /** Run the trust agent. */
  trust?: boolean;
  /** What the sheets say, for the trust agent to cross-check against the resume. */
  context?: { competencies: { name: string; level: string; score: number | null }[]; interviews: AcInterview[] };
}

export function failedAcEvaluation(r: Pick<AcEvalRequest, "id" | "resumeUrl" | "github" | "dsa" | "trust">, error: string, retryable: boolean, durationMs = 0): AcEvaluation {
  return {
    id: r.id,
    status: "error",
    error,
    retryable,
    resumeUrl: r.resumeUrl,
    read: { github: r.github, dsa: r.dsa, trust: Boolean(r.trust) },
    items: [],
    skills: [],
    skillKeys: [],
    primaryProfile: "",
    remarks: "",
    github: null,
    dsa: null,
    checks: [],
    model: "",
    source: "",
    transcribed: false,
    durationMs,
    analyzedAt: new Date().toISOString(),
    version: AC_EVAL_VERSION,
  };
}

// ── Rules (all switchable; changing one re-buckets instantly) ────────────────

export interface AcRules {
  signals: { resume: boolean; github: boolean; competency: boolean; preference: boolean; dsa: boolean };
  /** Relative weight of each stack signal; renormalised over the signals a candidate has. */
  weights: { resume: number; github: number; competency: number; preference: number };
  /** Mixed when the second bucket is within this many points of the first … */
  mixedMargin: number;
  /** … and both are at least this strong. */
  mixedMinScore: number;
  /** Frontend and Backend nearly equal = Full Stack (they are its two halves), not Mixed. */
  feBeAsFullStack: boolean;
  /** Bucket Active Pool candidates who are already placed (ranked after the not-placed ones). */
  includePlaced: boolean;
  /** Ranking inside a bucket: stack fit, internal assessments, DSA. */
  rankWeights: { fit: number; assessment: number; dsa: number };
  /**
   * Temporary rebalancing: Full Stack candidates whose own web work is mostly backend move to Backend.
   * minBackendShare = backend share of their frontend + backend work (%), minBackendScore = their
   * Backend score at least this, maxMoves 0 = at most half the Full Stack − Backend gap.
   */
  nudge: { enabled: boolean; minBackendShare: number; minBackendScore: number; maxMoves: number };
  /**
   * Trust agent: identity, claims, GitHub authorship and interview integrity → a 0-100 trust score.
   * Below relyAt, resume and GitHub count at half weight and the candidate is tagged.
   */
  trust: { enabled: boolean; relyAt: number };
}

export const DEFAULT_AC_RULES: AcRules = {
  signals: { resume: true, github: true, competency: true, preference: true, dsa: true },
  weights: { resume: 45, github: 25, competency: 20, preference: 10 },
  mixedMargin: 10,
  mixedMinScore: 50,
  feBeAsFullStack: true,
  includePlaced: true,
  rankWeights: { fit: 45, assessment: 35, dsa: 20 },
  nudge: { enabled: true, minBackendShare: 50, minBackendScore: 50, maxMoves: 0 },
  trust: { enabled: true, relyAt: 60 },
};

/** Rules saved by an older version, filled in with today's defaults. */
export function withDefaultRules(r: Partial<AcRules> | undefined): AcRules {
  const d = DEFAULT_AC_RULES;
  return {
    ...d,
    ...r,
    signals: { ...d.signals, ...r?.signals },
    weights: { ...d.weights, ...r?.weights },
    rankWeights: { ...d.rankWeights, ...r?.rankWeights },
    nudge: { ...d.nudge, ...r?.nudge },
    trust: { ...d.trust, ...r?.trust },
  };
}

export interface AcRunMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  rules: AcRules;
  concurrency: number;
  /** When the sheets were last read (the dataset itself is stored on its own — it is large). */
  loadedAt: string;
  sheetTitle: string;
  stats: {
    candidates: number;
    inScope: number;
    evaluated: number;
    toRead: number;
    /** Reads that failed for a passing reason. */
    errors: number;
    /** Resume links that can't be opened (not shared / not a resume). */
    unreadable?: number;
    byPlacement: Record<AcPlacement, number>;
    needsEvidence: number;
    /** Full Stack candidates moved to Backend by the nudge. */
    nudged?: number;
    lowTrust?: number;
  };
}
