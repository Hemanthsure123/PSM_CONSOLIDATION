/**
 * Candidate Bucketing — the single source of truth for buckets, stages, tracks,
 * reason codes, limits and every scoring / trust constant. Client-safe (no I/O):
 * the browser uses the labels and the ranking order, the server uses everything.
 *
 * Tune weights here only — every formula in scoring.ts reads from this file.
 */

export const BUCKETING_PROMPT_VERSION = "bucketing-v1";

// ── Interview stage and track ────────────────────────────────────────────────

export const STAGES = ["TR2", "TR1", "ASSESSMENT"] as const;
export type Stage = (typeof STAGES)[number];

/** Processing and ranking priority: TR-2 first. */
export const STAGE_TIER: Record<Stage, 1 | 2 | 3> = { TR2: 1, TR1: 2, ASSESSMENT: 3 };

export const STAGE_LABEL: Record<Stage, string> = {
  TR2: "TR-2 cleared",
  TR1: "TR-1 cleared",
  ASSESSMENT: "Assessment cleared",
};

/** Tracks apply to TR-2 only. */
export const TRACKS = ["MERN", "PYTHON_FS", "JAVA_FS", "GENAI", "AIML", "DATA_ANALYTICS"] as const;
export type Track = (typeof TRACKS)[number];

export const TRACK_LABEL: Record<Track, string> = {
  MERN: "MERN",
  PYTHON_FS: "Python Full Stack",
  JAVA_FS: "Java Full Stack",
  GENAI: "GenAI",
  AIML: "AI-ML",
  DATA_ANALYTICS: "Data Analytics",
};

// ── Buckets (exactly 5; a candidate is in at most one) ──────────────────────

export const BUCKETS = ["MERN", "PYTHON_FS", "JAVA_FS", "GENAI", "FRONTEND"] as const;
export type Bucket = (typeof BUCKETS)[number];

export const BUCKET_LABEL: Record<Bucket, string> = {
  MERN: "MERN Stack",
  PYTHON_FS: "Python Full Stack",
  JAVA_FS: "Java Full Stack",
  GENAI: "Generative AI",
  FRONTEND: "Frontend",
};

/** What a bucket needs to see in ONE valid project's code (shown to agents and in the UI). */
export const BUCKET_RULE: Record<Bucket, string> = {
  MERN: "React or Next.js + Node/Express (or Next.js API routes) + MongoDB/Mongoose",
  PYTHON_FS: "Django / Flask / FastAPI + a frontend (React/Vue/Angular/templates/JS) + a database",
  JAVA_FS: "Spring Boot / Servlet / JSP backend + a frontend + a database",
  GENAI: "An LLM SDK or framework actually called (OpenAI, Anthropic, Gemini, LangChain, LlamaIndex, HF text-generation, Ollama); RAG / agents / vector DBs add depth. Classic ML alone is NOT GenAI.",
  FRONTEND: "React / Vue / Angular / Next / vanilla-JS UI with no backend of its own (BaaS like Firebase allowed). A real backend makes it MERN, not Frontend.",
};

/** TR-2 tracks that have a bucket of their own (AI-ML and Data Analytics do not). */
export const TRACK_BUCKET: Partial<Record<Track, Bucket>> = {
  MERN: "MERN",
  PYTHON_FS: "PYTHON_FS",
  JAVA_FS: "JAVA_FS",
  GENAI: "GENAI",
};

/** Domains scored besides the buckets — "all the domains the candidate fits". */
export const OTHER_DOMAINS = [
  "AIML",
  "DATA_ANALYTICS",
  "ANDROID_MOBILE",
  "DEVOPS_CLOUD",
  "QA_TESTING",
  "BLOCKCHAIN",
  "IOT_EMBEDDED",
  "CYBERSECURITY",
  "GAME_DEV",
  "OTHER",
] as const;
export type OtherDomain = (typeof OTHER_DOMAINS)[number];
export type DomainKey = Bucket | OtherDomain;
export const DOMAIN_KEYS: readonly DomainKey[] = [...BUCKETS, ...OTHER_DOMAINS];

export const DOMAIN_LABEL: Record<DomainKey, string> = {
  ...BUCKET_LABEL,
  AIML: "AI / ML",
  DATA_ANALYTICS: "Data Analytics",
  ANDROID_MOBILE: "Android / Mobile",
  DEVOPS_CLOUD: "DevOps / Cloud",
  QA_TESTING: "QA / Testing",
  BLOCKCHAIN: "Blockchain / Web3",
  IOT_EMBEDDED: "IoT / Embedded",
  CYBERSECURITY: "Cybersecurity",
  GAME_DEV: "Game Development",
  OTHER: "Other",
};

/** "MERN TR-2 cleared" — a TR-2 label always names its track. */
export function stageLabel(stage: Stage, track: Track | null): string {
  if (stage === "TR2") return track ? `${TRACK_LABEL[track]} TR-2 cleared` : "TR-2 cleared (track missing)";
  return STAGE_LABEL[stage];
}

/** "TR2 cleared", "tr-2", "TR 2", "Technical Round 2", "Assessment Cleared" … → Stage. */
export function normalizeStage(raw: string): Stage | null {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!s) return null;
  // The column must hold the highest CLEARED stage — "TR-2 rejected" is not TR-2 cleared.
  if (/\b(reject|rejected|fail|failed|not cleared|not selected|pending|absent|dropped|on hold)\b/.test(s)) return null;
  if (/\b(tr ?2|technical (round|interview) ?(2|two|ii)|round ?2|r2)\b/.test(s)) return "TR2";
  if (/\b(tr ?1|technical (round|interview) ?(1|one|i)|round ?1|r1)\b/.test(s)) return "TR1";
  if (/\b(assessment|assesment|asmt|online test|test cleared|aptitude)\b/.test(s)) return "ASSESSMENT";
  return null;
}

/** "MERN", "Python FS", "Java Full Stack", "Gen AI", "AI/ML", "DA" … → Track. */
export function normalizeTrack(raw: string): Track | null {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!s) return null;
  if (/\bmern\b/.test(s)) return "MERN";
  if (/\b(gen ?ai|generative ai|genai|llm)\b/.test(s)) return "GENAI";
  if (/\b(ai ?ml|ml|machine learning|artificial intelligence|data science)\b/.test(s)) return "AIML";
  if (/\b(data analytics|data analyst|da|analytics)\b/.test(s)) return "DATA_ANALYTICS";
  if (/\bpython\b/.test(s)) return "PYTHON_FS";
  if (/\bjava\b/.test(s)) return "JAVA_FS";
  return null;
}

// ── Reason codes ─────────────────────────────────────────────────────────────

export const REASON_CODES = [
  "NO_RESUME_LINK",
  "NOT_A_RESUME",
  "RESUME_UNREADABLE",
  "NO_PROJECTS",
  "NO_GITHUB_LINKED_PROJECT",
  "REPO_NOT_FOUND_OR_PRIVATE",
  "FOREIGN_COMMIT",
  "AI_TOOL_COMMIT",
  "AI_TOOL_TRACE",
  "NO_BUCKET_FIT",
  "TRACK_MISMATCH",
  "INSUFFICIENT_EVIDENCE",
  "LOW_TRUST",
  "GITHUB_UNAVAILABLE",
  "PIPELINE_ERROR",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const REASON_TEXT: Record<ReasonCode, string> = {
  NO_RESUME_LINK: "No resume link in the sheet",
  NOT_A_RESUME: "The resume link is not a resume",
  RESUME_UNREADABLE: "The resume could not be read",
  NO_PROJECTS: "No projects on the resume",
  NO_GITHUB_LINKED_PROJECT: "No project links a GitHub repository in its own section",
  REPO_NOT_FOUND_OR_PRIVATE: "A project's GitHub repository is missing, private or empty",
  FOREIGN_COMMIT: "A project repository has commits by someone other than the candidate",
  AI_TOOL_COMMIT: "A project repository has commits made by an AI coding tool",
  AI_TOOL_TRACE: "A project repository contains AI coding-tool files",
  NO_BUCKET_FIT: "No verified project or internship fits any of the 5 buckets",
  TRACK_MISMATCH: "The TR-2 track is not backed by the resume (bucket comes from the resume)",
  INSUFFICIENT_EVIDENCE: "Too little verified evidence to place in a bucket",
  LOW_TRUST: "Verification disagreed — needs manual review",
  GITHUB_UNAVAILABLE: "GitHub could not be checked (rate limit / outage) — re-run",
  PIPELINE_ERROR: "The evaluation failed part-way — re-run",
};

/** Codes that are flags on a bucketed candidate rather than reasons for no bucket. */
export const FLAG_CODES: ReadonlySet<ReasonCode> = new Set(["TRACK_MISMATCH", "LOW_TRUST"]);

// ── Limits and timeouts ──────────────────────────────────────────────────────

export const LIMITS = {
  /** Resume projects whose GitHub repos are audited (first ones listed — resumes lead with their best). */
  MAX_PROJECTS_AUDITED: 4,
  /** Repos audited per candidate (a project may pair a frontend and a backend repo). */
  MAX_REPOS_AUDITED: 6,
  /** Commits read per repo; a longer history is marked truncated (trust capped). */
  MAX_COMMITS_AUDITED: 1000,
  /** Hard ceiling on GitHub REST calls for one candidate. */
  GITHUB_CALLS_PER_CANDIDATE: 40,
  /** Demo-only projects whose live link is probed. */
  MAX_DEMO_CHECKS: 4,
  /** Open-source claims verified against GitHub. */
  MAX_OSS_CHECKS: 3,
  /** Resume text sent to a text-only model. */
  MAX_RESUME_CHARS: 24_000,
  /** Revise loops per verifier (producer re-runs with the verifier's feedback). */
  MAX_REVISE_LOOPS: 1,
} as const;

export const TIMEOUTS = {
  /** Whole graph for one candidate (the route's maxDuration is 300 s). */
  candidateMs: 285_000,
  /** One model tier — a slow model is skipped for the next one. */
  llmTierMs: 45_000,
  ingestMs: 150_000,
  domainBranchMs: 140_000,
  projectEvidenceMs: 150_000,
  dsaBranchMs: 90_000,
  bucketingMs: 110_000,
  demoProbeMs: 8_000,
  /** Free tiers that sleep (Render, Streamlit, Heroku, Railway) take a while to wake. */
  demoColdStartMs: 25_000,
} as const;

// ── Scoring constants ───────────────────────────────────────────────────────

/** A technology counts as proven in a repo at or above this confidence (and only with hard evidence). */
export const TECH_CONF = 0.5;

/** Validation score (0-100) — only computed for a validated resume. */
export const VALIDATION = {
  firstProject: 50,
  extraProject: 10,
  extraProjectMax: 20,
  demo: 5,
  demoMax: 10,
  internship: 10,
  internshipBonus: 5,
  internshipBonusMonths: 6,
  oss: 5,
} as const;

/** DSA: Codeforces > CodeChef > LeetCode. */
export const DSA = {
  codeforces: { ratingFloor: 800, ratingSpan: 1200, solvedCap: 400, contestsCap: 30, w: { rating: 0.5, solved: 0.3, contests: 0.2 } },
  codechef: { solvedCap: 400, contestsCap: 30, w: { solved: 0.6, contests: 0.4 } },
  leetcode: { ratingFloor: 1400, ratingSpan: 1000, solvedCap: 600, contestsCap: 30, w: { rating: 0.4, solved: 0.4, contests: 0.2 } },
  platformWeight: { codeforces: 1, codechef: 0.85, leetcode: 0.7 },
  /** Per additional active platform. */
  breadthBonus: 0.05,
  /** Codeforces rating at or above this is rare among students — flag for a manual look. */
  cfOutlier: 2100,
} as const;

/** Overall score — ranking inside a bucket and stage. */
export const OVERALL_WEIGHTS = { domain: 0.4, validation: 0.25, flagship: 0.2, dsa: 0.15 } as const;

/** Domain-score rubric caps by evidence count (enforced by the domain verifier). */
export const DOMAIN_CAPS = {
  /** No evidence item at all. */
  none: 10,
  /** One project and no in-domain internship. */
  single: 69,
  /** 90+ needs ≥2 projects AND an in-domain internship. */
  belowTop: 89,
} as const;

export const JUDGE = {
  /** Analyst vs judge gap (points) above which the two scores are averaged. */
  blendGap: 15,
  /** Primary-domain gap that sends the analyst back for one revision. */
  reviseGap: 20,
} as const;

export const TRUST = {
  verifier: { coverage: 0.6, judge: 0.4 },
  overall: { domain: 0.25, bucket: 0.35, dsa: 0.15, final: 0.25 },
  caps: { auditTruncated: 80, transcribed: 85, verifierFail: 59, tierCBacking: 75 },
  bands: { high: 80, medium: 60 },
} as const;

/** Optional extra LLM read-through of the final record, TR-2 candidates only. */
export const TR2_LLM_AUDIT = false;

// ── Model chains ─────────────────────────────────────────────────────────────

/** Probed 2026-10-13: 3.8-flash, 3.5-flash, 3-flash-preview and 3.1-flash-lite answer on these keys. */
export const DEFAULT_PRODUCER_CHAIN =
  "gemini:gemini-3.8-flash,gemini:gemini-3.5-flash,gemini:gemini-3-flash-preview,gemini:gemini-3.1-flash-lite," +
  "mistral:ministral-14b-latest,mistral:codestral-latest,mistral:ministral-8b-latest";

/** Verifiers lead with a different model than the producers, so no agent grades its own answer. */
export const DEFAULT_VERIFIER_CHAIN =
  "gemini:gemini-3.5-flash,gemini:gemini-3-flash-preview,gemini:gemini-3.8-flash,gemini:gemini-3.1-flash-lite," +
  "mistral:codestral-latest,mistral:ministral-14b-latest";
