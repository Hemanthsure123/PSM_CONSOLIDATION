/**
 * Candidate Bucketing — the single source of truth for buckets, stages, tracks,
 * reason codes, limits and every scoring / trust constant. Client-safe (no I/O):
 * the browser uses the labels and the ranking order, the server uses everything.
 *
 * Tune weights here only — every formula in scoring.ts reads from this file.
 *
 * Signal priority (the user's order): 1) internal assessments (TR-2 verdict, TR-1
 * scores, assessment scores) · 2) projects with verifiable GitHub · 3) experience ·
 * 4) achievements.
 */

export const BUCKETING_PROMPT_VERSION = "bucketing-v2";

// ── Interview stage, track and verdict ───────────────────────────────────────

export const STAGES = ["TR2", "TR1", "ASSESSMENT"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  TR2: "TR-2 cleared",
  TR1: "TR-1 cleared",
  ASSESSMENT: "Assessment cleared",
};

/** TR-2 tracks, as the interview export names them ("TR2 <track> Verdict"). Product has no bucket. */
export const TRACKS = ["MERN", "PYTHON_FS", "JAVA_FS", "GENAI", "DSML", "DATA_ANALYTICS", "PRODUCT"] as const;
export type Track = (typeof TRACKS)[number];

export const TRACK_LABEL: Record<Track, string> = {
  MERN: "MERN",
  PYTHON_FS: "Python Full Stack",
  JAVA_FS: "Java Full Stack",
  GENAI: "GenAI",
  DSML: "DS/ML",
  DATA_ANALYTICS: "Data Analytics",
  PRODUCT: "Product",
};

/** How the interview export names each track in its "TR2 <track> State / Verdict" columns. */
export const EXPORT_TRACK_NAME: Record<Track, string> = {
  DATA_ANALYTICS: "data analytics",
  DSML: "ds&ml",
  GENAI: "gen ai",
  JAVA_FS: "java fullstack",
  MERN: "mern fullstack",
  PRODUCT: "product",
  PYTHON_FS: "python fullstack",
};

/** TR-2 verdicts that count as cleared, best first: strong hire > medium hire > low hire. */
export const TR2_VERDICTS = ["STRONG_HIRE", "MEDIUM_HIRE", "LOW_HIRE"] as const;
export type Tr2Verdict = (typeof TR2_VERDICTS)[number];

export const VERDICT_LABEL: Record<Tr2Verdict, string> = {
  STRONG_HIRE: "Strong hire",
  MEDIUM_HIRE: "Medium hire",
  LOW_HIRE: "Low hire",
};

/** Points a verdict is worth inside the internal-assessment score. */
export const VERDICT_POINTS: Record<Tr2Verdict, number> = { STRONG_HIRE: 100, MEDIUM_HIRE: 85, LOW_HIRE: 70 };

/** "strong_hire", "Strong Hire", "medium hire" … → verdict; "rejected", "no_hire", blanks → null. */
export function normalizeVerdict(raw: string): Tr2Verdict | null {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (!s || /\b(no|not|reject|rejected|fail|failed)\b/.test(s)) return null;
  if (/\bstrong\b.*\bhire\b/.test(s)) return "STRONG_HIRE";
  if (/\b(medium|moderate|mid)\b.*\bhire\b/.test(s)) return "MEDIUM_HIRE";
  if (/\b(low|weak)\b.*\bhire\b/.test(s)) return "LOW_HIRE";
  return null;
}

/** A verdict cell saying the candidate sat that interview and did NOT clear it. */
export function isRejectedVerdict(raw: string): boolean {
  return /\b(reject|rejected|no hire|fail|failed)\b/i.test((raw ?? "").replace(/_/g, " "));
}

/**
 * Ranking and processing order (lower first): TR-2 strong hire 1, medium 2, low 3,
 * TR-1 cleared 4, Assessment cleared 5. Everyone in the export has cleared the
 * assessment; a TR-2 hire has cleared the assessment, TR-1 and TR-2.
 */
export function priorityTier(stage: Stage, verdict: Tr2Verdict | null | undefined): number {
  if (stage === "TR2") return verdict === "STRONG_HIRE" ? 1 : verdict === "MEDIUM_HIRE" ? 2 : 3;
  return stage === "TR1" ? 4 : 5;
}

export const TIERS = [1, 2, 3, 4, 5] as const;

export const TIER_LABEL: Record<number, string> = {
  1: "TR-2 strong hire",
  2: "TR-2 medium hire",
  3: "TR-2 low hire",
  4: "TR-1 cleared",
  5: "Assessment cleared",
};

export const TIER_SHORT: Record<number, string> = { 1: "Strong", 2: "Medium", 3: "Low", 4: "TR-1", 5: "Asmt" };

// ── Buckets (exactly 6 — the TR-2 tracks; a candidate is in at most one) ────

export const BUCKETS = ["MERN", "PYTHON_FS", "JAVA_FS", "GENAI", "DSML", "DATA_ANALYTICS"] as const;
export type Bucket = (typeof BUCKETS)[number];

export const BUCKET_LABEL: Record<Bucket, string> = {
  MERN: "MERN Stack",
  PYTHON_FS: "Python Full Stack",
  JAVA_FS: "Java Full Stack",
  GENAI: "Generative AI",
  DSML: "DS / ML",
  DATA_ANALYTICS: "Data Analytics",
};

export const isBucket = (v: unknown): v is Bucket => typeof v === "string" && (BUCKETS as readonly string[]).includes(v);

/** What a bucket needs to see in a valid project (shown to agents and in the UI). */
export const BUCKET_RULE: Record<Bucket, string> = {
  MERN: "React or Next.js + Node/Express (or Next.js API routes) + MongoDB/Mongoose, proven in a GitHub repo's code",
  PYTHON_FS: "Django / Flask / FastAPI + a frontend (React/Vue/Angular/templates/JS) + a database, proven in a GitHub repo's code",
  JAVA_FS: "Spring Boot / Servlet / JSP backend + a frontend + a database, proven in a GitHub repo's code",
  GENAI:
    "An LLM SDK or framework actually used (OpenAI, Anthropic, Gemini, LangChain, LlamaIndex, HF text-generation, Ollama); RAG / agents / vector DBs add depth. Classic ML alone is not GenAI. GitHub optional: a well-described project counts, a repo or notebook is a bonus.",
  DSML:
    "Machine learning / deep learning actually done (scikit-learn, PyTorch, TensorFlow/Keras, XGBoost, computer vision, NLP models, model evaluation). GitHub optional: most of this lives in Jupyter notebooks, and a notebook on GitHub is a bonus.",
  DATA_ANALYTICS: "Data analysis actually done: Pandas with charts, SQL analysis, or a Power BI / Tableau dashboard, proven in a GitHub repo's code or files",
};

/** Buckets whose projects count without a GitHub link (Jupyter-notebook work). */
export const GITHUB_OPTIONAL: ReadonlySet<Bucket> = new Set<Bucket>(["DSML", "GENAI"]);

/** TR-2 tracks with a bucket of their own — every track except Product. */
export const TRACK_BUCKET: Partial<Record<Track, Bucket>> = {
  MERN: "MERN",
  PYTHON_FS: "PYTHON_FS",
  JAVA_FS: "JAVA_FS",
  GENAI: "GENAI",
  DSML: "DSML",
  DATA_ANALYTICS: "DATA_ANALYTICS",
};

/** Domains scored besides the buckets — "all the domains the candidate fits". */
export const OTHER_DOMAINS = [
  "FRONTEND",
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
  FRONTEND: "Frontend only",
  ANDROID_MOBILE: "Android / Mobile",
  DEVOPS_CLOUD: "DevOps / Cloud",
  QA_TESTING: "QA / Testing",
  BLOCKCHAIN: "Blockchain / Web3",
  IOT_EMBEDDED: "IoT / Embedded",
  CYBERSECURITY: "Cybersecurity",
  GAME_DEV: "Game Development",
  OTHER: "Other",
};

/**
 * The candidate's tag: "MERN TR-2 · Strong hire", "Combined interview · Medium hire",
 * "TR-1 cleared", "Assessment cleared".
 */
export function stageLabel(stage: Stage, track: Track | null, verdict?: Tr2Verdict | null): string {
  if (stage === "TR2") {
    const v = verdict ? ` · ${VERDICT_LABEL[verdict]}` : " cleared";
    return track ? `${TRACK_LABEL[track]} TR-2${v}` : `Combined interview${v}`;
  }
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

/** "mern fullstack", "Python FS", "Java Full Stack", "gen ai", "ds&ml", "data analytics", "product" … → Track. */
export function normalizeTrack(raw: string): Track | null {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!s) return null;
  if (/\bmern\b/.test(s)) return "MERN";
  if (/\b(gen ?ai|generative ai|genai|llm)\b/.test(s)) return "GENAI";
  if (/\b(data analytics|data analyst|da|analytics)\b/.test(s)) return "DATA_ANALYTICS";
  if (/\b(ds ?ml|ds and ml|ai ?ml|ml|machine learning|data science|artificial intelligence)\b/.test(s)) return "DSML";
  if (/\bproduct\b/.test(s)) return "PRODUCT";
  if (/\bpython\b/.test(s)) return "PYTHON_FS";
  if (/\bjava\b/.test(s)) return "JAVA_FS";
  return null;
}

// ── Reason codes ─────────────────────────────────────────────────────────────

export const REASON_CODES = [
  "JOURNEY_CLOSED",
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
  "INTERVIEW_ONLY",
  "INSUFFICIENT_EVIDENCE",
  "LOW_TRUST",
  "GITHUB_UNAVAILABLE",
  "PIPELINE_ERROR",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const REASON_TEXT: Record<ReasonCode, string> = {
  JOURNEY_CLOSED: "Journey closed in the drive (not responding / placed) — not bucketed",
  NO_RESUME_LINK: "No resume link in the sheet",
  NOT_A_RESUME: "The resume link is not a resume",
  RESUME_UNREADABLE: "The resume could not be read",
  NO_PROJECTS: "No projects on the resume",
  NO_GITHUB_LINKED_PROJECT: "No project links a GitHub repository in its own section",
  REPO_NOT_FOUND_OR_PRIVATE: "A project's GitHub repository is missing, private or empty",
  FOREIGN_COMMIT: "A project repository has commits by someone other than the candidate",
  AI_TOOL_COMMIT: "A project repository has commits made by an AI coding tool",
  AI_TOOL_TRACE: "A project repository contains AI coding-tool files",
  NO_BUCKET_FIT: "No verified project or internship fits any of the 6 buckets",
  TRACK_MISMATCH: "Placed by the TR-2 interview, but the resume doesn't show this track yet",
  INTERVIEW_ONLY: "Placed by the TR-2 interview alone — the resume could not be checked",
  INSUFFICIENT_EVIDENCE: "Too little verified evidence to place in a bucket",
  LOW_TRUST: "Verification disagreed — needs manual review",
  GITHUB_UNAVAILABLE: "GitHub could not be checked (rate limit / outage) — re-run",
  PIPELINE_ERROR: "The evaluation failed part-way — re-run",
};

/** Codes that are flags on a bucketed candidate rather than reasons for no bucket. */
export const FLAG_CODES: ReadonlySet<ReasonCode> = new Set(["TRACK_MISMATCH", "INTERVIEW_ONLY", "LOW_TRUST"]);

/** Codes that mean evidence was missing and a re-run can complete the picture. */
export const RERUN_CODES: ReadonlySet<ReasonCode> = new Set(["GITHUB_UNAVAILABLE", "PIPELINE_ERROR"]);

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

/**
 * Overall score — ranking inside a bucket and tier, in the user's priority order:
 * internal assessments, then projects, then experience, then achievements.
 */
export const OVERALL_WEIGHTS = { internal: 0.4, projects: 0.3, experience: 0.2, achievements: 0.1 } as const;

/** Internal-assessment score: how its parts weigh (renormalised over the parts the export has). */
export const INTERNAL = {
  weights: { tr2: 0.5, tr1: 0.3, assessment: 0.2 },
  /** offlineOverallScore = dsaCodingScore (out of 120) + csFundamentalsScore (out of 40). */
  assessmentMax: 160,
  dsaCodingMax: 120,
  csMax: 40,
  /** sqlMcqScore and sqlCodingScore are each out of 15. */
  sqlMax: 15,
  /** tr1OverallTechnicalScore is out of 100; the tr1 ratings are out of 10. */
  tr1Max: 100,
  tr1RatingMax: 10,
  /**
   * With no TR-1 AI-interview scores, the DSA interview's own scores stand for TR-1:
   * dsaInterviewDsaScore (out of 120) and dsaInterviewCsScore (out of 40), weighted like the assessment.
   */
  dsaInterviewDsaMax: 120,
  dsaInterviewCsMax: 40,
  /** For the Data Analytics bucket, SQL takes this share of the assessment part. */
  sqlShareForAnalytics: 0.3,
} as const;

/** Projects score parts (0-100). */
export const PROJECTS = {
  /** First project backing the bucket: verified GitHub (A/B), or demo / resume-described ML-AI (C/R). */
  firstVerified: 50,
  firstUnverified: 35,
  extraProject: 10,
  extraProjectMax: 20,
  demo: 10,
  demoMax: 20,
  /** An ML / AI project with its notebook or code on GitHub. */
  notebookOnGithub: 10,
  weights: { flagship: 0.5, evidence: 0.3, domain: 0.2 },
} as const;

/** Experience score parts (0-100). */
export const EXPERIENCE = {
  inDomainFirst: 60,
  perMonth: 5,
  monthsMax: 30,
  secondInDomain: 10,
  /** Roles in other domains still show work experience. */
  otherRole: 20,
  otherRoleMax: 40,
} as const;

/** Achievements score: points per verified achievement (capped at 100), plus external DSA. */
export const ACHIEVEMENT_POINTS = {
  win: 35,
  rank: 25,
  publication: 30,
  award: 20,
  participation: 10,
  certification: 5,
  other: 10,
  ossMerged: 20,
  /** Share of the Codeforces / CodeChef / LeetCode score that counts as achievement. */
  dsaShare: 0.4,
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
  caps: { auditTruncated: 80, transcribed: 85, verifierFail: 59, tierCBacking: 75, interviewOnly: 75, evidencePending: 70 },
  /** A TR-2 hire in the bucket's own track is an independent confirmation of the bucket. */
  trackConfirmed: 95,
  /** Placed by the TR-2 track but the resume shows nothing for it. */
  trackUnbacked: 80,
  bands: { high: 80, medium: 60 },
} as const;

/** Optional extra LLM read-through of the final record, TR-2 candidates only. */
export const TR2_LLM_AUDIT = false;

// ── Model chains ─────────────────────────────────────────────────────────────

/**
 * Probed 2026-10-14: Gemini free quotas are tiny (3.6-flash and 3-flash-preview answer);
 * OpenAI allows ~50 requests/day/model/key; Mistral has 11 free keys. Gemini first,
 * then OpenAI, then Mistral — the fallback order the user set for screening.
 */
export const DEFAULT_PRODUCER_CHAIN =
  "gemini:gemini-3.6-flash,gemini:gemini-3-flash-preview,gemini:gemini-3.8-flash," +
  "openai:gpt-5.4-mini,mistral:ministral-14b-latest,mistral:codestral-latest";

/** Verifiers lead with a different model than the producers, so no agent grades its own answer. */
export const DEFAULT_VERIFIER_CHAIN =
  "gemini:gemini-3-flash-preview,gemini:gemini-3.6-flash,gemini:gemini-3.8-flash," +
  "mistral:codestral-latest,openai:gpt-5.4-mini,mistral:ministral-14b-latest";
