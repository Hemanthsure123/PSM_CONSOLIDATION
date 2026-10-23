import type { DsaPlatform, DsaPlatformResult } from "@/lib/dsa-types";
import type { AcIdentity, AcTrustReview } from "@/lib/academy/types";

/**
 * Sample profiles — the strongest candidates per tech role, to show a company's hiring
 * manager. A cost-ordered funnel over one Google Sheet of thousands of rows:
 *   screen (resume + links, no model) → DSA bar (paced APIs, cached) → GitHub probe →
 *   resume read (one model call) → per-project GitHub verification → trust agent →
 *   roles, gates, scores, tiers (browser, pure — rules change without re-reading).
 * Evidence is the resume, the candidate's own GitHub and their DSA profiles only.
 */

// ── Sheet rows ───────────────────────────────────────────────────────────────

export interface SpCandidate {
  /** Stable key: lower-cased email, else the 10-digit mobile, else "row-<n>". */
  id: string;
  sheetRow: number;
  name: string;
  email: string;
  mobile: string;
  resumeUrl: string;
  /** Profile links given in the sheet's own columns (added to what the resume links). */
  sheetLinks: { github: string; leetcode: string; codeforces: string; codechef: string };
  /** Education columns when the sheet has them (else read from the resume). */
  college: string;
  degree: string;
  yog: string;
  /** Every source column, by label (internal workbook only). */
  values: Record<string, string>;
}

export interface SpDataset {
  loadedAt: string;
  source: { url: string; title: string; tab: string };
  columns: string[];
  /** Which column each field was read from ("" = not found). */
  detected: Record<"name" | "email" | "mobile" | "resume" | "github" | "leetcode" | "codeforces" | "codechef" | "college" | "degree" | "yog", string>;
  candidates: SpCandidate[];
  warnings: string[];
}

// ── Stage 1: screen (no model) ───────────────────────────────────────────────

export interface SpLinks {
  githubProfile: string;
  githubRepos: string[];
  leetcode: string;
  codeforces: string;
  codechef: string;
  /** Every URL found in the resume (the reader may only pick project links from these). */
  urls: string[];
}

export interface SpScreen {
  id: string;
  status: "ok" | "no-resume" | "not-resume" | "needs-ocr" | "error";
  error: string;
  retryable: boolean;
  resumeUrl: string;
  /** Content hash of the resume file (cache keys, duplicate detection). */
  sha: string;
  source: string;
  links: SpLinks;
  /** Platforms the resume names without a profile link ("LeetCode: 600+ solved"). */
  namedWithoutLink: DsaPlatform[];
  /** DSA links built from a handle written in the text ("LeetCode: ravi_07") — they count only when the owner is confirmed. */
  inferred: DsaPlatform[];
  /** GitHub / DSA links that came from the sheet's own columns rather than the resume. */
  fromSheet: string[];
  /** Candidate ID shown to companies (stable hash of email / mobile). */
  candidateId: string;
  version: number;
}

// ── Stage 2: DSA ─────────────────────────────────────────────────────────────

export type SpDsaIdentity = "confirmed" | "unconfirmed" | "mismatch";

export interface SpDsaPlatform extends DsaPlatformResult {
  /** Does the profile's owner look like this candidate (name / linked GitHub)? */
  identity?: SpDsaIdentity;
  identityNote?: string;
  fromCache?: boolean;
  readAt?: string;
  /** Reads that got no answer (found: null) — after a few, the profile counts as unreadable. */
  attempts?: number;
}

export type SpDsa = Partial<Record<DsaPlatform, SpDsaPlatform>>;

// ── GitHub probe (one GraphQL query) ─────────────────────────────────────────

export interface SpProbeRepo {
  name: string;
  url: string;
  diskKb: number;
  pushedAt: string;
  language: string;
  commits: number;
  archived: boolean;
}

export interface SpProbe {
  status: "ok" | "not-found" | "organisation" | "no-code" | "failed";
  note: string;
  login: string;
  name: string;
  createdAt: string;
  repos: SpProbeRepo[];
  checkedAt: string;
  retryAfterMs?: number;
}

// ── Stage 3: resume read (one model call; checked against the text) ─────────

export const SP_SIGNALS = [
  "deployed",
  "real-users",
  "scale",
  "architecture",
  "performance",
  "data-volume",
  "ml-evaluation",
  "security",
  "testing-ci",
  "integrations",
  "realtime",
] as const;
export type SpSignal = (typeof SP_SIGNALS)[number];

export const SP_SIGNAL_LABEL: Record<SpSignal, string> = {
  deployed: "Deployed / live",
  "real-users": "Real users",
  scale: "Scale numbers",
  architecture: "Architecture",
  performance: "Performance work",
  "data-volume": "Data volume",
  "ml-evaluation": "Model evaluation",
  security: "Security / auth",
  "testing-ci": "Tests / CI",
  integrations: "External integrations",
  realtime: "Realtime",
};

export interface SpProject {
  title: string;
  /** Section it sits in on the resume. */
  section: "projects" | "experience" | "other";
  /** Role keys (roles.ts) the model reads it as. */
  roles: string[];
  techs: string[];
  techKeys: string[];
  /** What the candidate personally built, verbatim. */
  quote: string;
  signals: { type: SpSignal; quote: string }[];
  /** Verbatim words that make it a course / tutorial / clone project ("" = none). */
  courseQuote: string;
  /** Verbatim words about a team ("team of 4") ("" = solo / not stated). */
  teamQuote: string;
  depth: "production" | "substantial" | "basic";
  /** The model's 0-100 on the 15+ LPA bar, before the program's caps. */
  quality: number;
  /** Links the resume gives for this project (chosen from the resume's own URLs). */
  repoUrl: string;
  demoUrl: string;
}

export interface SpJob {
  company: string;
  title: string;
  employmentType: "full-time" | "internship" | "part-time" | "freelance" | "contract" | "other";
  datesText: string;
  months: number | null;
  current: boolean;
  companyType: "product" | "it-services" | "consulting" | "staffing" | "unknown";
  companyTypeSource: "model" | "list";
  roles: string[];
  work: string;
}

export interface SpRead {
  id: string;
  status: "ok" | "invalid" | "error";
  error: string;
  retryable: boolean;
  nameOnResume: string;
  education: { degree: string; institution: string; year: string };
  projects: SpProject[];
  jobs: SpJob[];
  skills: string[];
  skillKeys: string[];
  checks: string[];
  model: string;
  transcribed: boolean;
  /** Plain resume text kept for the trust agent (not exported). */
  textChars: number;
  version: number;
  readAt: string;
}

// ── Stage 4: per-project GitHub verification ────────────────────────────────

export type SpProofStatus = "verified" | "weak" | "failed" | "no-repo" | "unavailable";

export interface SpProjectProof {
  title: string;
  repoUrl: string;
  /** How the repo was found: the resume's link for this project, or a name match on their account. */
  matchedBy: "resume-link" | "name-match" | "";
  /**
   * The server's reading of hard facts: "failed" (not found / private / a fork), "no-repo",
   * "unavailable" (GitHub didn't answer). For a readable repo it says "verified" and the
   * browser re-decides verified / weak / failed from the facts below and the rules.
   */
  status: SpProofStatus;
  why: string;
  /** The repo's code proves this project's stack (its technologies or its role). */
  techMatch: boolean;
  /** Commits on the default branch that were audited (non-merge). */
  audited: number;
  foreignCommits: number;
  aiCommits: number;
  /** Technologies the repo's code proves (labels). */
  provenTechs: string[];
  provenKeys: string[];
  ownCommits: number;
  share: number;
  activeDays: number;
  srcFiles: number;
  aiTraces: string[];
  /** Claims the code backs (CI / tests / Docker / realtime …). */
  corroborated: SpSignal[];
  homepage: string;
}

export interface SpVerify {
  id: string;
  status: "ok" | "error";
  error: string;
  retryable: boolean;
  retryAfterMs?: number;
  /** The resume reading it proved (its readAt) — a newer reading asks for a new proof. */
  basedOn?: string;
  proofs: SpProjectProof[];
  /** All three DSA platforms (the ones the bar skipped read now) + owner identity. */
  dsa: SpDsa;
  version: number;
  checkedAt: string;
}

// ── Stage 5: trust ───────────────────────────────────────────────────────────

export interface SpTrust {
  id: string;
  /** Does the resume carry the sheet's email / mobile; does its name match the sheet? */
  identity?: AcIdentity | null;
  review: AcTrustReview | null;
  error: string;
  retryable: boolean;
  version: number;
  /** The GitHub proof it reviewed (its checkedAt) — a newer proof asks for a new review. */
  basedOn?: string;
}

// ── Rules (everything switchable / adjustable; re-ranks instantly) ───────────

export interface SpDsaBar {
  codeforces: number;
  codechef: number;
  leetcode: number;
  leetcodeSolved: number;
  /** Rated contests needed on the platform that clears the bar. */
  minContests: number;
}

export interface SpRules {
  dsa: SpDsaBar;
  /** The SDE tab (cross-role): qualified candidates whose DSA also clears this higher bar. */
  sdeBar: SpDsaBar;
  /** A project counts as strong at this quality (after the program's caps). */
  strongProject: number;
  /** …or one exceptional project plus in-role experience. */
  exceptionalProject: number;
  /** GitHub verification thresholds. */
  proof: { minOwnCommits: number; minShare: number; minDays: number; minSrcFiles: number; allowAiTraces: boolean };
  /** Tiers on the profile score. */
  showcaseAt: number;
  strongAt: number;
  topN: number;
  /** List a candidate in every role they qualify for (default: their primary role only). */
  everyRole: boolean;
  trustAgent: boolean;
  /** Company workbook: include GitHub / DSA profile links (they show names). */
  companyLinks: boolean;
  /** Projects / DSA / GitHub engineering: weights of the score; experience: bonus points on top (max). */
  weights: { projects: number; dsa: number; experience: number; engineering: number };
}

export const DEFAULT_SP_RULES: SpRules = {
  dsa: { codeforces: 1500, codechef: 1700, leetcode: 1800, leetcodeSolved: 500, minContests: 3 },
  sdeBar: { codeforces: 1700, codechef: 1900, leetcode: 2000, leetcodeSolved: 700, minContests: 5 },
  strongProject: 75,
  exceptionalProject: 85,
  proof: { minOwnCommits: 10, minShare: 0.5, minDays: 3, minSrcFiles: 10, allowAiTraces: false },
  showcaseAt: 75,
  strongAt: 60,
  topN: 10,
  everyRole: false,
  trustAgent: true,
  companyLinks: true,
  weights: { projects: 50, dsa: 20, experience: 10, engineering: 10 },
};

export function withSpDefaults(r: Partial<SpRules> | undefined): SpRules {
  const d = DEFAULT_SP_RULES;
  return { ...d, ...r, dsa: { ...d.dsa, ...r?.dsa }, sdeBar: { ...d.sdeBar, ...r?.sdeBar }, proof: { ...d.proof, ...r?.proof }, weights: { ...d.weights, ...r?.weights } };
}

/** Everything known about one candidate, one record per candidate (each stage fills its part). */
export interface SpRecord {
  id: string;
  screen?: SpScreen;
  /** DSA read for the bar (a platform at a time, cheapest first). */
  dsa?: SpDsa;
  probe?: SpProbe;
  read?: SpRead;
  verify?: SpVerify;
  trust?: SpTrust;
}

/** Bump a stage's version when it reads differently — older results are re-run from that stage on. */
export const SP_VERSIONS = { screen: 1, read: 2, verify: 1, trust: 1 } as const;

export interface SpRunMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  rules: SpRules;
  /** Candidate ids taken out of the company workbook by hand. */
  rejected: string[];
  /** Resume reads in parallel (the other stages follow from it). */
  concurrency?: number;
  loadedAt: string;
  sheetTitle: string;
  stats: { rows: number; screened: number; dsaPassed: number; read: number; verified: number; showcase: number; strong: number; nearMiss: number; pending: number; roles: number };
}
