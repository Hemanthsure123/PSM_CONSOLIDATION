import "server-only";
import { githubToken, parseGithubUser } from "@/lib/coding-stats";
import type { DomainCommit } from "@/lib/types";

/**
 * Deep GitHub inspection for the domain shortlist.
 *
 * `repoMatchesJd()` in coding-stats.ts can only substring-match JD terms against a
 * repo's NAME / DESCRIPTION / TOPICS / primary LANGUAGE. A repo that actually uses
 * PyTorch or FastAPI almost never says so in its name, so that check misses the real
 * signal and nothing looks at commits at all.
 *
 * This module fixes both halves:
 *
 *  1. WHAT THE REPO ACTUALLY USES — one recursive git-tree call per repo gives every
 *     file path plus its size; the interesting blobs (manifests, entrypoint sources,
 *     Dockerfile, workflows, one notebook, README) are then read through
 *     raw.githubusercontent.com, which costs ZERO REST quota. Dependencies declared in
 *     a manifest (requirements / pyproject / package.json / pom.xml / build.gradle /
 *     pubspec) and modules actually imported in code (Python, JS/TS, Java/Kotlin, Dart,
 *     C#) are graded on an evidence-tier scale, so "torch in requirements.txt" and
 *     "import torch in train.py" are not treated as the same proof, and a README
 *     sentence can never satisfy a mandatory technology. Plain languages (Python,
 *     JavaScript, Java, HTML/CSS …) are "generic": they count toward breadth but never
 *     make a repo domain-relevant on their own when the domain names real frameworks.
 *
 *  2. WHO WROTE THE COMMITS — one commits page per repo is graded against a strict
 *     AI-authorship rubric. Only HARD evidence (a vendor AI bot login, a vendor AI
 *     noreply email, or a line-anchored trailer carrying a vendor AI email) can reach
 *     `high`. Behavioural heuristics (bulk timestamps, single-commit dumps) are capped
 *     at `low` because every one of them has a common innocent explanation, and
 *     ordinary CI automation (dependabot/renovate/github-actions) is counted as
 *     `botAuthored`, never as AI authorship.
 *
 * Everything here is best-effort. Every network call has an AbortController timeout,
 * every failure is caught, and the worst case is a partial result or `null` — this
 * function must never throw and must never hang a report.
 */

// ── Budget & tuning constants ───────────────────────────────────────────────

const TIMEOUT_MS = 8000;
/** The single retry after a timeout / network error gets this long. */
const RETRY_TIMEOUT_MS = 15_000;
const RAW_TIMEOUT_MS = 6000;
const UA = "nxtwave-placement-automation";

/**
 * Repos deep-inspected per candidate. Measured cost is 2 REST calls per repo (tree +
 * commits) plus free raw reads, so 8 repos ≈ 17 REST calls per candidate. At the
 * existing GITHUB_INSPECT_CAP of 80 candidates that is ~1360 calls against the
 * 5000/hr REST budget, leaving ample headroom for retries and the legacy stat path.
 */
export const REPO_ANALYSIS_CAP = 8;

/** Repos considered for ranking before the analysis cap is applied. */
const REPO_SCAN_CAP = 60;

/** Hard ceiling on REST calls for ONE candidate — a runaway profile cannot drain the hour. */
const REST_BUDGET_PER_CANDIDATE = 40;

/** Resume-supplied repos that are not in the owned listing are fetched individually, up to this many. */
const EXTRA_REPO_META_CAP = 3;

/** Blob reads per repo (all free, but each is a round-trip). */
const MAX_BLOBS_PER_REPO = 8;
/** Skip any single blob larger than this — a vendored bundle proves nothing. */
const MAX_BLOB_BYTES = 256 * 1024;
/** Total bytes read per repo (notebooks excluded — see MAX_NOTEBOOK_BYTES). */
const MAX_TOTAL_BLOB_BYTES = 250 * 1024;
/** Notebooks embed their output images, so they get their own, larger cap. */
const MAX_NOTEBOOK_BYTES = 6 * 1024 * 1024;
/** Repos bigger than this (KB) reliably return a truncated tree — skip the tree call. */
const TREE_SKIP_REPO_SIZE_KB = 200_000;

const REPO_CONCURRENCY = 3;
const RAW_CONCURRENCY = 6;

/**
 * Display threshold for a repo's `matchPct`. A repo's RELEVANCE is decided by its
 * evidence (`relevant`), not by this number — see `isRelevant`.
 */
export const RELEVANCE_FLOOR = 40;

/** A technology counts as "hit" for the report at or above this confidence. */
const HIT_CONF = 0.5;

/** Score ceiling for a profile whose only "proof" is topics / README prose. */
const META_ONLY_SCORE_CAP = 30;

/** Generic languages earn at most this share of a domain technology's credit. */
const GENERIC_DISCOUNT = 0.5;

/** Core technologies whose confidences are averaged for the coverage term. */
const COVERAGE_TOP_K = 3;

/**
 * Minimum denominator for the AI share. Below ~20 commits a single agent commit would
 * otherwise read as a 50% share, which is not a stable estimate.
 */
const MIN_SHARE_DENOM = 20;

/** Commits fetched per repo (GitHub silently clamps per_page to 100). */
const COMMITS_PER_REPO = 100;

// ── Public contract ─────────────────────────────────────────────────────────

/**
 * Version of the inspection logic. Part of every cached inspection's key: bump it whenever
 * scoring, the technology catalogue or what is read changes, so no stale result is reused.
 */
export const GITHUB_ANALYSIS_VERSION = "2026-10-18.1";

/** The strongest quotable proof behind one proven technology. */
export interface TechProof {
  tech: string;
  /** Repo the proof comes from (the one that proves the tech best). */
  repo: string;
  repoUrl: string;
  /** Where in the repo, e.g. "code:src/train.py", "manifest:requirements.txt", "tree". */
  source: string;
  /** The literal finding, e.g. "import torch in src/train.py". */
  detail: string;
}

/** A mandatory technology the profile's code does not prove, and why. */
export interface TechGap {
  tech: string;
  /** none = no trace at all; readme-only = only named in README / topics; weak = some code evidence, below the bar. */
  reason: "none" | "readme-only" | "weak";
  /** 0-100 confidence that was reached. */
  confidence: number;
  /** The best (insufficient) finding with its repo, "" when there is none. */
  detail: string;
}

/** The JD split into must-have and nice-to-have technologies (human-readable labels). */
export interface JdTechSpec {
  /** Technologies the JD marks mandatory — each one gates the 100-point ceiling. */
  mandatory: string[];
  /** Technologies the JD mentions as desirable — weighted, never gating. */
  goodToHave: string[];
}

/** One concrete, quotable proof that a repo uses a technology. */
export interface TechEvidence {
  /** The technology label this proves, e.g. "PyTorch". */
  tech: string;
  /** Where it came from, e.g. "code:train.py", "manifest:requirements.txt", "topics". */
  source: string;
  /** The literal matched text, e.g. "import torch" or "torch==2.1.0". */
  detail: string;
}

/** Commit-authorship audit for a single repository. */
export interface CommitAudit {
  /** Commits actually inspected (non-merge commits from the first page). */
  analyzed: number;
  /** HARD evidence only — vendor trailer, AI bot login, or AI vendor noreply email. */
  aiAttributed: number;
  /** analyzed - aiAttributed - botAuthored. */
  humanAuthored: number;
  /** CI / dependabot / renovate etc. This is ordinary automation, NOT AI authorship. */
  botAuthored: number;
  /** 0-1, share of commits landing in dense same-timestamp bursts. Behavioural only. */
  bulkCommitRatio: number;
  /** Whole project appears to have landed in one (or the first) commit. Behavioural only. */
  singleDumpRepo: boolean;
  /** Human-readable evidence lines; each quotes the concrete text that was found. */
  signals: string[];
  /** Rubric-capped label — only hard evidence can reach 'high'. */
  aiLikelihood: "none" | "low" | "medium" | "high";
}

/** One repository scored against the JD by its real contents. */
export interface RepoAnalysis {
  name: string;
  url: string;
  description: string;
  primaryLanguage: string | null;
  stars: number;
  createdAt: string;
  pushedAt: string;
  /** 0-100 JD coverage. A repo missing a mandatory technology can never reach 100. */
  matchPct: number;
  /**
   * The repo's code / manifests / config (not just its README) prove at least one of
   * the domain's core technologies.
   */
  relevant: boolean;
  /** The candidate's newest own commit here (linked account or unlinked email); null = none seen. */
  lastOwnCommit: { date: string; linked: boolean } | null;
  /** Mandatory technologies proven in this repo. */
  mandatoryHit: string[];
  /** Mandatory technologies with no usable evidence in this repo. */
  mandatoryMissing: string[];
  /** Good-to-have technologies proven in this repo. */
  goodToHaveHit: string[];
  /** Quotable proof lines behind the score. */
  evidence: TechEvidence[];
  /** Commit-authorship audit for this repo. */
  commits: CommitAudit;
}

/** Everything the deep inspection learned about one candidate's public GitHub. */
export interface GithubDeepAnalysis {
  username: string;
  /** Repos considered after dropping forks/archived/empty. */
  reposScanned: number;
  /** Repos actually deep-inspected (after the analysis cap). */
  reposAnalyzed: number;
  /** True when the cap dropped repos — the caller logs this, nothing truncates silently. */
  capped: boolean;
  /** Best-evidence roll-up across analyzed repos, 0-100 (0 when the domain names no modelled tech). */
  overallMatchPct: number;
  /** Analyzed repos whose contents prove a core domain technology (`RepoAnalysis.relevant`). */
  matchingCount: number;
  /** False when the domain text named no technology this module can look for. */
  assessable: boolean;
  /** Domain technologies proven by code / manifests / config across the profile, strongest first. */
  provenTechs: string[];
  /** One quotable proof per proven technology, in `provenTechs` order. */
  techEvidence: TechProof[];
  /** Mandatory technologies the code does not prove (empty when none are mandatory or all are proven). */
  mandatoryGaps: TechGap[];
  /** Newest own commit to a domain-relevant repo (null = none found). */
  lastDomainCommit: DomainCommit | null;
  /** "" normally; set when the run stopped early (rate limit / call budget) and the numbers are partial. */
  warning: string;
  /** Repo count per primary language (Jupyter Notebook folded into Python). */
  languages: { lang: string; count: number }[];
  /** Analyzed repos, best match first. */
  topRepos: RepoAnalysis[];
  /** Profile-level commit-authorship roll-up. */
  authenticity: {
    totalCommitsAnalyzed: number;
    aiAttributedCommits: number;
    genuineCommits: number;
    aiLikelihood: "none" | "low" | "medium" | "high";
    /** One factual line for the report — a share and the tools named, never a verdict. */
    summary: string;
    /** Deduped evidence lines, at most 8. */
    signals: string[];
  };
}

/** Why a deep inspection produced no analysis — the caller shows this instead of a silent 0. */
export type GithubFailure = "no-token" | "no-username" | "not-found" | "no-repos" | "auth" | "rate-limited" | "error";

export type GithubDeepResult =
  | { ok: true; analysis: GithubDeepAnalysis }
  | { ok: false; reason: GithubFailure; message: string };

// ── Small utilities ─────────────────────────────────────────────────────────

/**
 * Every network call in this module goes through here so a slow or blocked host can
 * never hang a report. Mirrors coding-stats.ts's fetchWithTimeout (that one is module
 * private) but additionally lets callers pick the timeout per call class.
 */
async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, cache: "no-store", signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded-concurrency map. Keeps us well under GitHub's secondary-rate-limit ceiling. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const clamp100 = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/** PEP 503 canonical form — `Scikit_Learn`, `scikit.learn` and `SCIKIT-LEARN` all collapse. */
function canon(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, "-");
}

/** Escape a JD term so it can be embedded in a word-boundary regex. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Truncate a quoted evidence fragment so a report line stays readable. */
function snippet(s: string, max = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// ── REST budget & rate-limit awareness ──────────────────────────────────────

/**
 * Per-candidate call budget. `stop` latches the moment GitHub says we are out of
 * quota (429, secondary-limit 403, or x-ratelimit-remaining 0) so the rest of the run
 * degrades to "return what we have" instead of hammering a closed door.
 */
interface CallBudget {
  restLeft: number;
  stop: boolean;
  /** Why we stopped, for the console warning. "" while healthy. */
  reason: string;
}

interface GhResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
}

/** Authenticated REST GET with budget accounting and rate-limit latching. */
async function ghGet<T>(url: string, token: string, budget: CallBudget): Promise<GhResult<T>> {
  if (budget.stop || budget.restLeft <= 0) {
    if (!budget.stop) {
      budget.stop = true;
      budget.reason = "per-candidate REST budget exhausted";
    }
    return { ok: false, status: 0, data: null };
  }
  budget.restLeft -= 1;
  try {
    const init: RequestInit = {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": UA,
      },
    };
    // One retry, with more time, on a timeout / network error: the first burst of a
    // batch can stall on cold connections, and a dropped call would read as "no repos".
    let res: Response;
    try {
      res = await fetchWithTimeout(url, init);
    } catch {
      res = await fetchWithTimeout(url, init, RETRY_TIMEOUT_MS);
    }

    // Trust the server's counter over our own — it also accounts for other callers.
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    if (Number.isFinite(remaining) && remaining <= 1) {
      budget.stop = true;
      budget.reason = `github rate limit exhausted (resets at ${res.headers.get("x-ratelimit-reset") ?? "?"})`;
    }
    if (res.status === 429 || (res.status === 403 && (remaining === 0 || res.headers.get("retry-after")))) {
      budget.stop = true;
      budget.reason = `github throttled (HTTP ${res.status})`;
      return { ok: false, status: res.status, data: null };
    }
    // 404 = missing/private, 409 = empty repo. Both are "no signal", never retried.
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, status: res.status, data: (await res.json()) as T };
  } catch (err) {
    console.warn("[github-analysis] rest failed:", err instanceof Error ? err.message : err);
    return { ok: false, status: 0, data: null };
  }
}

/**
 * Raw blob read. Unauthenticated first — verified to cost ZERO REST quota, which is
 * what makes per-file dependency proof affordable. Only when GitHub throttles the
 * anonymous read (429 / 403 — a big batch can trip the per-IP limit) is it retried
 * once with the PAT; raw.githubusercontent.com is GitHub's own host. Private files
 * simply 404, which is correct — we only ever screen public work. Any other non-200
 * is "no signal", never an error.
 */
async function rawFile(owner: string, repo: string, path: string, token: string): Promise<string | null> {
  const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/HEAD/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  try {
    let res = await fetchWithTimeout(url, { headers: { "User-Agent": UA } }, RAW_TIMEOUT_MS);
    if (res.status === 429 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      res = await fetchWithTimeout(url, { headers: { "User-Agent": UA, Authorization: `Bearer ${token}` } }, RAW_TIMEOUT_MS);
    }
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null; // best-effort: a missing blob is simply no evidence
  }
}

// ── GitHub payload shapes (only the fields we read) ─────────────────────────

interface GhRepoMeta {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  topics?: string[];
  fork: boolean;
  archived?: boolean;
  size?: number;
  stargazers_count?: number;
  created_at?: string;
  pushed_at?: string;
  owner?: { login?: string };
}

interface GhTreeEntry {
  path: string;
  type: string;
  size?: number;
}

interface GhTree {
  tree?: GhTreeEntry[];
  truncated?: boolean;
}

interface GhGitIdentity {
  name?: string;
  email?: string;
  date?: string;
}

interface GhAccount {
  login?: string;
  type?: string;
}

interface GhCommitItem {
  sha: string;
  commit?: {
    message?: string;
    author?: GhGitIdentity | null;
    committer?: GhGitIdentity | null;
  };
  author?: GhAccount | null;
  committer?: GhAccount | null;
  parents?: { sha: string }[];
}

// ── Technology catalogue ────────────────────────────────────────────────────

/**
 * Evidence families. Confidence is `maxTierWeight + 0.15 per EXTRA family`, so a tech
 * proven by a manifest AND an import AND a Dockerfile outranks one proven three times
 * over by the same kind of source.
 */
type Family = "manifest" | "code" | "infra" | "artifact" | "meta";

interface TechDef {
  /** Stable internal id. */
  key: string;
  /** Human label — this is what appears in JdTechSpec and in the report. */
  label: string;
  /** JD wording that should resolve to this tech. */
  aliases: string[];
  /**
   * Names that are everyday words in lower case ("go", "swift", "c"). They never match as
   * plain wording — only as a list item of their own ("Java, Go, Python", "C / C++") or,
   * two letters and longer, capitalised inside a sentence ("backend services in Go").
   */
  wordNames?: string[];
  /**
   * Path evidence ignores a cross-platform app's generated platform shells (Flutter / React
   * Native ios/, macos/, linux/, windows/ … — see appShellTest): every Flutter app has an
   * AppDelegate.swift and a CMakeLists.txt there, neither written by the candidate.
   */
  ignoreAppShells?: boolean;
  /** Good-to-have weight (mandatory slots ignore it). */
  weight: number;
  /**
   * A plain language (Python, JavaScript, Java, HTML/CSS …). Counts toward breadth, but
   * alone never makes a repo domain-relevant while the domain names real frameworks —
   * otherwise every Python repo is an "AI/ML project".
   */
  generic?: boolean;
  /** GitHub primary languages typical of this tech — only used to pick which repos to deep-inspect. */
  langs?: string[];
  /** Exact PEP-503-canonical distribution names. Never substring-matched. */
  dists?: string[];
  /** Packages that merely depend on the tech — capped at 0.60 unless real usage shows up. */
  derived?: string[];
  /** Top-level import modules (`import X` / `from X import ...`). */
  modules?: string[];
  /** Call sites that prove the library is actually exercised. */
  calls?: RegExp[];
  /** Patterns matched against Dockerfile / compose / workflow / Procfile CONTENT. */
  infraText?: RegExp[];
  /** Tree paths whose mere presence is the proof (Docker, CI). */
  infraPaths?: RegExp[];
  /** Tree paths that are artifacts of the tech (checkpoints, .pbix, .sql). */
  artifactPaths?: RegExp[];
  /** Artifact paths so unambiguous they are worth 0.90 (the only possible proof for BI tools). */
  strongArtifactPaths?: RegExp[];
  /** Keywords looked for in topics / description / README. Capped at 0.45 on their own. */
  meta?: string[];
}

/** Evidence-tier weights, straight from the scoring design. */
const W_CODE = 1.0;
const W_MANIFEST = 0.7;
const W_MANIFEST_LOW_TRUST = 0.25;
const W_INFRA_PROOF = 0.85;
const W_INFRA_CORROBORATION = 0.5;
const W_ARTIFACT = 0.5;
const W_ARTIFACT_STRONG = 0.9;
const W_META_TOPIC = 0.45;
const W_META_TEXT = 0.3;
const CAP_DERIVATIVE = 0.6;
const CAP_META_ONLY = 0.45;
/** Substance floor: a repo with almost no code cannot ride on its manifest. */
const CAP_THIN_REPO_MANIFEST = 0.35;

const TECHS: TechDef[] = [
  {
    key: "python",
    label: "Python",
    aliases: ["python", "python3", "py"],
    weight: 1,
    generic: true,
    langs: ["Python", "Jupyter Notebook"],
    dists: [],
    modules: [],
    artifactPaths: [/\.py$/i, /\.ipynb$/i],
    infraText: [/FROM\s+python:/i, /FROM\s+pytorch\/pytorch/i, /FROM\s+tensorflow\/tensorflow/i, /FROM\s+continuumio\/miniconda3/i, /actions\/setup-python/i],
    meta: ["python"],
  },
  {
    key: "pytorch",
    label: "PyTorch",
    aliases: ["pytorch", "torch", "libtorch"],
    weight: 1,
    dists: ["torch", "torchvision", "torchaudio", "torchtext", "pytorch-cuda"],
    derived: ["pytorch-lightning", "lightning", "torchmetrics", "timm", "torch-geometric", "fastai", "detectron2", "ultralytics", "segmentation-models-pytorch", "kornia"],
    modules: ["torch", "torchvision", "torchaudio"],
    calls: [/\btorch\.(?:nn|optim|no_grad|cuda|tensor|load|save)\b/, /\bnn\.Module\b/, /\bDataLoader\s*\(/, /\bstate_dict\s*\(/],
    infraText: [/FROM\s+pytorch\/pytorch/i, /FROM\s+nvidia\/cuda/i, /pip\s+install\s+torch/i],
    artifactPaths: [/\.(?:pt|pth|safetensors)$/i, /(?:^|\/)checkpoints\//i, /(?:^|\/)lightning_logs\//i],
    meta: ["pytorch"],
  },
  {
    key: "scikit-learn",
    label: "Scikit-learn",
    aliases: ["scikit-learn", "scikit learn", "sklearn", "scikitlearn"],
    weight: 1,
    dists: ["scikit-learn", "sklearn"],
    derived: ["sklearn-crfsuite", "scikit-optimize", "imbalanced-learn", "yellowbrick", "mlxtend"],
    modules: ["sklearn"],
    calls: [
      /\btrain_test_split\s*\(/,
      /\bPipeline\s*\(/,
      /\bColumnTransformer\s*\(/,
      /\bStandardScaler\s*\(/,
      /\bRandomForest[A-Za-z]*\s*\(/,
      /\bLogisticRegression\s*\(/,
      /\bGridSearchCV\s*\(/,
      /\bcross_val_score\s*\(/,
      /\bTfidfVectorizer\s*\(/,
    ],
    artifactPaths: [/\.(?:pkl|joblib)$/i],
    meta: ["scikit-learn", "sklearn", "machine learning"],
  },
  {
    key: "transformers",
    label: "Transformers",
    // Not "attention": "attention to detail" is in half the QA briefs.
    aliases: ["transformer", "transformers", "transformer-based models", "bert"],
    weight: 1,
    dists: ["transformers", "sentence-transformers", "tokenizers", "adapter-transformers", "optimum"],
    derived: ["timm", "vllm"],
    modules: ["transformers", "sentence_transformers"],
    calls: [
      /\bAutoModel(?:For[A-Za-z]+)?\b/,
      /\bAutoTokenizer\b/,
      /\bfrom_pretrained\s*\(/,
      /\b(?:Bert|Roberta|DistilBert|ViT|T5|GPT2)[A-Za-z]*(?:Model|For[A-Za-z]+)\b/,
      /\bTrainingArguments\s*\(/,
      /\bpipeline\s*\(\s*["']/,
      /\bnn\.(?:TransformerEncoder|MultiheadAttention)\b/,
    ],
    artifactPaths: [/(?:^|\/)tokenizer\.json$/i, /(?:^|\/)special_tokens_map\.json$/i, /(?:^|\/)pytorch_model\.bin$/i],
    meta: ["transformers", "bert", "huggingface", "nlp-transformers"],
  },
  {
    key: "fastapi-or-flask",
    label: "FastAPI/Flask",
    // Generic "REST API" wording resolves to the language-neutral "rest-api" tech instead.
    aliases: ["fastapi", "flask", "fast api"],
    weight: 1,
    dists: ["fastapi", "flask"],
    derived: ["starlette", "uvicorn", "fastapi-users", "sqlmodel", "flask-cors", "flask-sqlalchemy", "flask-login", "flask-restful", "flask-wtf", "quart", "gunicorn"],
    modules: ["fastapi", "flask"],
    calls: [
      /\bFastAPI\s*\(/,
      /\bAPIRouter\s*\(/,
      /@app\.(?:get|post|put|delete|patch)\s*\(/,
      /\bDepends\s*\(/,
      /\buvicorn\.run\s*\(/,
      /\bFlask\s*\(\s*__name__/,
      /@app\.route\s*\(/,
      /\bBlueprint\s*\(/,
      /\brender_template\s*\(/,
      /\bjsonify\s*\(/,
    ],
    infraText: [/uvicorn\s+[\w.]+:app/i, /gunicorn\s+[\w.]+:app/i, /flask\s+run/i, /EXPOSE\s+(?:8000|5000)/i],
    artifactPaths: [/(?:^|\/)wsgi\.py$/i, /(?:^|\/)templates\//i],
    meta: ["fastapi", "flask"],
  },

  // ── good-to-have (weights from the JD design: 1.0 / 0.8 / 0.6 / 0.4) ──
  {
    key: "llm",
    label: "LLMs",
    aliases: [
      "llm", "llms", "large language model", "large language models", "gpt", "genai", "gen ai", "generative ai", "rag",
      "prompt engineering", "langchain", "llamaindex", "llama index", "vector database", "vector databases", "vector db",
      "embeddings", "ai agents", "agentic ai", "langgraph", "ai agent", "openai", "gemini", "claude", "llama", "mistral",
    ],
    weight: 1,
    dists: [
      "openai", "anthropic", "langchain", "langchain-core", "langchain-community", "langchain-openai", "langgraph", "llama-index",
      "vllm", "ollama", "groq", "mistralai", "google-generativeai", "google-genai", "cohere", "litellm", "llama-cpp-python",
      "guidance", "instructor", "crewai", "pyautogen", "chromadb", "faiss-cpu", "faiss-gpu", "pinecone", "pinecone-client",
      "qdrant-client", "@langchain/core", "@langchain/openai", "@google/generative-ai", "@google/genai", "ai",
    ],
    modules: [
      "openai", "anthropic", "langchain", "langchain_core", "langchain_community", "langgraph", "llama_index", "litellm",
      "ollama", "groq", "cohere", "crewai", "chromadb", "faiss", "pinecone", "qdrant_client", "@langchain/core",
      "@google/generative-ai", "@google/genai",
    ],
    calls: [/\bAutoModelForCausalLM\b/, /\bChatOpenAI\s*\(/, /chat\.completions\.create\s*\(/, /\bChatPromptTemplate\b/, /["']role["']\s*:\s*["'](?:system|user|assistant)["']/],
    artifactPaths: [/\.gguf$/i],
    meta: ["llm", "rag", "chatbot", "gpt", "generative-ai"],
  },
  {
    key: "llm-finetuning",
    label: "LLM fine-tuning",
    aliases: ["fine-tuning", "fine tuning", "finetuning", "lora", "peft", "sft", "instruction tuning"],
    weight: 1,
    dists: ["peft", "trl", "bitsandbytes", "unsloth", "axolotl", "deepspeed"],
    derived: ["accelerate"],
    modules: ["peft", "trl", "unsloth", "deepspeed"],
    calls: [/\bLoraConfig\s*\(/, /\bget_peft_model\s*\(/, /\bSFTTrainer\s*\(/, /\bDPOTrainer\s*\(/, /\bprepare_model_for_kbit_training\s*\(/, /load_in_4bit\s*=\s*True/],
    artifactPaths: [/(?:^|\/)adapter_config\.json$/i, /(?:^|\/)adapter_model\.safetensors$/i],
    meta: ["fine-tuning", "lora", "peft"],
  },
  {
    key: "llm-inference",
    label: "LLM inference",
    aliases: ["inference", "llm inference", "model serving", "quantization"],
    weight: 1,
    dists: ["vllm", "llama-cpp-python", "text-generation-inference", "ctransformers", "bentoml", "onnxruntime", "optimum"],
    modules: ["vllm", "llama_cpp", "ctransformers", "bentoml", "onnxruntime"],
    calls: [/\bSamplingParams\s*\(/, /\bLLM\s*\(\s*model\s*=/, /max_new_tokens\s*=/, /pipeline\s*\(\s*["']text-generation["']/],
    infraText: [/FROM\s+vllm\/vllm-openai/i, /--tensor-parallel-size/i],
    artifactPaths: [/\.(?:gguf|onnx)$/i],
    meta: ["inference", "vllm", "quantization"],
  },
  {
    key: "huggingface",
    label: "Hugging Face",
    aliases: ["hugging face", "huggingface", "hf", "hf hub"],
    weight: 1,
    dists: ["transformers", "datasets", "huggingface-hub", "accelerate", "diffusers", "evaluate", "tokenizers", "peft", "trl", "gradio"],
    modules: ["transformers", "datasets", "huggingface_hub", "diffusers", "gradio"],
    calls: [/\bfrom_pretrained\s*\(/, /\bpush_to_hub\s*\(/, /\bhf_hub_download\s*\(/, /\bload_dataset\s*\(/],
    meta: ["huggingface", "hugging face", "huggingface.co"],
  },
  {
    key: "healthcare-ai",
    label: "Healthcare AI",
    aliases: ["healthcare", "medical", "clinical", "health ai", "biomedical", "radiology"],
    weight: 1,
    dists: ["pydicom", "nibabel", "monai", "simpleitk", "medpy", "highdicom", "medmnist", "fhirclient"],
    modules: ["pydicom", "nibabel", "monai", "SimpleITK", "medpy"],
    artifactPaths: [/\.(?:dcm|nii)(?:\.gz)?$/i],
    meta: ["healthcare", "medical", "clinical", "dicom", "ehr", "fhir", "hl7", "ecg", "eeg", "radiology", "pneumonia", "retinopathy", "mimic", "chexpert", "brats", "ham10000", "ptb-xl"],
  },
  {
    key: "docker",
    label: "Docker",
    aliases: ["docker", "containerization", "containers"],
    weight: 0.8,
    infraPaths: [/(?:^|\/)Dockerfile[^/]*$/i, /(?:^|\/)docker-compose[^/]*\.ya?ml$/i],
    artifactPaths: [/(?:^|\/)\.dockerignore$/i],
    infraText: [/docker\/build-push-action/i],
    meta: ["docker", "container"],
  },
  {
    key: "nlp",
    label: "NLP / text processing",
    aliases: ["nlp", "natural language processing", "text processing", "text analytics", "text mining"],
    weight: 0.8,
    dists: ["nltk", "spacy", "gensim", "textblob", "tokenizers", "sentencepiece", "rapidfuzz", "sacrebleu", "flair", "stanza", "ftfy"],
    modules: ["nltk", "spacy", "gensim", "textblob", "flair", "stanza"],
    calls: [/\bTfidfVectorizer\s*\(/, /\bCountVectorizer\s*\(/, /\bword_tokenize\s*\(/, /\bstopwords\b/, /\bWordNetLemmatizer\s*\(/],
    meta: ["nlp", "text-classification", "ner", "sentiment-analysis"],
  },
  {
    key: "model-evaluation",
    label: "Model evaluation & error analysis",
    // Not bare "evaluation" / "metrics": QA and analytics briefs use both words.
    aliases: ["model evaluation", "error analysis", "experiment tracking", "mlflow", "wandb"],
    weight: 0.8,
    dists: ["mlflow", "wandb", "tensorboard", "optuna", "shap", "lime", "torchmetrics", "evaluate", "yellowbrick"],
    modules: ["mlflow", "wandb", "shap", "lime", "optuna", "torchmetrics"],
    calls: [
      /sklearn\.metrics\s+import\s+[^\n]*\b(?:classification_report|confusion_matrix|roc_auc_score|f1_score|precision_recall_curve)\b/,
      /\bcross_val_score\s*\(/,
      /\bGridSearchCV\s*\(/,
      /\bStratifiedKFold\s*\(/,
      /\bconfusion_matrix\s*\(/,
      /shap\.summary_plot\s*\(/,
    ],
    artifactPaths: [/(?:^|\/)mlruns\//i, /(?:^|\/)wandb\//i],
    meta: ["evaluation", "metrics", "mlflow"],
  },
  {
    key: "image-analysis",
    label: "Image analysis / classification",
    aliases: ["computer vision", "cv", "image analysis", "image classification", "object detection", "opencv", "image processing"],
    weight: 0.8,
    dists: ["opencv-python", "opencv-python-headless", "opencv-contrib-python", "torchvision", "albumentations", "timm", "ultralytics", "mmcv", "detectron2", "kornia", "scikit-image", "imgaug", "segmentation-models-pytorch", "easyocr", "pytesseract"],
    // Not Pillow / Image.open: every web app that resizes an avatar uses them.
    modules: ["cv2", "torchvision", "albumentations", "timm", "ultralytics", "skimage", "easyocr", "pytesseract"],
    calls: [/\bcv2\.imread\s*\(/, /\bImageFolder\s*\(/, /\btransforms\.Compose\s*\(/, /\bConv2D\s*\(/, /\bImageDataGenerator\s*\(/, /\bYOLO\s*\(/],
    meta: ["computer-vision", "image-classification", "object-detection", "opencv"],
  },
  {
    key: "sql",
    label: "SQL",
    aliases: ["sql", "postgres", "postgresql", "mysql", "database", "databases", "rdbms", "dbms", "sqlite", "oracle", "jdbc"],
    weight: 0.6,
    dists: [
      "sqlalchemy", "psycopg2-binary", "psycopg2", "pymysql", "mysql-connector-python", "duckdb", "snowflake-connector-python",
      "google-cloud-bigquery", "alembic", "sqlmodel", "asyncpg", "pyodbc", "mysql2", "mysql", "pg", "sqlite3", "better-sqlite3",
      "sequelize", "prisma", "@prisma/client", "knex", "typeorm", "mysql-connector-java", "mysql-connector-j", "postgresql",
      "spring-boot-starter-data-jpa", "spring-boot-starter-jdbc", "hibernate-core", "sqflite",
    ],
    modules: ["sqlalchemy", "psycopg2", "pymysql", "duckdb", "asyncpg", "pyodbc", "sqlite3", "mysql2", "pg", "sequelize", "@prisma/client", "java.sql", "jakarta.persistence", "javax.persistence"],
    calls: [/pd\.read_sql\s*\(/, /\.execute\s*\(\s*["'`]\s*SELECT/i, /\bcreate_engine\s*\(/, /\btext\s*\(\s*["'`]\s*SELECT/i],
    artifactPaths: [/\.sql$/i, /(?:^|\/)alembic\/versions\//i, /\.(?:db|sqlite3?)$/i],
    infraText: [/image:\s*(?:postgres|mysql|mssql|mariadb)/i],
    meta: ["sql", "postgresql", "mysql", "database"],
  },
  {
    key: "cicd",
    label: "CI/CD",
    aliases: ["ci/cd", "cicd", "ci cd", "continuous integration", "continuous deployment", "github actions", "jenkins", "devops"],
    weight: 0.6,
    infraPaths: [/^\.github\/workflows\/[^/]+\.ya?ml$/i, /^\.gitlab-ci\.yml$/i, /(?:^|\/)Jenkinsfile$/i, /^\.circleci\/config\.yml$/i, /^azure-pipelines\.yml$/i, /^\.travis\.yml$/i],
    artifactPaths: [/^\.pre-commit-config\.yaml$/i],
    meta: ["ci-cd", "github-actions", "devops"],
  },
  {
    key: "cloud",
    label: "Cloud platforms",
    aliases: ["cloud", "aws", "azure", "gcp", "google cloud", "sagemaker", "deployment"],
    weight: 0.6,
    dists: ["boto3", "awscli", "sagemaker", "google-cloud-storage", "google-cloud-aiplatform", "azure-identity", "azure-storage-blob", "modal", "runpod"],
    modules: ["boto3", "sagemaker", "modal", "runpod"],
    calls: [/\bboto3\.client\s*\(/, /\bstorage\.Client\s*\(/, /\bBlobServiceClient\s*\(/],
    infraPaths: [/^serverless\.yml$/i, /\.tf$/i, /^template\.yaml$/i, /^Procfile$/i, /^app\.yaml$/i, /^render\.yaml$/i, /^railway\.json$/i, /^fly\.toml$/i, /^vercel\.json$/i],
    infraText: [/aws-actions\/configure-aws-credentials/i, /google-github-actions\//i, /azure\/login/i],
    meta: ["aws", "azure", "gcp", "cloud", "deployment"],
  },
  {
    key: "tensorflow",
    label: "TensorFlow",
    aliases: ["tensorflow", "tf", "keras"],
    weight: 0.6,
    dists: ["tensorflow", "tensorflow-cpu", "tensorflow-gpu", "tensorflow-macos", "tf-nightly", "tf-keras", "tensorflow-hub", "tensorflow-datasets"],
    derived: ["keras"],
    modules: ["tensorflow"],
    calls: [/import\s+tensorflow\s+as\s+tf/, /from\s+tensorflow\.keras\s+import/, /\btf\.data\.Dataset\b/, /\bmodel\.compile\s*\(/, /\bSequential\s*\(\s*\[/],
    infraText: [/FROM\s+tensorflow\/tensorflow/i],
    artifactPaths: [/\.(?:h5|keras|tflite)$/i, /(?:^|\/)saved_model\.pb$/i],
    meta: ["tensorflow", "keras"],
  },
  {
    key: "time-series",
    label: "Time-series forecasting",
    aliases: ["time series", "time-series", "forecasting", "arima", "prophet"],
    weight: 0.6,
    dists: ["statsmodels", "prophet", "fbprophet", "pmdarima", "sktime", "darts", "neuralprophet", "tsfresh", "gluonts", "pytorch-forecasting"],
    modules: ["statsmodels", "prophet", "pmdarima", "sktime", "darts", "tsfresh", "gluonts"],
    calls: [/\bARIMA\s*\(/, /\bSARIMAX\s*\(/, /\bseasonal_decompose\s*\(/, /\bProphet\s*\(/, /\bauto_arima\s*\(/, /\badfuller\s*\(/, /\bTimeSeriesSplit\s*\(/],
    meta: ["time-series", "forecasting"],
  },
  {
    key: "powerbi",
    label: "Power BI",
    aliases: ["power bi", "powerbi", "dax", "power query"],
    weight: 0.4,
    strongArtifactPaths: [/\.(?:pbix|pbit|dax)$/i],
    artifactPaths: [/(?:^|\/)power-?bi\//i],
    meta: ["power bi", "powerbi", "dax", "power query"],
  },
  {
    key: "tableau",
    label: "Tableau",
    aliases: ["tableau"],
    weight: 0.4,
    dists: ["tableauserverclient", "tableauhyperapi"],
    strongArtifactPaths: [/\.(?:twb|twbx|hyper)$/i],
    artifactPaths: [/(?:^|\/)tableau\//i],
    meta: ["tableau", "public.tableau.com"],
  },

  // ── general tail: keeps the module useful for non-ML JDs ──
  {
    key: "pandas",
    label: "Pandas / data wrangling",
    aliases: [
      "pandas", "numpy", "data analysis", "data analytics", "data analyst", "data wrangling", "data cleaning",
      "exploratory data analysis", "eda", "etl",
    ],
    weight: 0.6,
    langs: ["Python", "Jupyter Notebook"],
    dists: ["pandas", "polars", "numpy"],
    modules: ["pandas", "polars", "numpy"],
    calls: [/pd\.(?:read_csv|DataFrame|merge|concat)\s*\(/, /np\.(?:array|zeros|mean)\s*\(/],
    meta: ["pandas", "data-analysis"],
  },
  {
    key: "react",
    label: "React",
    aliases: ["react", "reactjs", "react.js", "next.js", "nextjs", "frontend", "front end", "front-end", "redux", "mern"],
    weight: 0.6,
    langs: ["JavaScript", "TypeScript"],
    dists: ["react", "next", "react-dom", "react-scripts", "react-native"],
    derived: ["@reduxjs/toolkit", "redux", "react-router-dom", "@vitejs/plugin-react"],
    modules: ["react", "react-dom", "next", "react-native"],
    calls: [/\buse(?:State|Effect|Context|Reducer|Ref|Memo)\s*\(/, /\bcreateRoot\s*\(/, /\bReactDOM\.render\s*\(/],
    infraPaths: [/(?:^|\/)next\.config\.[a-z]+$/i],
    artifactPaths: [/\.jsx$/i],
    meta: ["react", "nextjs", "frontend"],
  },
  {
    key: "nodejs",
    label: "Node.js / Express",
    // Not "backend": a Java or Python backend brief must not demand Node.
    aliases: ["node", "nodejs", "node.js", "express", "expressjs", "express.js", "nestjs", "mern"],
    weight: 0.6,
    langs: ["JavaScript", "TypeScript"],
    dists: ["express", "fastify", "@nestjs/core", "koa", "hapi", "@hapi/hapi"],
    derived: ["nodemon", "cors", "body-parser", "jsonwebtoken", "socket.io"],
    modules: ["express", "fastify", "@nestjs/core", "koa", "http", "socket.io"],
    calls: [/\bexpress\s*\(\s*\)/, /\bapp\.listen\s*\(/, /\brouter\.(?:get|post|put|delete|patch)\s*\(/],
    artifactPaths: [/(?:^|\/)server\.(?:js|ts|mjs)$/i],
    meta: ["nodejs", "express"],
  },
  {
    key: "typescript",
    label: "TypeScript",
    aliases: ["typescript", "ts"],
    weight: 0.6,
    generic: true,
    langs: ["TypeScript"],
    dists: ["typescript"],
    artifactPaths: [/\.tsx?$/i, /(?:^|\/)tsconfig\.json$/i],
    meta: ["typescript"],
  },
  {
    key: "django",
    label: "Django",
    aliases: ["django", "drf", "django rest framework"],
    weight: 0.6,
    dists: ["django", "djangorestframework"],
    modules: ["django", "rest_framework"],
    infraPaths: [/(?:^|\/)manage\.py$/i],
    artifactPaths: [/(?:^|\/)migrations\//i],
    meta: ["django"],
  },
  {
    key: "kubernetes",
    label: "Kubernetes",
    aliases: ["kubernetes", "k8s", "helm", "eks", "gke"],
    weight: 0.6,
    infraPaths: [/(?:^|\/)k8s\//i, /(?:^|\/)helm\//i, /(?:^|\/)Chart\.yaml$/i],
    infraText: [/apiVersion:\s*apps\/v1/i, /kind:\s*Deployment/i],
    meta: ["kubernetes", "k8s", "helm"],
  },
  {
    key: "spark",
    label: "Spark / big data",
    aliases: ["spark", "pyspark", "hadoop", "big data", "databricks"],
    weight: 0.6,
    dists: ["pyspark", "delta-spark", "databricks-sql-connector"],
    modules: ["pyspark"],
    calls: [/\bSparkSession\b/, /spark\.read\./],
    meta: ["spark", "pyspark", "databricks"],
  },
  {
    key: "mongodb",
    label: "MongoDB",
    aliases: ["mongodb", "mongo", "mongoose", "nosql", "mern"],
    weight: 0.6,
    dists: ["pymongo", "motor", "mongoengine", "mongoose", "mongodb", "spring-boot-starter-data-mongodb"],
    modules: ["pymongo", "motor", "mongoengine", "mongoose", "mongodb"],
    calls: [/\bmongoose\.(?:connect|Schema|model)\s*\(/, /\bnew\s+MongoClient\s*\(/, /\bMongoClient\s*\(/],
    infraText: [/image:\s*mongo/i],
    meta: ["mongodb", "nosql"],
  },

  // ── plain languages: breadth only, never domain proof on their own ──
  {
    key: "javascript",
    label: "JavaScript",
    aliases: ["javascript", "js", "es6", "ecmascript", "vanilla javascript", "vanilla js"],
    weight: 0.6,
    generic: true,
    langs: ["JavaScript"],
    artifactPaths: [/\.(?:js|jsx|mjs|cjs)$/i],
    meta: ["javascript"],
  },
  {
    key: "html-css",
    label: "HTML/CSS",
    aliases: ["html", "html5", "css", "css3", "responsive design", "responsive web design", "tailwind", "tailwindcss", "bootstrap", "sass", "scss"],
    weight: 0.4,
    generic: true,
    langs: ["HTML", "CSS", "SCSS"],
    dists: ["tailwindcss", "bootstrap", "sass", "styled-components", "@mui/material"],
    artifactPaths: [/\.html?$/i, /\.(?:css|scss|sass)$/i],
    meta: ["html", "css"],
  },
  {
    key: "java",
    label: "Java",
    aliases: ["java", "core java", "advanced java", "j2ee", "jdk", "oops in java"],
    weight: 0.6,
    generic: true,
    langs: ["Java"],
    infraPaths: [/(?:^|\/)pom\.xml$/i, /(?:^|\/)build\.gradle(?:\.kts)?$/i],
    infraText: [/FROM\s+(?:openjdk|eclipse-temurin|amazoncorretto|maven)/i, /actions\/setup-java/i],
    artifactPaths: [/\.java$/i],
    meta: ["java"],
  },

  // ── Java / mobile / other web stacks ──
  {
    key: "spring-boot",
    label: "Spring Boot",
    aliases: ["spring boot", "springboot", "spring", "spring mvc", "spring framework", "spring security", "spring data jpa", "hibernate", "jpa"],
    weight: 0.8,
    langs: ["Java", "Kotlin"],
    dists: [
      "spring-boot-starter", "spring-boot-starter-web", "spring-boot-starter-parent", "spring-boot-starter-data-jpa",
      "spring-boot-starter-security", "spring-boot-starter-test", "spring-webmvc", "spring-context", "spring-core",
    ],
    derived: ["hibernate-core", "lombok"],
    modules: ["org.springframework"],
    calls: [/@SpringBootApplication\b/, /@RestController\b/, /@(?:Get|Post|Put|Delete|Request)Mapping\b/, /@Autowired\b/],
    artifactPaths: [/(?:^|\/)application\.(?:properties|ya?ml)$/i],
    meta: ["spring-boot", "spring"],
  },
  {
    key: "rest-api",
    label: "REST APIs",
    aliases: [
      "rest api", "rest apis", "restful", "restful api", "restful apis", "restful services", "api development",
      "backend development", "backend developer", "web services", "crud apis",
    ],
    weight: 0.8,
    langs: ["JavaScript", "TypeScript", "Python", "Java"],
    dists: ["express", "fastapi", "flask", "djangorestframework", "fastify", "koa", "@nestjs/core", "spring-boot-starter-web", "flask-restful"],
    modules: ["express", "fastapi", "flask", "rest_framework", "fastify", "koa", "@nestjs/core", "org.springframework.web"],
    calls: [
      /@app\.(?:get|post|put|delete|patch)\s*\(/,
      /\b(?:app|router)\.(?:get|post|put|delete|patch)\s*\(\s*["'`]\//,
      /@(?:Get|Post|Put|Delete|Patch)Mapping\b/,
      /@RestController\b/,
      /@app\.route\s*\(/,
      /@api_view\s*\(/,
    ],
    meta: ["rest-api", "restful", "rest api"],
  },
  {
    key: "angular",
    label: "Angular",
    aliases: ["angular", "angularjs", "angular.js"],
    weight: 0.6,
    langs: ["TypeScript"],
    dists: ["@angular/core"],
    modules: ["@angular/core"],
    calls: [/@Component\s*\(\s*\{/, /@NgModule\s*\(/],
    infraPaths: [/(?:^|\/)angular\.json$/i],
    meta: ["angular"],
  },
  {
    key: "vue",
    label: "Vue",
    aliases: ["vue", "vuejs", "vue.js", "nuxt", "nuxtjs"],
    weight: 0.6,
    langs: ["Vue", "JavaScript", "TypeScript"],
    dists: ["vue", "nuxt"],
    modules: ["vue"],
    artifactPaths: [/\.vue$/i],
    meta: ["vue", "vuejs"],
  },
  {
    key: "android",
    label: "Android / Kotlin",
    aliases: ["android", "kotlin", "jetpack compose", "android studio", "android development"],
    weight: 1,
    langs: ["Kotlin", "Java"],
    dists: ["appcompat", "core-ktx", "material", "kotlin-stdlib", "activity-compose", "ui-tooling", "material3"],
    modules: ["android", "androidx", "kotlinx"],
    calls: [
      /@Composable\b/,
      /\bclass\s+\w+\s*:\s*(?:AppCompat|Component|Fragment)?Activity\s*\(/,
      /\bsetContent\s*\{/,
      /\boverride\s+fun\s+onCreate\s*\(/,
    ],
    strongArtifactPaths: [/(?:^|\/)AndroidManifest\.xml$/i],
    artifactPaths: [/\.kt$/i],
    meta: ["android", "kotlin", "jetpack-compose"],
  },
  {
    key: "react-native",
    label: "React Native",
    aliases: ["react native", "react-native", "expo", "react native cli", "native modules"],
    weight: 1,
    langs: ["JavaScript", "TypeScript"],
    // React Native's own runtime, Expo and the RN-only libraries — never plain web React.
    dists: [
      "react-native", "expo", "expo-router", "@react-navigation/native", "@react-navigation/native-stack",
      "@react-navigation/stack", "@react-navigation/bottom-tabs", "react-native-reanimated", "react-native-gesture-handler",
      "react-native-screens", "react-native-safe-area-context", "@react-native-async-storage/async-storage",
      "react-native-mmkv", "@react-native-firebase/app", "react-native-vector-icons", "@expo/vector-icons",
    ],
    modules: ["react-native", "expo", "expo-router", "@react-navigation/native", "react-native-reanimated", "@react-native-async-storage/async-storage"],
    calls: [
      /\bStyleSheet\.create\s*\(/,
      /\bAppRegistry\.registerComponent\s*\(/,
      /<(?:SafeAreaView|FlatList|TouchableOpacity|Pressable)\b/,
      /\bcreate(?:NativeStack|Stack|BottomTab)Navigator\s*\(/,
    ],
    infraPaths: [/(?:^|\/)metro\.config\.[cm]?js$/i, /(?:^|\/)eas\.json$/i, /(?:^|\/)app\.config\.[cm]?[jt]s$/i],
    meta: ["react-native", "react native", "expo"],
  },
  {
    key: "android-architecture",
    label: "Android architecture (Jetpack, MVVM, DI)",
    aliases: [
      "mvvm", "mvi", "clean architecture", "jetpack", "viewmodel", "room", "hilt", "dagger", "koin", "retrofit",
      "coroutines", "kotlin flow", "stateflow", "workmanager", "datastore", "dependency injection",
    ],
    weight: 0.8,
    langs: ["Kotlin", "Java"],
    dists: [
      "hilt-android", "dagger", "koin-android", "room-runtime", "room-ktx", "retrofit", "okhttp", "kotlinx-coroutines-android",
      "lifecycle-viewmodel-ktx", "lifecycle-viewmodel-compose", "navigation-compose", "navigation-fragment-ktx",
      "work-runtime-ktx", "datastore-preferences", "paging-runtime",
    ],
    modules: ["dagger.hilt", "androidx.room", "retrofit2", "kotlinx.coroutines", "androidx.lifecycle", "org.koin", "androidx.work", "androidx.datastore"],
    calls: [/@HiltViewModel\b/, /@AndroidEntryPoint\b/, /@Dao\b/, /@Entity\b/, /\bviewModelScope\b/, /\bStateFlow\s*</, /@Inject\b/],
    meta: ["mvvm", "clean-architecture", "jetpack"],
  },
  {
    key: "app-release",
    label: "App store release (Play Store / App Store)",
    aliases: ["play store", "google play", "app store", "testflight", "play console", "published app", "fastlane"],
    weight: 0.6,
    // Adds to a mobile repo's score but never qualifies one on its own (an iOS-only repo has Fastlane too).
    generic: true,
    // A release pipeline in the repo is the proof; a store link in the README only corroborates.
    infraPaths: [/(?:^|\/)fastlane\/(?:Fastfile|Appfile)$/i, /(?:^|\/)eas\.json$/i],
    infraText: [/r0adkll\/upload-google-play/i, /eas\s+submit/i, /fastlane\s+(?:supply|deliver|pilot)/i],
    meta: ["play.google.com", "apps.apple.com", "google play", "play store", "app store", "testflight"],
  },
  {
    key: "flutter",
    label: "Flutter / Dart",
    aliases: ["flutter", "dart"],
    weight: 0.8,
    langs: ["Dart"],
    dists: ["flutter"],
    modules: ["flutter"],
    infraPaths: [/(?:^|\/)pubspec\.yaml$/i],
    artifactPaths: [/\.dart$/i],
    meta: ["flutter", "dart"],
  },
  {
    key: "dotnet",
    label: "C# / .NET",
    aliases: ["c#", "csharp", ".net", "dotnet", "asp.net", ".net core"],
    weight: 0.6,
    langs: ["C#"],
    modules: ["System", "Microsoft.AspNetCore"],
    infraPaths: [/\.csproj$/i, /\.sln$/i],
    artifactPaths: [/\.cs$/i],
    meta: ["dotnet", "csharp"],
  },

  // ── systems / backend languages, data infrastructure, IaC ──
  {
    key: "go",
    label: "Go",
    aliases: ["golang", "go lang", "go language", "go programming"],
    wordNames: ["go"],
    weight: 0.6,
    generic: true,
    langs: ["Go"],
    modules: ["fmt", "net/http"],
    calls: [/^package[ \t]+main[ \t]*$/m, /\bfunc[ \t]+main[ \t]*\([ \t]*\)/, /\bfunc[ \t]+\([^)\n]*\)[ \t]+\w+[ \t]*\(/],
    infraPaths: [/(?:^|\/)go\.mod$/i],
    infraText: [/FROM\s+golang:/i, /actions\/setup-go/i],
    artifactPaths: [/\.go$/i],
    meta: ["golang"],
  },
  {
    key: "rust",
    label: "Rust",
    aliases: ["rust", "rustlang", "rust lang", "rust language"],
    weight: 0.6,
    generic: true,
    langs: ["Rust"],
    calls: [/\bfn[ \t]+main[ \t]*\([ \t]*\)/, /\blet[ \t]+mut[ \t]+\w+/, /\bimpl(?:<[^>\n]*>)?[ \t]+[\w:<>, ]+[ \t]+for[ \t]+\w+/],
    infraPaths: [/(?:^|\/)Cargo\.toml$/i],
    infraText: [/FROM\s+rust:/i, /dtolnay\/rust-toolchain|actions-rs\/toolchain/i],
    artifactPaths: [/\.rs$/i],
    meta: ["rust", "rustlang"],
  },
  {
    key: "c-cpp",
    label: "C/C++",
    aliases: ["c++", "cpp", "c/c++", "c / c++", "cplusplus", "c plus plus", "modern c++", "embedded c", "c programming", "c language"],
    wordNames: ["c"],
    weight: 0.6,
    generic: true,
    langs: ["C++", "C", "Cuda"],
    ignoreAppShells: true,
    calls: [
      /^[ \t]*#[ \t]*include[ \t]*<(?:iostream|vector|string|map|unordered_map|algorithm|memory|bits\/stdc\+\+\.h|cstdio|cstdlib|stdio\.h|stdlib\.h|string\.h)>/m,
      /\bstd::\w+/,
      /\bint[ \t]+main[ \t]*\(/,
      // LeetCode-style solutions: C++ access labels and STL containers, no main / includes.
      /^[ \t]*(?:public|private|protected)[ \t]*:[ \t]*$/m,
      /\b(?:vector|unordered_map|unordered_set|priority_queue)<[\w:<> ,*&]+>/,
    ],
    infraPaths: [/(?:^|\/)(?:CMakeLists\.txt|meson\.build|conanfile\.(?:txt|py)|vcpkg\.json)$/i],
    infraText: [/FROM\s+gcc:/i, /\bcmake[ \t]+(?:-|\.\.|--build)/i],
    artifactPaths: [/\.(?:c|cc|cpp|cxx|hpp|hh|hxx)$/i],
    meta: ["cpp", "c-plus-plus", "c++"],
  },
  {
    key: "swift-ios",
    label: "Swift / iOS",
    // Not bare "iOS": "Flutter apps for Android and iOS" must not demand native Swift.
    aliases: ["swiftui", "swift ui", "uikit", "xcode", "objective-c", "objective c", "ios developer", "ios engineer", "native ios"],
    wordNames: ["swift"],
    weight: 1,
    langs: ["Swift", "Objective-C"],
    dists: ["alamofire", "kingfisher", "snapkit", "swiftyjson", "realmswift", "rxswift", "sdwebimage", "lottie-ios", "swift-composable-architecture"],
    modules: ["swiftui", "uikit", "swiftdata", "coredata", "appkit", "mapkit", "storekit", "healthkit", "arkit"],
    calls: [
      /\bstruct[ \t]+\w+[ \t]*:[ \t]*(?:\w+[ \t]*,[ \t]*)*View\b/,
      /\bvar[ \t]+body[ \t]*:[ \t]*some[ \t]+(?:View|Scene)\b/,
      /\bclass[ \t]+\w+[ \t]*:[ \t]*UI(?:View|TableView|CollectionView)Controller\b/,
    ],
    ignoreAppShells: true,
    infraPaths: [/\.xcodeproj\//i, /(?:^|\/)Package\.swift$/i],
    artifactPaths: [/\.swift$/i],
    meta: ["swift", "swiftui"],
  },
  {
    key: "php",
    label: "PHP",
    aliases: ["php", "core php", "symfony", "codeigniter", "cakephp", "yii"],
    weight: 0.6,
    generic: true,
    langs: ["PHP", "Blade", "Hack"],
    dists: ["symfony/framework-bundle", "symfony/console", "codeigniter4/framework", "cakephp/cakephp", "yiisoft/yii2"],
    modules: ["symfony"],
    calls: [/<\?php\b/],
    infraPaths: [/(?:^|\/)composer\.json$/i],
    infraText: [/FROM\s+php:/i, /shivammathur\/setup-php/i],
    artifactPaths: [/\.php$/i],
    meta: ["php"],
  },
  {
    key: "laravel",
    label: "Laravel",
    aliases: ["laravel", "laravel framework", "livewire"],
    weight: 0.8,
    langs: ["PHP", "Blade"],
    dists: [
      "laravel/framework", "laravel/lumen-framework", "laravel/sanctum", "laravel/breeze", "laravel/jetstream", "laravel/passport",
      "livewire/livewire", "inertiajs/inertia-laravel",
    ],
    modules: ["illuminate"],
    calls: [/\bRoute::(?:get|post|put|patch|delete|resource|apiResource|middleware|prefix|group)\s*\(/, /\bArtisan::/, /\bSchema::create\s*\(/],
    infraPaths: [/(?:^|\/)artisan$/],
    artifactPaths: [/\.blade\.php$/i, /(?:^|\/)database\/migrations\/[^/]+\.php$/i],
    meta: ["laravel"],
  },
  {
    key: "ruby",
    label: "Ruby",
    aliases: ["ruby", "ruby developer"],
    weight: 0.6,
    generic: true,
    langs: ["Ruby"],
    // No Gemfile proof on its own: every Jekyll / GitHub Pages site has one.
    calls: [/\battr_(?:accessor|reader|writer)\b/, /\bdo[ \t]*\|[\w, ]+\|/, /^[ \t]*require[ \t]+["'][\w/.-]+["'][ \t]*$/m],
    infraText: [/FROM\s+ruby:/i, /ruby\/setup-ruby/i],
    artifactPaths: [/\.rb$/i],
    meta: ["ruby"],
  },
  {
    key: "rails",
    label: "Ruby on Rails",
    // Not bare "rails": "guard-rails" is LLM wording.
    aliases: ["ruby on rails", "rubyonrails", "ror", "rails developer", "rails framework", "rails api"],
    weight: 0.8,
    langs: ["Ruby"],
    dists: ["rails", "railties", "actionpack", "activerecord", "actioncable", "sprockets-rails", "turbo-rails"],
    modules: ["rails", "rails/all", "active_record", "action_controller"],
    calls: [
      /\bclass[ \t]+\w+[ \t]*<[ \t]*(?:ApplicationController|ApplicationRecord|ActiveRecord::Base|ActionController::(?:Base|API))\b/,
      /\bRails\.application\b/,
    ],
    infraPaths: [/(?:^|\/)config\/routes\.rb$/i, /(?:^|\/)bin\/rails$/i],
    artifactPaths: [/(?:^|\/)db\/migrate\/[^/]+\.rb$/i, /\.html\.erb$/i],
    meta: ["rails", "ruby-on-rails"],
  },
  {
    key: "redis",
    label: "Redis",
    aliases: ["redis", "redis cache"],
    weight: 0.6,
    dists: [
      "redis", "redis-py", "aioredis", "django-redis", "ioredis", "@redis/client", "jedis", "lettuce-core",
      "spring-boot-starter-data-redis", "redisson", "github.com/redis/go-redis", "github.com/go-redis/redis",
      "github.com/gomodule/redigo", "predis/predis", "hiredis", "redis-plus-plus", "redis-rails",
    ],
    derived: ["bull", "bullmq", "sidekiq", "rq"],
    modules: [
      "redis", "ioredis", "aioredis", "@redis/client", "redis.clients.jedis", "io.lettuce", "org.springframework.data.redis",
      "org.redisson", "github.com/redis/go-redis", "github.com/go-redis/redis", "github.com/gomodule/redigo", "predis", "hiredis",
      "sw/redis++/redis++.h", "StackExchange.Redis",
    ],
    calls: [/\bredis\.(?:Redis|StrictRedis|from_url|NewClient)\s*\(/, /\bnew[ \t]+(?:Redis|IORedis|Jedis(?:Pool)?)[ \t]*\(/, /\bRedisTemplate\b/, /["'`]rediss?:\/\//],
    infraText: [/image:\s*["']?(?:redis|bitnami\/redis|redis\/redis-stack)\b/i, /FROM\s+redis\b/i],
    meta: ["redis"],
  },
  {
    key: "kafka",
    label: "Kafka",
    aliases: ["kafka", "apache kafka", "kafka streams", "confluent kafka"],
    weight: 0.6,
    dists: [
      "kafka-python", "confluent-kafka", "aiokafka", "faust-streaming", "kafkajs", "node-rdkafka", "@confluentinc/kafka-javascript",
      "kafka-clients", "spring-kafka", "kafka-streams", "github.com/segmentio/kafka-go", "github.com/confluentinc/confluent-kafka-go",
      "github.com/ibm/sarama", "github.com/shopify/sarama", "github.com/twmb/franz-go", "github.com/lovoo/goka", "rdkafka",
      "ruby-kafka", "karafka", "librdkafka", "cppkafka", "kafka-python-ng", "kafka-node", "reactor-kafka",
      "spring-cloud-stream-binder-kafka",
    ],
    modules: [
      "kafka", "confluent_kafka", "aiokafka", "faust", "kafkajs", "node-rdkafka", "org.apache.kafka", "org.springframework.kafka",
      "github.com/segmentio/kafka-go", "github.com/confluentinc/confluent-kafka-go", "github.com/ibm/sarama", "github.com/shopify/sarama",
      "github.com/twmb/franz-go", "github.com/lovoo/goka", "kafka-node", "rdkafka", "librdkafka", "cppkafka", "Confluent.Kafka",
    ],
    calls: [/\bKafka(?:Producer|Consumer|Template|AdminClient|Streams)\b/, /@KafkaListener\b/, /\bnew[ \t]+Kafka[ \t]*\([ \t]*\{/, /\bkafka\.(?:NewWriter|NewReader)\b/],
    infraText: [/image:\s*["']?(?:confluentinc\/cp-(?:kafka|server)|bitnami\/kafka|apache\/kafka|wurstmeister\/kafka|redpandadata\/redpanda)/i],
    meta: ["kafka", "apache-kafka"],
  },
  {
    key: "graphql",
    label: "GraphQL",
    aliases: ["graphql", "graph ql", "apollo graphql", "apollo server", "apollo client", "hasura"],
    weight: 0.6,
    dists: [
      "graphql", "@apollo/server", "apollo-server", "apollo-server-express", "@apollo/client", "graphql-yoga", "type-graphql",
      "@nestjs/graphql", "graphql-request", "urql", "relay-runtime", "express-graphql", "graphql-http", "mercurius", "graphene",
      "graphene-django", "strawberry-graphql", "ariadne", "graphql-java", "spring-boot-starter-graphql", "github.com/99designs/gqlgen",
      "github.com/graphql-go/graphql", "async-graphql", "juniper", "webonyx/graphql-php", "nuwave/lighthouse", "rebing/graphql-laravel",
    ],
    modules: [
      "graphql", "@apollo/server", "apollo-server", "apollo-server-express", "@apollo/client", "graphql-yoga", "type-graphql",
      "@nestjs/graphql", "graphql-request", "urql", "graphene", "strawberry", "ariadne", "org.springframework.graphql",
      "com.netflix.graphql", "github.com/99designs/gqlgen", "github.com/graphql-go/graphql", "async_graphql", "juniper",
    ],
    calls: [
      /\bgql[ \t]*`/,
      /^[ \t]*(?:extend[ \t]+)?type[ \t]+(?:Query|Mutation|Subscription)[ \t]*\{/m,
      /\bnew[ \t]+ApolloServer[ \t]*\(/,
      /@(?:QueryMapping|MutationMapping|SchemaMapping)\b/,
      /\bgraphqlHTTP[ \t]*\(/,
    ],
    artifactPaths: [/\.(?:graphql|graphqls|gql)$/i],
    meta: ["graphql"],
  },
  {
    key: "terraform",
    label: "Terraform",
    aliases: ["terraform", "opentofu", "terragrunt"],
    weight: 0.6,
    langs: ["HCL"],
    calls: [
      /^[ \t]*resource[ \t]+"[\w-]+"[ \t]+"[\w-]+"[ \t]*\{/m,
      /^[ \t]*terraform[ \t]*\{/m,
      /^[ \t]*provider[ \t]+"[\w-]+"[ \t]*\{/m,
    ],
    // The configuration IS the proof, as a Dockerfile is for Docker.
    infraPaths: [/\.tf$/i, /(?:^|\/)\.terraform\.lock\.hcl$/i, /(?:^|\/)terragrunt\.hcl$/i],
    infraText: [/hashicorp\/setup-terraform/i, /\bterraform[ \t]+(?:init|plan|apply)\b/i],
    artifactPaths: [/\.tfvars$/i],
    meta: ["terraform", "infrastructure-as-code"],
  },

  // ── QA / testing ──
  {
    key: "test-automation",
    label: "Automated testing",
    aliases: [
      "testing", "test automation", "automation testing", "automated testing", "unit testing", "unit tests", "integration testing",
      "qa automation", "software testing", "test cases", "test scripts", "tdd", "pytest", "jest", "junit", "testng", "mocha", "vitest", "qa",
    ],
    weight: 0.8,
    dists: [
      "pytest", "pytest-cov", "jest", "mocha", "vitest", "chai", "supertest", "@testing-library/react", "@testing-library/jest-dom",
      "junit", "junit-jupiter", "junit-jupiter-api", "testng", "mockito-core", "nose2", "tox",
    ],
    modules: ["pytest", "unittest", "org.junit", "org.testng", "org.mockito", "@testing-library/react", "chai", "supertest", "vitest", "@jest/globals"],
    calls: [
      /\bdescribe\s*\(\s*["'`]/,
      /^\s*(?:it|test)\s*\(\s*["'`]/m,
      /@Test\b/,
      /^\s*def\s+test_\w+\s*\(/m,
      /\bassert(?:Equals|True|False|That|NotNull)\s*\(/,
      /\bunittest\.TestCase\b/,
    ],
    infraPaths: [/(?:^|\/)(?:jest|vitest)\.config\.[cm]?[jt]s$/i, /(?:^|\/)pytest\.ini$/i, /(?:^|\/)testng\.xml$/i, /(?:^|\/)conftest\.py$/i],
    // Test FILES by naming convention — a bare "tests/" folder (any language, maybe empty) is not proof.
    artifactPaths: [/\.(?:test|spec)\.[cm]?[jt]sx?$/i, /(?:^|\/)test_[^/]+\.py$/i, /Tests?\.(?:java|kt|cs)$/],
    meta: ["testing", "test-automation", "unit-testing", "qa"],
  },
  {
    key: "selenium",
    label: "Selenium",
    aliases: ["selenium", "selenium webdriver", "webdriver", "webdriverio"],
    weight: 1,
    langs: ["Java", "Python", "JavaScript", "TypeScript", "C#"],
    dists: ["selenium", "selenium-java", "selenium-webdriver", "webdriverio", "@wdio/cli", "webdriver-manager", "webdrivermanager", "selenium-server"],
    modules: ["selenium", "org.openqa.selenium", "selenium-webdriver", "webdriverio", "OpenQA.Selenium", "io.github.bonigarcia.wdm"],
    calls: [
      /\bwebdriver\.(?:Chrome|Firefox|Edge|Remote)\s*\(/,
      /\bnew\s+(?:Chrome|Firefox|Edge|Remote)(?:Web)?Driver\s*\(/,
      /\bfind_element\s*\(/,
      /\bfindElement\s*\(/,
      /\bBy\.(?:xpath|id|cssSelector|className|XPATH|ID|CSS_SELECTOR|CLASS_NAME)\b/,
    ],
    meta: ["selenium", "webdriver"],
  },
  {
    key: "playwright",
    label: "Playwright",
    aliases: ["playwright"],
    weight: 1,
    langs: ["TypeScript", "JavaScript", "Python"],
    dists: ["playwright", "@playwright/test", "pytest-playwright"],
    modules: ["playwright", "@playwright/test", "com.microsoft.playwright"],
    calls: [/\bpage\.goto\s*\(/, /\bpage\.getBy(?:Role|Text|Label|TestId)\s*\(/],
    infraPaths: [/(?:^|\/)playwright\.config\.[cm]?[jt]s$/i],
    meta: ["playwright"],
  },
  {
    key: "cypress",
    label: "Cypress",
    aliases: ["cypress"],
    weight: 1,
    langs: ["JavaScript", "TypeScript"],
    dists: ["cypress"],
    modules: ["cypress"],
    calls: [/\bcy\.(?:visit|get|request|contains)\s*\(/],
    infraPaths: [/(?:^|\/)cypress\.config\.[cm]?[jt]s$/i, /(?:^|\/)cypress\.json$/i],
    artifactPaths: [/(?:^|\/)cypress\/(?:e2e|integration)\//i],
    meta: ["cypress"],
  },
  {
    key: "api-testing",
    label: "API testing (Postman / REST Assured)",
    aliases: ["postman", "api testing", "rest assured", "restassured", "rest-assured", "newman", "api automation", "karate"],
    weight: 0.8,
    dists: ["rest-assured", "newman", "karate-junit5", "karate-core", "pytest-httpx", "tavern"],
    modules: ["io.restassured", "newman", "com.intuit.karate"],
    calls: [/\bgiven\(\)\s*\.\s*(?:when|header|body|contentType|queryParam|auth)\b/, /\bpm\.(?:test|expect)\s*\(/, /\bRestAssured\./],
    strongArtifactPaths: [/\.postman_collection\.json$/i],
    artifactPaths: [/\.postman_environment\.json$/i],
    meta: ["postman", "api-testing", "rest-assured"],
  },
  {
    key: "bdd",
    label: "BDD (Cucumber)",
    aliases: ["cucumber", "bdd", "gherkin", "behave", "behaviour driven", "behavior driven"],
    weight: 0.8,
    dists: ["cucumber-java", "cucumber-junit", "cucumber-testng", "@cucumber/cucumber", "behave", "pytest-bdd"],
    modules: ["io.cucumber", "behave", "@cucumber/cucumber", "pytest_bdd"],
    calls: [/@(?:Given|When|Then)\s*\(/, /^\s*(?:Feature|Scenario):/m],
    artifactPaths: [/\.feature$/i],
    meta: ["cucumber", "bdd"],
  },
  {
    key: "appium",
    label: "Appium / mobile testing",
    aliases: ["appium", "mobile testing", "mobile automation", "mobile app testing"],
    weight: 0.8,
    dists: ["appium-python-client", "java-client", "appium", "@wdio/appium-service"],
    modules: ["appium", "io.appium"],
    calls: [/\bAppiumDriver\b/, /\bAndroidDriver\b/, /\bwebdriver\.Remote\s*\([^)]*appium/i],
    meta: ["appium"],
  },
  {
    key: "performance-testing",
    label: "Performance testing",
    aliases: ["jmeter", "performance testing", "load testing", "stress testing", "k6", "locust", "gatling"],
    weight: 0.6,
    dists: ["locust", "k6", "gatling"],
    modules: ["locust", "k6"],
    calls: [/\bclass\s+\w+\(HttpUser\)/, /\bexport\s+default\s+function\s*\(\s*\)\s*\{[\s\S]{0,200}?http\.get/],
    strongArtifactPaths: [/\.jmx$/i],
    meta: ["jmeter", "performance-testing", "load-testing"],
  },

  // ── data / ML umbrella ──
  {
    key: "machine-learning",
    label: "Machine learning",
    aliases: [
      "machine learning", "ml", "ai/ml", "ai", "artificial intelligence", "deep learning", "data science", "predictive modelling",
      "predictive modeling", "supervised learning", "unsupervised learning", "neural network", "neural networks", "xgboost",
    ],
    weight: 1,
    langs: ["Python", "Jupyter Notebook"],
    dists: ["scikit-learn", "xgboost", "lightgbm", "catboost", "torch", "tensorflow", "keras", "statsmodels"],
    modules: ["sklearn", "xgboost", "lightgbm", "catboost", "torch", "tensorflow", "keras"],
    calls: [/\b(?:model|clf|regressor|classifier|pipe(?:line)?)\.fit\s*\(/, /\.fit\s*\(\s*X_train\b/, /\btrain_test_split\s*\(/],
    artifactPaths: [/\.(?:pkl|joblib|h5|keras|pt|pth|onnx)$/i],
    meta: ["machine-learning", "deep-learning", "data-science", "ml"],
  },
  {
    key: "data-viz",
    label: "Data visualisation",
    aliases: ["data visualization", "data visualisation", "visualization", "visualisation", "matplotlib", "seaborn", "plotly", "dashboards", "dashboard"],
    weight: 0.4,
    langs: ["Python", "Jupyter Notebook"],
    dists: ["matplotlib", "seaborn", "plotly", "streamlit", "dash", "bokeh", "altair", "chart.js", "recharts", "d3"],
    modules: ["matplotlib", "seaborn", "plotly", "streamlit", "dash", "bokeh", "altair", "chart.js", "recharts", "d3"],
    calls: [/\bplt\.(?:plot|show|figure|bar|hist|scatter)\s*\(/, /\bsns\.\w+plot\s*\(/, /\bpx\.\w+\s*\(/, /\bst\.(?:title|write|plotly_chart)\s*\(/],
    meta: ["visualization", "dashboard", "streamlit"],
  },
  {
    key: "excel",
    label: "Excel",
    aliases: ["excel", "ms excel", "advanced excel", "spreadsheets", "vba", "pivot tables"],
    weight: 0.4,
    dists: ["openpyxl", "xlsxwriter", "xlrd"],
    modules: ["openpyxl", "xlsxwriter", "xlrd"],
    strongArtifactPaths: [/\.(?:xlsx|xlsm|xlsb)$/i],
    artifactPaths: [/\.bas$/i],
    meta: ["excel"],
  },
];

/**
 * Import-module ↔ distribution-name aliasing. The two namespaces genuinely differ
 * (`scikit-learn` is imported as `sklearn`, `opencv-python` as `cv2`), and conda spells
 * PyTorch `pytorch` while PyPI spells it `torch`. Substring matching across the two is
 * exactly the bug this whole module exists to fix, so both columns are kept explicit.
 */
const DIST_ALIAS: Record<string, string> = {
  sklearn: "scikit-learn",
  pytorch: "torch", // conda spelling of torch (environment.yml only, see readManifest)
  "opencv-contrib-python": "opencv-python",
  "opencv-python-headless": "opencv-python",
  fbprophet: "prophet",
  "psycopg2-binary": "psycopg2",
};

/** Index of every label / key / alias → TechDef, for resolving free-text JD wording. */
const TECH_INDEX: Map<string, TechDef> = (() => {
  const index = new Map<string, TechDef>();
  for (const def of TECHS) {
    index.set(canon(def.key), def);
    index.set(canon(def.label), def);
    for (const alias of def.aliases) index.set(canon(alias), def);
  }
  return index;
})();

/**
 * Resolve a JD phrase to a modelled technology. Unknown phrases become a synthetic
 * metadata-only tech so an unusual JD term still contributes something (capped at 0.45,
 * exactly like any other metadata-only evidence) rather than being silently dropped.
 */
function resolveTech(label: string): TechDef {
  const known = TECH_INDEX.get(canon(label));
  if (known) return known;
  const bare = label.trim();
  return {
    key: canon(bare),
    label: bare,
    aliases: [bare],
    weight: 0.6,
    dists: [canon(bare)],
    modules: [bare.toLowerCase().replace(/[^a-z0-9_]/g, "")].filter((m) => m.length >= 3),
    meta: [bare.toLowerCase()],
  };
}

// ── JD parsing ──────────────────────────────────────────────────────────────

/**
 * Noise that would otherwise resolve to a technology by accident, plus generic JD
 * filler. Kept small on purpose — the alias index does most of the work.
 */
const JD_STOPWORDS = new Set([
  "and", "the", "with", "for", "experience", "skills", "knowledge", "good", "strong",
  "work", "team", "using", "build", "developing", "developer", "engineer", "years",
  "understanding", "hands", "on", "etc", "must", "have", "should", "familiar",
]);

/**
 * Does `text` contain `phrase` as a whole token/phrase (not as part of a longer word)?
 * A preceding "." also counts as part of the word, so the "js" in "Node.js" / "Next.js"
 * is not read as a separate JavaScript requirement.
 */
function mentions(text: string, phrase: string): boolean {
  const p = escapeRe(phrase.toLowerCase());
  return new RegExp(`(?:^|[^a-z0-9+#.])${p}(?![a-z0-9+#])`, "i").test(text);
}

/**
 * An everyday-word name ("Go", "Swift", "C") used as a technology: a list item of its own
 * ("Java, Go, Python", "C / C++", "• Swift", "Languages: C") or — two letters and longer —
 * capitalised mid-sentence ("backend services in Go"). "go-to-market", "let's go",
 * "swift delivery" and a sentence that merely starts with the word do not count.
 */
function mentionsWord(text: string, word: string): boolean {
  const w = word.toLowerCase();
  for (const raw of (text ?? "").split(/[,;\/\n•|()[\]]+|\bor\b|\band\b|&/i)) {
    const frag = raw
      .replace(/^.*:/, "")
      .replace(/^[\s*\-–—\d.)]+/, "")
      .replace(/[\s.!?]+$/, "")
      .toLowerCase();
    if (frag === w) return true;
  }
  if (w.length < 2) return false;
  const cap = escapeRe(w[0].toUpperCase() + w.slice(1));
  return new RegExp(`(?<=[A-Za-z0-9,)][ \\t]+)${cap}(?![\\w+#-])`).test(text ?? "");
}

/** A technology's label is itself an everyday word ("Go") — it then only matches as a word name. */
const labelIsWord = (def: TechDef): boolean => (def.wordNames ?? []).includes(def.label.toLowerCase());

/** JD / resume wording names this tech through one of its everyday-word names. */
const wordIn = (def: TechDef, text: string): boolean => (def.wordNames ?? []).some((w) => mentionsWord(text, w));

/**
 * Split the free-text mandatory field and the wider domain/JD text into the
 * mandatory / good-to-have technology slots.
 *
 * Mandatory wins on conflict: a technology named in BOTH fields is mandatory only.
 * When the mandatory field names nothing we recognise, `mandatory` comes back empty and
 * the scorer applies no ceiling penalty — an unparseable JD must not punish everyone.
 *
 * `modelledOnly` drops unrecognised mandatory fragments instead of turning them into
 * weak synthetic slots. The domain shortlist uses it: its mandatory field is a RESUME
 * requirement ("DSA", "internship", "communication") that no repository can prove, so a
 * synthetic slot would only cap every candidate's GitHub score.
 */
export function buildJdTechSpec(
  mandatoryText: string,
  domainText: string,
  opts: { modelledOnly?: boolean } = {},
): JdTechSpec {
  const mand = (mandatoryText ?? "").toLowerCase();
  const dom = (domainText ?? "").toLowerCase();

  const mandatory: string[] = [];
  const goodToHave: string[] = [];
  const seen = new Set<string>();

  for (const def of TECHS) {
    // "React Native" names React Native, not web React: blank out the longer names of
    // OTHER technologies that contain one of this tech's names before looking for it.
    const longer = TECHS.filter((o) => o.key !== def.key)
      .flatMap((o) => o.aliases)
      .filter((x) => def.aliases.some((a) => x !== a && mentions(x, a)));
    const mask = (text: string) => longer.reduce((t, x) => t.split(x).join(" "), text);
    const mandText = longer.length ? mask(mand) : mand;
    const domText = longer.length ? mask(dom) : dom;
    const named = (text: string) => def.aliases.some((a) => mentions(text, a)) || (!labelIsWord(def) && mentions(text, def.label));
    const inMandatory = named(mandText) || wordIn(def, mandatoryText ?? "");
    const inDomain = named(domText) || wordIn(def, domainText ?? "");
    if (!inMandatory && !inDomain) continue;
    if (seen.has(def.key)) continue;
    seen.add(def.key);
    (inMandatory ? mandatory : goodToHave).push(def.label);
  }

  // Anything in the mandatory field we could not model still deserves a (weak) slot —
  // otherwise a JD naming an in-house tool would score as if it named nothing.
  if (opts.modelledOnly) return { mandatory, goodToHave };
  for (const token of tokenizeJd(mand)) {
    if (TECH_INDEX.has(canon(token))) continue;
    const key = canon(token);
    if (seen.has(key)) continue;
    seen.add(key);
    mandatory.push(token);
  }

  return { mandatory, goodToHave };
}

/**
 * Mandatory technologies the resume text never names — under any of the catalogue's
 * names for them. A safety net for the model's "meets every mandatory requirement":
 * a requirement can't be met by a resume that never mentions it. Only plain
 * requirements are checked — a clause offering alternatives ("React Native or Kotlin",
 * "Python/backend OR Linux") is left to the model — and only catalogued technologies
 * (never free-text asks like "internship experience"). Matching is loose ("ExpressJS",
 * "Mongo DB" count) and also accepts the tech's package / library names ("Pinecone",
 * "OpenAI API", "ChromaDB" name an LLM stack), so this only ever catches a clear absence.
 */
export function mandatoryTechsAbsent(mandatoryText: string, resumeText: string): string[] {
  const ctx = nameCtx(resumeText);
  if (!ctx.squeezed) return [];
  const missing = new Set<string>();
  for (const clause of (mandatoryText ?? "").split(/[,;\n•|]+|\band\b|&/i)) {
    if (/\bor\b|\//i.test(clause)) continue;
    for (const label of buildJdTechSpec(clause, "", { modelledOnly: true }).mandatory) {
      const def = TECHS.find((t) => t.label === label);
      if (def && !namesTech(def, ctx)) missing.add(label);
    }
  }
  return [...missing];
}

/** The catalogued technologies among `labels` that the text names — what a resume CLAIMS, never proof. */
export function techsNamedIn(labels: string[], text: string): string[] {
  const ctx = nameCtx(text);
  if (!ctx.squeezed) return [];
  return labels.filter((label) => {
    const def = TECHS.find((t) => t.label === label);
    return def ? namesTech(def, ctx) : false;
  });
}

const squeezeName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9+#]/g, "");

/** A text as `namesTech` reads it: as written, lower-cased, and squeezed of punctuation / spaces. */
interface NameCtx {
  original: string;
  lower: string;
  squeezed: string;
}

function nameCtx(text: string): NameCtx {
  const original = text ?? "";
  const lower = original.toLowerCase();
  return { original, lower, squeezed: squeezeName(lower) };
}

/**
 * Does the text name this technology under any catalogue name — label, alias, everyday-word
 * name, or a distinctive library name? Loose on purpose ("ExpressJS", "Mongo DB", "Pinecone"
 * count), so the mandatory guard only ever catches a clear absence. Short names ("rag",
 * "gpt", "llm") must stand alone — inside other words they'd match "storage" or "leverage";
 * longer ones match squeezed. Everyday words ("Go", "Swift") only count as a list item or
 * capitalised mid-sentence.
 */
function namesTech(def: TechDef, ctx: NameCtx): boolean {
  const named = (q: string) =>
    q.length <= 3 ? new RegExp(`(?:^|[^a-z0-9])${escapeRe(q)}(?![a-z0-9])`).test(ctx.lower) : ctx.squeezed.includes(q);
  const words = new Set((def.wordNames ?? []).map((w) => w.toLowerCase()));
  const names = [def.label, ...def.aliases]
    .filter((n) => !words.has(n.toLowerCase()))
    .map(squeezeName)
    .filter((q) => q.length >= 2);
  // Library names: only distinctive ones (≥ 5 letters, not an everyday word).
  const libs = [...(def.dists ?? []), ...(def.modules ?? []), ...(GUARD_EXTRA_NAMES[def.key] ?? [])]
    .map(squeezeName)
    .filter((q) => q.length >= 5 && !GUARD_COMMON_WORDS.has(q));
  return [...names, ...libs].some(named) || wordIn(def, ctx.original);
}

/** Further names that show a resume uses a technology (guard only — not JD wording). */
const GUARD_EXTRA_NAMES: Record<string, string[]> = {
  llm: ["huggingface", "transformers", "diffusers", "stable diffusion", "generative"],
};

/** Package names that are also everyday resume words ("under the guidance of…"). */
const GUARD_COMMON_WORDS = new Set(["guidance", "instructor", "evaluate", "datasets", "accelerate", "optimum", "motor"]);

/**
 * Pull plausible technology names out of a free-text mandatory field: comma / slash /
 * newline separated fragments of 1-3 words, minus stopwords and bare numbers.
 */
function tokenizeJd(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,;/\n•|]+/)) {
    const frag = raw.replace(/\(.*?\)/g, " ").replace(/[^a-z0-9+#. -]/gi, " ").replace(/\s+/g, " ").trim();
    if (!frag) continue;
    const words = frag.split(" ").filter((w) => w.length >= 2 && !JD_STOPWORDS.has(w) && !/^\d+$/.test(w));
    if (words.length === 0 || words.length > 3) continue;
    const phrase = words.join(" ");
    if (phrase.length >= 2 && phrase.length <= 32) out.push(phrase);
  }
  return out;
}

// ── Manifest & source parsing ───────────────────────────────────────────────

/** Pure-transitive packages nobody hand-writes — their presence fingerprints a `pip freeze`. */
const FREEZE_MARKERS = new Set([
  "certifi", "charset-normalizer", "idna", "urllib3", "six", "packaging", "zipp",
  "markupsafe", "click", "typing-extensions", "setuptools", "wheel", "colorama",
  "attrs", "pyparsing",
]);

/** One line of a requirements file → the canonical distribution name, or null. */
function parseRequirementLine(line: string): string | null {
  const stripped = line.replace(/#.*$/, "").trim();
  if (!stripped || stripped.startsWith("-")) return null; // -r / -e / --index-url
  const atGit = stripped.match(/#egg=([A-Za-z0-9._-]+)/);
  if (atGit) return canon(atGit[1]);
  const m = stripped.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;@].*)?$/);
  return m ? canon(m[1]) : null;
}

interface ManifestRead {
  /** Canonical distribution names declared. */
  deps: string[];
  /** True when the file looks like a copied `pip freeze` or a bloated unused dump. */
  lowTrust: boolean;
}

/** Parse one manifest file into canonical dependency names. Never throws. */
function readManifest(path: string, text: string): ManifestRead {
  const file = path.split("/").pop() ?? path;
  const deps = new Set<string>();
  let exactPins = 0;
  let lines = 0;

  try {
    if (/^requirements[\w.-]*\.txt$/i.test(file)) {
      for (const line of text.split(/\r?\n/)) {
        const name = parseRequirementLine(line);
        if (!name) continue;
        lines += 1;
        if (/==/.test(line)) exactPins += 1;
        deps.add(DIST_ALIAS[name] ?? name);
      }
    } else if (/^pyproject\.toml$/i.test(file)) {
      // [project].dependencies / optional-dependencies / [tool.poetry.dependencies].
      // [build-system].requires is deliberately ignored — hatchling is not stack signal.
      const body = text.replace(/\[build-system\][\s\S]*?(?=\n\[|$)/g, "");
      for (const arr of body.matchAll(/dependencies\s*=\s*\[([\s\S]*?)\]/g)) {
        for (const item of arr[1].matchAll(/["']([^"']+)["']/g)) {
          const name = parseRequirementLine(item[1]);
          if (name) deps.add(DIST_ALIAS[name] ?? name);
        }
      }
      const poetry = body.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|$)/);
      if (poetry) {
        for (const kv of poetry[1].matchAll(/^\s*([A-Za-z0-9._-]+)\s*=/gm)) {
          const name = canon(kv[1]);
          if (name !== "python") deps.add(DIST_ALIAS[name] ?? name);
        }
      }
    } else if (/^Pipfile$/i.test(file)) {
      const pkgs = text.match(/\[packages\]([\s\S]*?)(?=\n\[|$)/);
      if (pkgs) {
        for (const kv of pkgs[1].matchAll(/^\s*["']?([A-Za-z0-9._-]+)["']?\s*=/gm)) {
          const name = canon(kv[1]);
          deps.add(DIST_ALIAS[name] ?? name);
        }
      }
    } else if (/^environment\.ya?ml$/i.test(file)) {
      for (const item of text.matchAll(/^\s*-\s*([A-Za-z0-9][A-Za-z0-9._-]*)/gm)) {
        const name = canon(item[1]);
        // conda spells PyTorch "pytorch"; PyPI's `pytorch` package is junk, so the
        // alias is honoured for environment.yml only.
        deps.add(name === "pytorch" ? "torch" : (DIST_ALIAS[name] ?? name));
      }
    } else if (/^setup\.py$/i.test(file)) {
      const req = text.match(/install_requires\s*=\s*\[([\s\S]*?)\]/);
      if (req) {
        for (const item of req[1].matchAll(/["']([^"']+)["']/g)) {
          const name = parseRequirementLine(item[1]);
          if (name) deps.add(DIST_ALIAS[name] ?? name);
        }
      }
    } else if (/^package\.json$/i.test(file)) {
      const parsed = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      for (const key of Object.keys({ ...parsed.dependencies, ...parsed.devDependencies })) {
        deps.add(canon(key));
      }
    } else if (/^pom\.xml$/i.test(file)) {
      // <dependency> and <parent> artifactIds (spring-boot-starter-parent proves Spring on its own).
      for (const block of text.matchAll(/<(?:dependency|parent)>([\s\S]*?)<\/(?:dependency|parent)>/g)) {
        const artifact = block[1].match(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/);
        if (artifact) deps.add(canon(artifact[1]));
      }
    } else if (/^build\.gradle(?:\.kts)?$/i.test(file)) {
      // implementation 'group:artifact:ver' / testImplementation("group:artifact:ver")
      for (const m of text.matchAll(/["']([\w.-]+):([\w.-]+)(?::[^"']*)?["']/g)) deps.add(canon(m[2]));
      if (/org\.springframework\.boot/.test(text)) deps.add("spring-boot-starter");
    } else if (/^pubspec\.yaml$/i.test(file)) {
      const sections = text.match(/^(?:dev_)?dependencies:\s*\n((?:[ \t]+.*\n?)*)/gm) ?? [];
      for (const section of sections) {
        for (const kv of section.matchAll(/^[ \t]{2}([a-z0-9_]+):/gm)) deps.add(canon(kv[1]));
      }
    } else if (/^go\.mod$/i.test(file)) {
      // `require x v1.2.3` and `require ( … )` blocks. `// indirect` lines are transitive —
      // pulled in by something else, not chosen — so they are not the candidate's stack.
      const add = (line: string) => {
        if (/\/\/\s*indirect\b/.test(line)) return;
        const m = line.trim().match(/^([^\s/][^\s]*)\s+v\d/);
        if (!m) return;
        const path = m[1].toLowerCase();
        deps.add(canon(goModuleRoot(path)));
        deps.add(canon(path));
      };
      for (const m of text.matchAll(/^require[ \t]+(?!\()(.+)$/gm)) add(m[1]);
      for (const block of text.matchAll(/^require[ \t]*\(([\s\S]*?)^\)/gm)) for (const line of block[1].split(/\r?\n/)) add(line);
    } else if (/^Cargo\.toml$/i.test(file)) {
      // [dependencies] / [dev-dependencies] / [build-dependencies], also under [target.….] and
      // [workspace.…]; a `[dependencies.serde]` table names its crate in the header.
      let section = "";
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, "").trim();
        const header = line.match(/^\[([^\]]+)\]$/);
        if (header) {
          section = header[1].trim();
          const table = section.match(/(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/);
          if (table) deps.add(canon(table[1]));
          continue;
        }
        if (!/(?:^|\.)(?:dev-|build-)?dependencies$/.test(section)) continue;
        const kv = line.match(/^([A-Za-z0-9_-]+)\s*=/);
        if (kv) deps.add(canon(kv[1]));
      }
    } else if (/^composer\.json$/i.test(file)) {
      const parsed = JSON.parse(text) as { require?: Record<string, string>; "require-dev"?: Record<string, string> };
      for (const key of Object.keys({ ...parsed.require, ...parsed["require-dev"] })) {
        // The PHP runtime and its extensions are platform requirements, not libraries.
        if (/^(?:php|hhvm)$/i.test(key) || /^(?:ext|lib)-/i.test(key) || /^composer(?:-plugin-api|-runtime-api)?$/i.test(key)) continue;
        deps.add(canon(key));
      }
    } else if (/^Gemfile$/i.test(file)) {
      for (const m of text.matchAll(/^[ \t]*gem[ \t]*\(?[ \t]*["']([A-Za-z0-9_.-]+)["']/gm)) deps.add(canon(m[1]));
    } else if (/^Package\.swift$/i.test(file)) {
      // .package(url: "https://github.com/Alamofire/Alamofire.git", from: "5.8.0") → alamofire
      for (const m of text.matchAll(/\.package\s*\([^)]*?url:\s*"([^"]+)"/g)) {
        const name = m[1].replace(/\.git$/i, "").replace(/\/+$/, "").split("/").pop();
        if (name) deps.add(canon(name));
      }
    } else if (/^Podfile$/i.test(file)) {
      // pod 'Alamofire' / pod 'Firebase/Analytics' → alamofire / firebase
      for (const m of text.matchAll(/^[ \t]*pod[ \t]+["']([A-Za-z0-9_.+-]+)(?:\/[^"']*)?["']/gm)) deps.add(canon(m[1]));
    } else if (/^vcpkg\.json$/i.test(file)) {
      const parsed = JSON.parse(text) as { dependencies?: (string | { name?: string })[] };
      for (const d of parsed.dependencies ?? []) {
        const name = typeof d === "string" ? d : d?.name;
        if (name) deps.add(canon(name));
      }
    } else if (/^conanfile\.txt$/i.test(file)) {
      let section = "";
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, "").trim();
        const header = line.match(/^\[([^\]]+)\]$/);
        if (header) {
          section = header[1].trim().toLowerCase();
          continue;
        }
        const ref = section === "requires" || section === "tool_requires" ? line.match(/^([A-Za-z0-9_.+-]+)\//) : null;
        if (ref) deps.add(canon(ref[1]));
      }
    }
  } catch {
    // Malformed manifest = no declared deps. Never fatal.
  }

  const freezeFingerprint =
    lines >= 10 && exactPins / Math.max(lines, 1) >= 0.7 && [...deps].filter((d) => FREEZE_MARKERS.has(d)).length >= 3;

  return { deps: [...deps], lowTrust: freezeFingerprint };
}

/**
 * Top-level modules actually imported. Triple-quoted blocks are stripped first and the
 * pattern is line-anchored, so `# TODO: wrap in flask` and `"""uses flask"""` are
 * correctly NOT matches — that is the single most common false positive in the old
 * substring check.
 */
function scanImports(code: string): Set<string> {
  const body = code.replace(/(?:"""|''')[\s\S]*?(?:"""|''')/g, " ");
  const mods = new Set<string>();
  const re = /^[ \t]*(?:from[ \t]+([A-Za-z_][\w.]*)[ \t]+import\b|import[ \t]+([A-Za-z_][\w.]*(?:[ \t]*,[ \t]*[A-Za-z_][\w.]*)*))/gm;
  for (const m of body.matchAll(re)) {
    const from = m[1];
    if (from) {
      mods.add(from.split(".")[0]);
      continue;
    }
    for (const part of (m[2] ?? "").split(",")) {
      const top = part.trim().split(".")[0];
      if (top) mods.add(top);
    }
  }
  return mods;
}

/**
 * Packages a JS/TS file imports (`import … from "x"`, `import "x"`, `require("x")`,
 * `import("x")`). Relative paths are skipped; `@scope/pkg/sub` → `@scope/pkg`,
 * `pkg/sub` → `pkg`, `node:fs` → `fs`. Comments are stripped first so a commented-out
 * import is not proof.
 */
function scanJsImports(code: string): Set<string> {
  const body = code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const mods = new Set<string>();
  const add = (spec: string) => {
    const s = spec.trim().replace(/^node:/, "");
    if (!s || s.startsWith(".") || s.startsWith("/")) return;
    const parts = s.split("/");
    mods.add(s.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
  };
  for (const m of body.matchAll(/^[ \t]*import\s+(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']/gm)) add(m[1]);
  for (const m of body.matchAll(/^[ \t]*export\s+[\w*{}\s,$]+\s+from\s+["']([^"']+)["']/gm)) add(m[1]);
  for (const m of body.matchAll(/\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g)) add(m[1]);
  return mods;
}

/**
 * Java / Kotlin / C# imports, as every dotted prefix of two or more segments, so the
 * catalogue can name `org.openqa.selenium` or `org.springframework` and match
 * `import org.openqa.selenium.WebDriver;`. C# `using X.Y;` is read the same way, and a
 * single-segment namespace (`using System;`) is kept whole.
 */
function scanJvmImports(code: string): Set<string> {
  const mods = new Set<string>();
  const re = /^[ \t]*(?:import(?:[ \t]+static)?|using)[ \t]+([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)(?:\.\*)?[ \t]*;?[ \t]*$/gm;
  for (const m of code.matchAll(re)) {
    const parts = m[1].split(".");
    if (parts.length === 1) mods.add(parts[0]);
    for (let i = 2; i <= parts.length; i++) mods.add(parts.slice(0, i).join("."));
  }
  return mods;
}

/** Dart `import 'package:flutter/material.dart';` → `flutter`. */
function scanDartImports(code: string): Set<string> {
  const mods = new Set<string>();
  for (const m of code.matchAll(/^[ \t]*import\s+["']package:([\w]+)\//gm)) mods.add(m[1]);
  return mods;
}

/**
 * A Go module path's root — hosting domain + owner + repo for github.com-style hosts, domain +
 * one segment otherwise — so `github.com/redis/go-redis/v9/internal` is `github.com/redis/go-redis`
 * whatever the major-version suffix. Standard-library paths ("net/http") are returned whole.
 */
function goModuleRoot(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (!parts.length || !parts[0].includes(".")) return path;
  const depth = /^(?:github\.com|gitlab\.com|bitbucket\.org|golang\.org|codeberg\.org)$/.test(parts[0]) ? 3 : 2;
  return parts.slice(0, depth).join("/");
}

/** Go `import "fmt"`, `import x "a/b"` and `import ( … )` blocks → each path and its module root, lower-cased. */
function scanGoImports(code: string): Set<string> {
  const mods = new Set<string>();
  const add = (spec: string) => {
    const path = spec.trim().toLowerCase();
    if (!path) return;
    mods.add(path);
    mods.add(goModuleRoot(path));
  };
  for (const m of code.matchAll(/^[ \t]*import[ \t]+(?:[\w.]+[ \t]+)?"([^"\n]+)"/gm)) add(m[1]);
  for (const block of code.matchAll(/^[ \t]*import[ \t]*\(([^)]*)\)/gm)) {
    for (const m of block[1].matchAll(/^[ \t]*(?:[\w.]+[ \t]+)?"([^"\n]+)"/gm)) add(m[1]);
  }
  return mods;
}

/** Rust `use crate_name::…;` / `extern crate x;` → the crate (std, core, alloc, crate, self, super excluded). */
function scanRustImports(code: string): Set<string> {
  const mods = new Set<string>();
  const local = new Set(["std", "core", "alloc", "crate", "self", "super"]);
  for (const m of code.matchAll(/^[ \t]*(?:pub(?:\([^)\n]*\))?[ \t]+)?(?:use[ \t]+(?:::)?|extern[ \t]+crate[ \t]+)([A-Za-z_]\w*)/gm)) {
    const crate = m[1].toLowerCase();
    if (!local.has(crate)) mods.add(crate);
  }
  return mods;
}

/** PHP `use Vendor\Package\Class;` → `vendor` and `vendor\package`, lower-cased. */
function scanPhpImports(code: string): Set<string> {
  const mods = new Set<string>();
  for (const m of code.matchAll(/^[ \t]*use[ \t]+(?:function[ \t]+|const[ \t]+)?\\?([A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*)/gm)) {
    const parts = m[1].toLowerCase().split("\\");
    mods.add(parts[0]);
    if (parts.length > 1) mods.add(parts.slice(0, 2).join("\\"));
  }
  return mods;
}

/** Ruby `require "x/y"` → `x/y` and `x` (`require_relative` is the project's own code). */
function scanRubyImports(code: string): Set<string> {
  const mods = new Set<string>();
  for (const m of code.matchAll(/^[ \t]*require[ \t]*\(?[ \t]*["']([^"'\n]+)["']/gm)) {
    const path = m[1].trim().toLowerCase();
    mods.add(path);
    mods.add(path.split("/")[0]);
  }
  return mods;
}

/** Swift `import SwiftUI` / `@testable import X` / `import struct X.Y` → the module, lower-cased. */
function scanSwiftImports(code: string): Set<string> {
  const mods = new Set<string>();
  for (const m of code.matchAll(/^[ \t]*(?:@testable[ \t]+)?import[ \t]+(?:(?:class|struct|enum|protocol|func|var|let|typealias)[ \t]+)?([A-Za-z_]\w*)/gm)) {
    mods.add(m[1].toLowerCase());
  }
  return mods;
}

/** C / C++ `#include <lib/header.h>` → the header path and its first segment (`hiredis/hiredis.h` → `hiredis`). */
function scanCIncludes(code: string): Set<string> {
  const mods = new Set<string>();
  for (const m of code.matchAll(/^[ \t]*#[ \t]*include[ \t]*<([^>\n]+)>/gm)) {
    const path = m[1].trim().toLowerCase();
    mods.add(path);
    mods.add(path.split("/")[0].replace(/\.h(?:pp|h|xx)?$/, ""));
  }
  return mods;
}

/** The import scanner for a source file, chosen by extension. */
function importsOf(path: string, code: string): Set<string> {
  if (/\.(?:py|ipynb)$/i.test(path)) return scanImports(code);
  if (/\.(?:[cm]?jsx?|tsx?|vue)$/i.test(path)) return scanJsImports(code);
  if (/\.(?:java|kt|kts|cs)$/i.test(path)) return scanJvmImports(code);
  if (/\.dart$/i.test(path)) return scanDartImports(code);
  if (/\.go$/i.test(path)) return scanGoImports(code);
  if (/\.rs$/i.test(path)) return scanRustImports(code);
  if (/\.php$/i.test(path)) return scanPhpImports(code);
  if (/\.rb$/i.test(path)) return scanRubyImports(code);
  if (/\.swift$/i.test(path)) return scanSwiftImports(code);
  if (/\.(?:c|cc|cpp|cxx|h|hpp|hh|hxx)$/i.test(path)) return scanCIncludes(code);
  return new Set();
}

/** Concatenate a notebook's CODE cells only — `outputs` (stack traces, logs) are ignored. */
function notebookCode(text: string): string {
  try {
    const nb = JSON.parse(text) as { cells?: { cell_type?: string; source?: string[] | string }[] };
    const parts: string[] = [];
    for (const cell of nb.cells ?? []) {
      if (cell.cell_type !== "code") continue;
      parts.push(Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? ""));
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

// ── Per-repo evidence collection ────────────────────────────────────────────

interface Hit {
  family: Family;
  weight: number;
  source: string;
  detail: string;
  /** True when the hit is only a package that DEPENDS on the tech (capped at 0.60). */
  derivative: boolean;
}

/** Everything read out of one repo, ready for scoring. */
interface RepoCorpus {
  /** Declared dependency name → the manifest it came from. */
  manifestDeps: Map<string, { file: string; lowTrust: boolean }>;
  /** Imported module / package → the file it was imported in. */
  imports: Map<string, string>;
  /** Concatenated source (any language) for call-site matching. */
  code: string;
  /** Concatenated Dockerfile / compose / workflow / Procfile content. */
  infraText: string;
  /** Every path in the tree, vendored / build directories excluded. */
  paths: string[];
  /** `paths` minus cross-platform app shells — path evidence for techs with `ignoreAppShells`. */
  appPaths: string[];
  /** Lowercased topics + description + README, for metadata-tier hits only. */
  metaText: string;
  /** Lowercased topics alone (worth slightly more than prose). */
  topicText: string;
  /** Total bytes of hand-written source code (any language) in the tree. */
  srcBytes: number;
  /** Count of hand-written source files. */
  srcFiles: number;
  /** Count of notebooks. */
  notebooks: number;
  /** Total blob count (used for the single-dump heuristic). */
  fileCount: number;
  /** The root-most README as written (≤ 20 000 chars) — deploy links live here. */
  readme: string;
}

/** Dependency manifests read for declared-dependency evidence (the original set — see pickBlobs). */
const BASE_MANIFEST_RE =
  /^(?:requirements[\w.-]*\.txt|pyproject\.toml|Pipfile|environment\.ya?ml|setup\.py|package\.json|pom\.xml|build\.gradle(?:\.kts)?|pubspec\.yaml)$/i;
/** Manifests of the languages added later: Go, Rust, PHP, Ruby, Swift / iOS, C/C++. */
const ADDED_MANIFEST_RE = /^(?:go\.mod|Cargo\.toml|composer\.json|Gemfile|Package\.swift|Podfile|vcpkg\.json|conanfile\.txt)$/i;
/** Every manifest readManifest understands. */
const MANIFEST_RE = new RegExp(`${BASE_MANIFEST_RE.source}|${ADDED_MANIFEST_RE.source}`, "i");
/** The Python manifests — the only ones a `pip freeze` / bloat dump can hide in. */
const PY_MANIFEST_RE = /^(?:requirements[\w.-]*\.txt|pyproject\.toml|Pipfile|environment\.ya?ml|setup\.py)$/i;
/** Hand-written source code worth reading for imports and call sites (the original languages — see pickBlobs). */
const BASE_SOURCE_RE = /\.(?:py|[cm]?jsx?|tsx?|vue|java|kt|dart|cs|go)$/i;
/** Source in the languages added later: Rust, C/C++, PHP, Ruby, Swift, Terraform. */
const ADDED_SOURCE_RE = /\.(?:rs|c|cc|cpp|cxx|h|hpp|hh|hxx|php|rb|swift|tf)$/i;
/**
 * Vendored dependencies and build output. Students often commit node_modules or a
 * venv; those files are someone else's code and must never count as evidence.
 */
const VENDORED_RE =
  /(?:^|\/)(?:node_modules|bower_components|vendor|venv|\.venv|site-packages|__pycache__|dist|build|out|\.next|\.nuxt|target|\.gradle|Pods|coverage)\//i;
/** Generated / minified / config files: present in every project, prove nothing. */
const LOW_SIGNAL_SOURCE_RE =
  /(?:\.min\.[cm]?js|\.d\.ts|(?:^|\/)(?:[\w.-]+\.config\.[cm]?[jt]s|setupTests\.[jt]s|reportWebVitals\.[jt]s|serviceWorker\.[jt]s|manage\.py|__init__\.py))$/i;
/** Generated files in the added languages: protobuf output, Rails' schema dump, Flutter's plugin registrant. */
const ADDED_LOW_SIGNAL_RE = /(?:\.pb\.(?:cc|h)|(?:^|\/)db\/schema\.rb|(?:^|\/)generated_plugin_registrant\.(?:cc|h|swift))$/i;
/** Likely entrypoints / core modules, read before anything else. */
const ENTRY_RE =
  /(?:^|\/)(?:main|app|index|server|api|routes?|train|model|models|inference|predict|pipeline|controller|service)\.(?:py|[cm]?jsx?|tsx?|java|kt|dart|cs|go|rs|c|cc|cpp|php|rb|swift|tf)$|(?:Controller|Service|Application|Activity)\.(?:java|kt|php)$|(?:^|\/)(?:lib\.rs|ContentView\.swift|\w+App\.swift|\w+_controller\.rb|web\.php)$/i;
/** Test sources — the direct proof for QA / testing domains. */
const TEST_RE =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.py$|Tests?\.(?:java|kt|cs)$|(?:^|\/)(?:tests?|__tests__|cypress|e2e)\/[^/]+\.(?:py|[cm]?[jt]sx?|java)$|_test\.go$|(?:^|\/)tests\/[^/]+\.rs$|Test\.php$|_(?:spec|test)\.rb$|Tests?\.swift$)/i;

/** Extra file reads per repo for the added languages — on top of, never instead of, the original ones. */
const ADDED_LANGUAGE_BLOBS = 4;
/** Byte allowance for those extra reads. */
const ADDED_LANGUAGE_BYTES = 160 * 1024;

/**
 * Is a path inside a cross-platform app's generated platform shell — the ios/, android/,
 * macos/, linux/, windows/ or web/ folder next to a Flutter pubspec.yaml or a React Native /
 * Capacitor package.json, at any depth ("ios/…", "app/macos/…", "example/ios/…")? Template
 * code, not the candidate's, so the languages added later never take evidence from it.
 */
function appShellTest(paths: string[]): (path: string) => boolean {
  const roots = new Set(
    paths.filter((p) => /(?:^|\/)(?:pubspec\.yaml|package\.json)$/i.test(p)).map((p) => p.slice(0, p.lastIndexOf("/") + 1)),
  );
  if (!roots.size) return () => false;
  const shells = new RegExp(`^(?:${[...roots].map(escapeRe).join("|")})(?:ios|android|macos|linux|windows|web)/`, "i");
  return (path) => shells.test(path);
}

/**
 * Choose which blobs to read. Manifests first (they are small and decisive), then infra
 * config, then the most likely entrypoint sources (with one test file, when the repo has
 * tests), then one notebook, then the README.
 */
function pickBlobs(entries: GhTreeEntry[]): GhTreeEntry[] {
  const own = entries.filter((e) => e.type === "blob" && !VENDORED_RE.test(e.path));
  const blobs = own.filter((e) => (e.size ?? 0) <= MAX_BLOB_BYTES);
  const base = (p: string): string => p.split("/").pop() ?? p;
  const depth = (p: string): number => p.split("/").length;

  // Shallowest manifests first: the root package.json / pom.xml describes the project.
  const manifests = blobs.filter((e) => BASE_MANIFEST_RE.test(base(e.path))).sort((a, b) => depth(a.path) - depth(b.path));
  const infra = blobs.filter(
    (e) =>
      /^(?:Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|Procfile)$/i.test(base(e.path)) ||
      /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(e.path),
  );

  const entryFirst = (a: GhTreeEntry, b: GhTreeEntry): number => {
    const pa = ENTRY_RE.test(a.path) ? 0 : 1;
    const pb = ENTRY_RE.test(b.path) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const da = depth(a.path);
    const db = depth(b.path);
    if (da !== db) return da - db;
    return (b.size ?? 0) - (a.size ?? 0);
  };
  const sources = blobs.filter((e) => BASE_SOURCE_RE.test(e.path) && !LOW_SIGNAL_SOURCE_RE.test(e.path) && (e.size ?? 0) >= 80);
  const tests = sources.filter((e) => TEST_RE.test(e.path));
  const code = sources.filter((e) => !TEST_RE.test(e.path)).sort(entryFirst);
  const sourcePick = tests.length ? [...code.slice(0, 3), tests[0]] : code.slice(0, 4);

  // Notebooks embed their plots, so a real one is often 1-5 MB — far over the per-blob
  // cap, which used to leave notebook-only ML repos with no evidence at all. They get
  // their own size cap and do not count against the repo's byte budget (raw reads are
  // free); only the code cells are parsed. Shallowest first, then largest; a repo with
  // no other source gets two.
  const notebooks = own
    .filter((e) => /\.ipynb$/i.test(e.path) && (e.size ?? 0) <= MAX_NOTEBOOK_BYTES)
    .sort((a, b) => depth(a.path) - depth(b.path) || (b.size ?? 0) - (a.size ?? 0))
    .slice(0, sourcePick.length ? 1 : 2);
  const readme = blobs
    .filter((e) => /^README[^/]*$/i.test(base(e.path)))
    .sort((a, b) => depth(a.path) - depth(b.path))
    .slice(0, 1);

  const ordered = [...manifests.slice(0, 3), ...infra.slice(0, 2), ...sourcePick, ...notebooks, ...readme];

  const picked: GhTreeEntry[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const e of ordered) {
    if (picked.length >= MAX_BLOBS_PER_REPO) break;
    if (seen.has(e.path)) continue;
    const isNotebook = /\.ipynb$/i.test(e.path);
    if (!isNotebook && bytes + (e.size ?? 0) > MAX_TOTAL_BLOB_BYTES) continue;
    seen.add(e.path);
    if (!isNotebook) bytes += e.size ?? 0;
    picked.push(e);
  }

  // The languages added later (Go modules, Rust, C/C++, PHP, Ruby, Swift, Terraform) are read
  // AFTER all of the above, in extra slots with their own byte allowance — so supporting a new
  // language never changes which files are read for a repo in the original ones.
  const inShell = appShellTest(own.map((e) => e.path));
  const ownCode = (e: GhTreeEntry) => !inShell(e.path) && !ADDED_LOW_SIGNAL_RE.test(e.path);
  const addedManifests = blobs
    .filter((e) => ADDED_MANIFEST_RE.test(base(e.path)) && ownCode(e))
    .sort((a, b) => depth(a.path) - depth(b.path))
    .slice(0, 2);
  const addedSources = blobs.filter(
    (e) => ADDED_SOURCE_RE.test(e.path) && ownCode(e) && !LOW_SIGNAL_SOURCE_RE.test(e.path) && (e.size ?? 0) >= 80,
  );
  const addedTests = addedSources.filter((e) => TEST_RE.test(e.path));
  const addedCode = addedSources.filter((e) => !TEST_RE.test(e.path)).sort(entryFirst);
  const addedPick = addedTests.length ? [...addedCode.slice(0, 3), addedTests[0]] : addedCode.slice(0, 4);
  let addedBytes = 0;
  for (const e of [...addedManifests, ...addedPick]) {
    if (picked.length >= MAX_BLOBS_PER_REPO + ADDED_LANGUAGE_BLOBS) break;
    if (seen.has(e.path) || addedBytes + (e.size ?? 0) > ADDED_LANGUAGE_BYTES) continue;
    seen.add(e.path);
    addedBytes += e.size ?? 0;
    picked.push(e);
  }
  return picked;
}

/** Read the selected blobs (free) and fold them into a scoreable corpus. */
async function buildCorpus(meta: GhRepoMeta, owner: string, entries: GhTreeEntry[], token: string): Promise<RepoCorpus> {
  const own = entries.filter((e) => e.type === "blob" && !VENDORED_RE.test(e.path));
  const paths = own.map((e) => e.path);
  // Code size: a repo with code in the original languages keeps exactly its original measure;
  // a repo written only in an added language (Rust, C/C++, PHP, Ruby, Swift …) is measured by that.
  const baseSrc = own.filter((e) => BASE_SOURCE_RE.test(e.path) && !LOW_SIGNAL_SOURCE_RE.test(e.path));
  const inShell = appShellTest(paths);
  const srcEntries = baseSrc.length
    ? baseSrc
    : own.filter(
        (e) => ADDED_SOURCE_RE.test(e.path) && !LOW_SIGNAL_SOURCE_RE.test(e.path) && !ADDED_LOW_SIGNAL_RE.test(e.path) && !inShell(e.path),
      );

  const corpus: RepoCorpus = {
    manifestDeps: new Map(),
    imports: new Map(),
    code: "",
    infraText: "",
    paths,
    appPaths: paths.filter((p) => !inShell(p)),
    metaText: "",
    topicText: (meta.topics ?? []).join(" ").toLowerCase(),
    srcBytes: srcEntries.reduce((s, e) => s + (e.size ?? 0), 0),
    srcFiles: srcEntries.length,
    notebooks: own.filter((e) => /\.ipynb$/i.test(e.path)).length,
    fileCount: paths.length,
    readme: "",
  };

  const picked = pickBlobs(entries);
  const files = await mapPool(picked, RAW_CONCURRENCY, async (entry) => ({
    path: entry.path,
    text: await rawFile(owner, meta.name, entry.path, token),
  }));

  const codeParts: string[] = [];
  const infraParts: string[] = [];
  const metaParts: string[] = [(meta.topics ?? []).join(" "), meta.description ?? ""];

  for (const f of files) {
    if (!f || !f.text) continue;
    const base = f.path.split("/").pop() ?? f.path;

    if (MANIFEST_RE.test(base)) {
      const read = readManifest(f.path, f.text);
      for (const dep of read.deps) {
        if (!corpus.manifestDeps.has(dep)) corpus.manifestDeps.set(dep, { file: f.path, lowTrust: read.lowTrust });
      }
      continue;
    }
    if (/^(?:Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|Procfile)$/i.test(base) || /^\.github\/workflows\//i.test(f.path)) {
      infraParts.push(f.text);
      continue;
    }
    if (/^README/i.test(base)) {
      metaParts.push(f.text.slice(0, 20_000));
      if (!corpus.readme) corpus.readme = f.text.slice(0, 20_000);
      continue;
    }
    const code = /\.ipynb$/i.test(f.path) ? notebookCode(f.text) : f.text;
    codeParts.push(code);
    for (const mod of importsOf(f.path, code)) {
      if (!corpus.imports.has(mod)) corpus.imports.set(mod, f.path);
    }
  }

  corpus.code = codeParts.join("\n");
  corpus.infraText = infraParts.join("\n");
  corpus.metaText = metaParts.join(" ").toLowerCase();

  // Bloat rule, second pass now that imports are known: many declared Python deps that
  // the scanned code never imports. Not applied to package.json / pom.xml — only a few
  // files are read, so a real JS/Java project would always look "unused".
  const declared = [...corpus.manifestDeps.entries()].filter(([, info]) => PY_MANIFEST_RE.test(info.file.split("/").pop() ?? ""));
  if (declared.length >= 40) {
    const importedNames = new Set([...corpus.imports.keys()].map((m) => canon(m)));
    const used = declared.filter(([d]) => importedNames.has(d) || importedNames.has(canon(DIST_ALIAS[d] ?? d)));
    if (used.length / declared.length < 0.25) {
      for (const [dep, info] of declared) corpus.manifestDeps.set(dep, { ...info, lowTrust: true });
    }
  }

  return corpus;
}

/** Confidence for one technology in one repo, plus the hits that justify it. */
interface TechScore {
  conf: number;
  hits: Hit[];
  /** True when at least one non-metadata (T1-T4) family produced evidence. */
  hard: boolean;
}

/** Grade one technology against one repo's corpus using the evidence-tier ladder. */
function scoreTech(def: TechDef, corpus: RepoCorpus): TechScore {
  const hits: Hit[] = [];
  const thin = corpus.srcFiles < 3 && corpus.srcBytes < 4096 && corpus.notebooks === 0;
  const paths = def.ignoreAppShells ? corpus.appPaths : corpus.paths;

  // T2 — declared in a manifest (exact canonical equality; never substring).
  for (const dist of def.dists ?? []) {
    const found = corpus.manifestDeps.get(canon(dist));
    if (!found) continue;
    let weight = found.lowTrust ? W_MANIFEST_LOW_TRUST : W_MANIFEST;
    if (thin) weight = Math.min(weight, CAP_THIN_REPO_MANIFEST);
    hits.push({
      family: "manifest",
      weight,
      source: `manifest:${found.file}`,
      detail: `${dist} declared in ${found.file}${found.lowTrust ? " (bulk pip-freeze — discounted)" : ""}`,
      derivative: false,
    });
  }
  // T5 — a package that merely depends on the target.
  for (const dist of def.derived ?? []) {
    const found = corpus.manifestDeps.get(canon(dist));
    if (!found) continue;
    hits.push({
      family: "manifest",
      weight: Math.min(found?.lowTrust ? W_MANIFEST_LOW_TRUST : W_MANIFEST, CAP_DERIVATIVE),
      source: `manifest:${found?.file ?? "manifest"}`,
      detail: `${dist} (depends on ${def.label}) in ${found?.file ?? "manifest"}`,
      derivative: true,
    });
  }

  // T1 — the code actually imports it, or calls its API.
  for (const mod of def.modules ?? []) {
    const file = corpus.imports.get(mod);
    if (!file) continue;
    hits.push({ family: "code", weight: W_CODE, source: `code:${file}`, detail: `import ${mod} in ${file}`, derivative: false });
  }
  for (const call of def.calls ?? []) {
    const m = corpus.code.match(call);
    if (!m) continue;
    hits.push({ family: "code", weight: W_CODE, source: "code", detail: snippet(m[0]), derivative: false });
    break; // one call-site quote is enough; more would just pad the report
  }

  // T3 — infra config. For Docker/CI the config file IS the proof; elsewhere it corroborates.
  for (const re of def.infraPaths ?? []) {
    const p = paths.find((path) => re.test(path));
    if (!p) continue;
    hits.push({ family: "infra", weight: W_INFRA_PROOF, source: "tree", detail: `${p} present`, derivative: false });
    break;
  }
  for (const re of def.infraText ?? []) {
    const m = corpus.infraText.match(re);
    if (!m) continue;
    hits.push({ family: "infra", weight: W_INFRA_CORROBORATION, source: "infra", detail: snippet(m[0]), derivative: false });
    break;
  }

  // T4 — artifacts left behind by the tech.
  for (const re of def.strongArtifactPaths ?? []) {
    const p = paths.find((path) => re.test(path));
    if (!p) continue;
    hits.push({ family: "artifact", weight: W_ARTIFACT_STRONG, source: "tree", detail: `${p} committed`, derivative: false });
    break;
  }
  for (const re of def.artifactPaths ?? []) {
    const p = paths.find((path) => re.test(path));
    if (!p) continue;
    hits.push({ family: "artifact", weight: W_ARTIFACT, source: "tree", detail: `${p} in repo`, derivative: false });
    break;
  }

  // T6 — topics / description / README. Never enough on its own for a mandatory tech.
  for (const word of def.meta ?? []) {
    if (mentions(corpus.topicText, word)) {
      hits.push({ family: "meta", weight: W_META_TOPIC, source: "topics", detail: `topic "${word}"`, derivative: false });
      break;
    }
    if (mentions(corpus.metaText, word)) {
      hits.push({ family: "meta", weight: W_META_TEXT, source: "readme", detail: `"${word}" in README/description`, derivative: false });
      break;
    }
  }

  if (hits.length === 0) return { conf: 0, hits: [], hard: false };

  const families = new Set(hits.map((h) => h.family));
  const maxWeight = hits.reduce((m, h) => Math.max(m, h.weight), 0);
  let conf = clamp01(maxWeight + 0.15 * (families.size - 1));
  if (hits.every((h) => h.derivative)) conf = Math.min(conf, CAP_DERIVATIVE);
  if (hits.every((h) => h.family === "meta")) conf = Math.min(conf, CAP_META_ONLY);

  return { conf, hits, hard: hits.some((h) => h.family !== "meta") };
}

/**
 * Ceiling penalty for a mandatory technology. This is what makes "missing a mandatory
 * technology ⇒ never a perfect match" structural rather than a weighting accident:
 * a repo at 0.74 confidence on any mandatory tech is capped at 94, not 100.
 */
function ceilingPenalty(conf: number): number {
  if (conf >= 0.75) return 0;
  if (conf >= 0.5) return 6;
  if (conf >= 0.15) return 14;
  return 22;
}

/** One technology's confidence as the scorer sees it (for one repo, or rolled up for the profile). */
interface TechConf {
  def: TechDef;
  conf: number;
  /** Backed by code / manifest / config / artifacts — not just topics or README prose. */
  hard: boolean;
  mandatory: boolean;
}

/**
 * The technologies that can make a repo domain-relevant: the mandatory ones plus the
 * named frameworks / tools. Plain languages (Python, JavaScript, Java, HTML/CSS …) only
 * qualify when the domain names nothing more specific — otherwise every Python repo
 * would be an "AI/ML project" and every JavaScript repo a "full-stack project".
 */
function coreKeys(mandatory: TechDef[], goodToHave: TechDef[]): Set<string> {
  const all = [...mandatory, ...goodToHave];
  const specific = all.filter((d) => !d.generic);
  return new Set((specific.length ? specific : all).map((d) => d.key));
}

/** A repo (or profile) proves the domain when a core technology is backed by real evidence. */
function provesDomain(confs: TechConf[], core: Set<string>): boolean {
  return confs.some((t) => core.has(t.def.key) && t.hard && t.conf >= HIT_CONF);
}

/**
 * The 0-100 domain score, used for a single repo and for the whole profile:
 *
 *   strength  best core-technology confidence (a plain language counts at half);
 *             with mandatory technologies, half of it is their mean coverage
 *   coverage  mean of the best three core-technology confidences — several of the
 *             domain's technologies proven, not one
 *   breadth   weight-averaged confidence over EVERY technology the domain names
 *   depth     caller-supplied 0-1 (profile: domain projects, recency, code size;
 *             repo: code size)
 *
 *   score = 35·strength + 25·coverage + 15·breadth + 25·depth
 *
 * then capped at META_ONLY_SCORE_CAP when nothing is backed by more than topics /
 * README prose, and by `100 − Σ pen(mandatory)` so a weakly-proven mandatory
 * technology can never be bought back by good-to-haves. 0 when the domain names no
 * technology this module models.
 */
function domainScore(confs: TechConf[], core: Set<string>, depth: number): number {
  if (confs.length === 0) return 0;
  const credit = (t: TechConf) => (core.has(t.def.key) ? t.conf : t.def.generic ? t.conf * GENERIC_DISCOUNT : 0);
  const best = confs.reduce((m, t) => Math.max(m, credit(t)), 0);

  const mandatory = confs.filter((t) => t.mandatory);
  const mcov = mandatory.length ? mandatory.reduce((s, t) => s + t.conf, 0) / mandatory.length : 0;
  const strength = mandatory.length ? 0.5 * best + 0.5 * mcov : best;

  const coreConfs = confs
    .filter((t) => core.has(t.def.key))
    .map((t) => t.conf)
    .sort((a, b) => b - a);
  const k = Math.min(COVERAGE_TOP_K, coreConfs.length);
  const coverage = k ? coreConfs.slice(0, k).reduce((s, c) => s + c, 0) / k : 0;

  const totalW = confs.reduce((s, t) => s + t.def.weight, 0);
  const breadth = totalW > 0 ? confs.reduce((s, t) => s + t.def.weight * t.conf, 0) / totalW : 0;

  if (best === 0 && mcov === 0) return 0;
  // Size and recency only count in proportion to real domain evidence — a big repo that
  // proves nothing about the domain earns nothing for being big.
  const evidence = Math.min(1, best / HIT_CONF);
  let score = 35 * strength + 25 * coverage + 15 * breadth + 25 * clamp01(depth) * evidence;
  if (!confs.some((t) => t.hard && t.conf > 0)) score = Math.min(score, META_ONLY_SCORE_CAP);
  const ceiling = 100 - mandatory.reduce((s, t) => s + ceilingPenalty(t.conf), 0);
  return clamp100(Math.min(score, ceiling));
}

/** Code size → 0-1: about 40 KB of hand-written source (a notebook counts ~3 KB) is a full project. */
function substanceOf(corpus: RepoCorpus | null): number {
  return corpus ? clamp01((corpus.srcBytes + 3000 * corpus.notebooks) / 40_000) : 0;
}

// ── AI-authorship signal catalogue ──────────────────────────────────────────

/**
 * TIER A1 — vendor machine identities. These are EMAIL addresses, never display names:
 * "Claude", "Jules", "Cursor" and "Bolt" are all real human/org GitHub accounts that
 * predate the tools, and bare-name matching is the single largest source of false
 * accusation. Anchoring on the vendor-controlled domain is what makes this tier safe.
 */
const AI_EMAIL_TOOLS: { tool: string; re: RegExp }[] = [
  { tool: "Claude Code", re: /(?:noreply|claude|assistant)@anthropic\.com/i },
  { tool: "Cursor Agent", re: /cursoragent@cursor\.com/i },
  { tool: "Replit Agent", re: /agent@replit\.com/i },
  { tool: "OpenAI Codex", re: /(?:noreply|codex|chatgpt)@openai\.com/i },
  { tool: "Aider", re: /aider@aider\.chat/i },
  { tool: "OpenHands", re: /(?:openhands|contact)@all-hands\.dev/i },
  { tool: "JetBrains Junie", re: /junie@jetbrains\.com/i },
  { tool: "Trae", re: /(?:traecli|noreply)@bytedance\.com/i },
  { tool: "Zed Agent", re: /agent@zed\.dev|@zed\.agent/i },
  { tool: "Kiro", re: /kiro(?:-noreply|-agent)?@(?:aws\.)?amazon\.com/i },
  { tool: "Amp", re: /amp@ampcode\.com/i },
  { tool: "opencode", re: /noreply@opencode\.ai/i },
  { tool: "Crush", re: /crush@charm\.land/i },
  { tool: "Roo Code", re: /roomote@roocode\.com/i },
  { tool: "Cline", re: /cline@example\.com/i },
  { tool: "Windsurf", re: /cascade@windsurf\.ai/i },
  { tool: "Qwen Coder", re: /qwen-coder@alibabacloud\.com/i },
  { tool: "Sketch", re: /hello@sketch\.dev/i },
  { tool: "Warp", re: /noreply@warp\.dev/i },
  { tool: "Ona", re: /no-reply@ona\.com/i },
  { tool: "Letta", re: /noreply@letta\.com/i },
  { tool: "Mistral Vibe", re: /vibe@mistral\.ai/i },
  { tool: "Verdent", re: /(?:verdent|noreply)@verdent\.ai/i },
  { tool: "Abacus", re: /agent@abacus\.ai/i },
  { tool: "Fly.io agent", re: /dev@fly\.io/i },
  { tool: "Paperclip", re: /noreply@paperclip\.ing/i },
  { tool: "v0", re: /it\+v0agent@vercel\.com/i },
  // No official trailer (Oct 2026): agents asked to credit themselves use this address.
  { tool: "Google Antigravity", re: /antigravity@google\.com/i },
];

/**
 * TIER A3 — vendor-numbered `users.noreply.github.com` addresses. The numeric prefix is
 * the account id, which is what makes these unforgeable in practice.
 */
const AI_NOREPLY_ID: Record<string, string> = {
  "198982749": "GitHub Copilot coding agent",
  "158243242": "Devin",
  "161369871": "Google Jules",
  "199175422": "OpenAI Codex (cloud)",
  "176961590": "Gemini Code Assist",
  "208079219": "Amazon Q Developer",
  "159125892": "Lovable",
  "138933559": "Factory Droid",
  "151058649": "Qodo",
  "128439645": "Sweep",
  "136622811": "CodeRabbit",
};
const AI_NOREPLY_RE = /\b(\d{6,12})\+[^@\s]+@users\.noreply\.github\.com\b/i;

/**
 * TIER A2 — verified AI-agent GitHub logins. Note that `author.type === "Bot"` is
 * neither necessary nor sufficient: `replit-agent`, `cursoragent` and `openhands-agent`
 * are type "User", while `dependabot[bot]` is a Bot but is ordinary automation. The
 * allow-list is matched first, the exclusion list below is applied second.
 */
const AI_AGENT_LOGIN =
  /^(?:Copilot|copilot-swe-agent(?:\[bot\])?|devin-ai-integration\[bot\]|google-labs-jules\[bot\]|chatgpt-codex-connector\[bot\]|gemini-code-assist\[bot\]|amazon-q-developer\[bot\]|lovable-dev\[bot\]|gpt-engineer-app\[bot\]|factory-droid\[bot\]|openhands-(?:ai\[bot\]|agent)|all-hands-bot|qodo-code-review\[bot\]|coderabbitai\[bot\]|sweep-ai(?:-deprecated)?\[bot\]|replit-agent|cursoragent|claude\[bot\]|cursor\[bot\]|codegen-sh(?:\[bot\])?|seer-by-sentry|sentry-autofix\[bot\]|deepsource-autofix\[bot\]|sourcery-ai\[bot\]|gru-agent|roomote-agent|jetbrains-junie|open-swe|opencode-agent|abacus-ai-automation\[bot\]|v0)$/i;

/**
 * Ordinary CI / dependency / release robots. These are NOT AI authorship and are
 * filtered out before any share calculation — otherwise a well-maintained repo would
 * look AI-generated. `web-flow` is here because it is the committer on every
 * PR-merged and every web-UI commit on GitHub.
 */
const ORDINARY_AUTOMATION =
  /^(?:dependabot(?:-preview)?\[bot\]|renovate\[bot\]|github-actions\[bot\]|semantic-release-bot|release-please\[bot\]|mergify\[bot\]|kodiakhq\[bot\]|snyk-bot|vercel\[bot\]|imgbot(?:app)?|stainless-app\[bot\]|octo-sts\[bot\]|gcf-owl-bot\[bot\]|dotnet-maestro\[bot\]|microsoft-github-(?:policy|operations)-service\[bot\]|scala-steward.*|fern-api\[bot\]|allcontributors\[bot\]|pre-commit-ci\[bot\]|crowdin-bot|web-flow)$/i;

/**
 * TIER C — review-suggestion co-authorship. Clicking "Commit suggestion" on an AI
 * reviewer's comment makes GitHub add that bot as co-author of an `Update <file>`
 * commit whose code the human wrote. These can never exceed `medium`, and alone yield
 * `low`.
 */
const SUGGESTION_ACCEPT = /^Update [^\n]{1,120}\n\s*\n[ \t]*co-authored-by:/im;
const REVIEW_ONLY_BOT = /^(?:coderabbitai|qodo-code-review|sourcery-ai|deepsource-autofix|greptile-apps|cursor|gemini-code-assist|sentry-autofix)\[bot\]$/i;

/** Generic line-anchored trailer parser. The captured EMAIL is what gets classified. */
const TRAILER = /^[ \t]*(?:co-authored-by|assisted-by|generated-by|ai-assistant)[ \t]*:[ \t]*([^<\n]*?)[ \t]*(?:<[ \t]*([^>\s]+)[ \t]*>)?[ \t]*$/gim;

/** `Replit-Commit-Author: Agent` means the agent wrote it (Deployment/<user> do not). */
const REPLIT_AGENT = /^[ \t]*Replit-Commit-Author:[ \t]*Agent[ \t]*$/im;

/** Aider rewrites the git author NAME to "User Name (aider)" by default. */
const AIDER_NAME = /\(aider\)\s*$/i;

/**
 * TIER B body markers carrying no vendor email. Real signal, but one CLI flag from
 * being off and easy to paste into prose, so they are capped at `medium`.
 */
const BODY_MARKERS: { tool: string; re: RegExp }[] = [
  { tool: "Claude Code", re: /(?:🤖\s*)?Generated with \[?Claude Code\]?|^Claude-Session:\s*https:\/\/claude\.ai\/code\/session_\w+/im },
  { tool: "OpenAI Codex", re: /Generated with \[Codex\]\(https:\/\/openai\.com\/codex\/\)\.|Generated by Codex|\bcodex-cli\b|https:\/\/chatgpt\.com\/codex\//im },
  { tool: "Replit Agent", re: /Generated by Replit|^[ \t]*Replit-Commit-(?:Session-Id|Deployment-Build-Id):/im },
  { tool: "Lovable", re: /^Use tech stack vite_react_shadcn_ts$/im },
];

type CommitClass = "AGENT_AUTHORED" | "AGENT_TRAILERED" | "AGENT_MARKER" | "SUGGESTION" | "BOT" | "HUMAN";

interface CommitVerdict {
  cls: CommitClass;
  weight: number;
  /** Vendor tool name, when identified. */
  tool: string;
  /** The literal text that proved it — always quoted into signals[]. */
  quote: string;
}

/** Classify one commit against the rubric. Hard evidence first, then markers, then human. */
function classifyCommit(item: GhCommitItem, username: string): CommitVerdict {
  const message = item.commit?.message ?? "";
  const authorLogin = item.author?.login ?? "";
  const committerLogin = item.committer?.login ?? "";
  const authorEmail = item.commit?.author?.email ?? "";
  const committerEmail = item.commit?.committer?.email ?? "";
  const authorName = item.commit?.author?.name ?? "";

  // §4 — ordinary automation is filtered before anything else.
  if (
    (authorLogin && ORDINARY_AUTOMATION.test(authorLogin) && authorLogin.toLowerCase() !== "web-flow") ||
    (!authorLogin && committerLogin && ORDINARY_AUTOMATION.test(committerLogin) && committerLogin.toLowerCase() !== "web-flow")
  ) {
    return { cls: "BOT", weight: 0, tool: authorLogin || committerLogin, quote: `author ${authorLogin || committerLogin}` };
  }

  const suggestion = SUGGESTION_ACCEPT.test(message);

  // A2 — verified AI-agent login on the author (or committer, when the author is null).
  const agentLogin = [authorLogin, committerLogin].find((l) => l && AI_AGENT_LOGIN.test(l));
  if (agentLogin) {
    const reviewOnly = REVIEW_ONLY_BOT.test(agentLogin);
    if (reviewOnly || suggestion) {
      return { cls: "SUGGESTION", weight: 0.15, tool: agentLogin, quote: `review-suggestion co-author "${agentLogin}"` };
    }
    return { cls: "AGENT_AUTHORED", weight: 1, tool: agentLogin, quote: `commit authored by agent account "${agentLogin}"` };
  }

  // A1 / A3 — vendor AI email in the git author or committer identity.
  for (const email of [authorEmail, committerEmail]) {
    if (!email) continue;
    const vendor = AI_EMAIL_TOOLS.find((t) => t.re.test(email));
    if (vendor) return { cls: "AGENT_AUTHORED", weight: 1, tool: vendor.tool, quote: `git author email <${email}>` };
    const numbered = email.match(AI_NOREPLY_RE);
    const tool = numbered ? AI_NOREPLY_ID[numbered[1]] : undefined;
    if (tool) return { cls: "AGENT_AUTHORED", weight: 1, tool, quote: `git author email <${email}>` };
  }

  // Replit agent trailer and Aider's author-name suffix are also hard authorship.
  const replit = message.match(REPLIT_AGENT);
  if (replit) return { cls: "AGENT_AUTHORED", weight: 1, tool: "Replit Agent", quote: snippet(replit[0]) };
  if (AIDER_NAME.test(authorName)) {
    return { cls: "AGENT_AUTHORED", weight: 1, tool: "Aider", quote: `git author name "${authorName}"` };
  }

  // B — line-anchored trailer whose captured EMAIL is a vendor AI address.
  TRAILER.lastIndex = 0;
  for (const m of message.matchAll(TRAILER)) {
    const email = m[2] ?? "";
    if (!email) continue; // a bare display name is NOT evidence — it scores none
    const vendor = AI_EMAIL_TOOLS.find((t) => t.re.test(email));
    const numbered = email.match(AI_NOREPLY_RE);
    const tool = vendor?.tool ?? (numbered ? AI_NOREPLY_ID[numbered[1]] : undefined);
    if (!tool) continue;
    const quote = snippet(m[0]);
    if (suggestion || REVIEW_ONLY_BOT.test((m[1] ?? "").trim())) {
      return { cls: "SUGGESTION", weight: 0.15, tool, quote: `accepted review suggestion — ${quote}` };
    }
    return { cls: "AGENT_TRAILERED", weight: 0.8, tool, quote };
  }

  // B (weak) — body marker with no vendor email. Capped at medium by the mapper.
  for (const marker of BODY_MARKERS) {
    const m = message.match(marker.re);
    if (m) return { cls: "AGENT_MARKER", weight: 0.5, tool: marker.tool, quote: snippet(m[0]) };
  }

  // Everything else is human. `username` is unused here beyond scope filtering upstream.
  void username;
  return { cls: "HUMAN", weight: 0, tool: "", quote: "" };
}

/**
 * Map counts to a likelihood label. Only hard evidence (AGENT_AUTHORED /
 * AGENT_TRAILERED) can reach `high`; markers and behavioural signals top out at
 * `medium` and `low` respectively.
 */
function mapLikelihood(input: {
  hardCommits: number;
  markerCommits: number;
  suggestionCommits: number;
  aiShare: number;
  spread: number;
}): "none" | "low" | "medium" | "high" {
  const { hardCommits, markerCommits, suggestionCommits, aiShare, spread } = input;
  if (hardCommits >= 5 && aiShare >= 0.6 && spread >= 2) return "high";
  if (hardCommits >= 5 || markerCommits >= 5 || (hardCommits >= 1 && aiShare >= 0.25)) return "medium";
  if (hardCommits >= 1 || markerCommits >= 1 || suggestionCommits >= 1) return "low";
  return "none";
}

/** ISO date → "YYYY-Www", used as the "distinct calendar weeks" spread measure. */
function isoWeek(date: string): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${week}`;
}

/** Per-repo audit result plus the internal roll-up fodder the profile summary needs. */
interface CommitOutcome {
  audit: CommitAudit;
  /** Vendor tool → hard-evidence commit count, for the profile summary line. */
  tools: Map<string, number>;
  hardCommits: number;
  markerCommits: number;
  suggestionCommits: number;
  /** Denominator used for this repo's share (own, non-merge, non-automation commits). */
  shareDenom: number;
  aiWeight: number;
  weeks: Set<string>;
  /**
   * Newest commit that is the candidate's own: authored by their account (`linked`) or
   * by an unlinked git email in their repo — common with students. Bot and agent-account
   * commits are not theirs.
   */
  lastOwn: { date: string; linked: boolean } | null;
  /** Newest commit authored by the candidate's own GitHub account (linked) — the only proof they worked on someone else's repo. */
  lastLinked: string | null;
}

/** Empty audit — used for empty repos, 404s, and anything we ran out of budget for. */
function emptyAudit(): CommitOutcome {
  return {
    audit: {
      analyzed: 0,
      aiAttributed: 0,
      humanAuthored: 0,
      botAuthored: 0,
      bulkCommitRatio: 0,
      singleDumpRepo: false,
      signals: [],
      aiLikelihood: "none",
    },
    tools: new Map(),
    hardCommits: 0,
    markerCommits: 0,
    suggestionCommits: 0,
    shareDenom: 0,
    aiWeight: 0,
    weeks: new Set(),
    lastOwn: null,
    lastLinked: null,
  };
}

/**
 * Audit one repo's commit history.
 *
 * Filters applied first, in this order, because every downstream number is wrong
 * otherwise: merge commits are dropped (GitHub's squash-merge concatenates every branch
 * message, so one merged PR can carry 40 copies of an agent trailer); commits by other
 * contributors are dropped (we count the candidate's own work, or an agent's);
 * automation is counted separately and excluded from the share denominator.
 */
function auditCommits(items: GhCommitItem[], username: string, fileCount: number): CommitOutcome {
  const out = emptyAudit();
  const lower = username.toLowerCase();

  const nonMerge = items.filter((c) => (c.parents?.length ?? 1) <= 1);
  const dates: number[] = [];
  const signalLines: string[] = [];
  const quotedTools = new Set<string>();

  for (const item of nonMerge) {
    const verdict = classifyCommit(item, username);
    const authorLogin = (item.author?.login ?? "").toLowerCase();

    // Scope: the candidate's own commits, unlinked-email commits (author is null, which
    // is common and NOT an edge case), or an agent's. Other named contributors are out.
    const ownScope =
      !authorLogin ||
      authorLogin === lower ||
      verdict.cls === "AGENT_AUTHORED" ||
      verdict.cls === "AGENT_TRAILERED" ||
      verdict.cls === "AGENT_MARKER" ||
      verdict.cls === "BOT";
    if (!ownScope) continue;

    out.audit.analyzed += 1;
    const when = item.commit?.committer?.date ?? item.commit?.author?.date ?? "";
    if (when) {
      const ms = new Date(when).getTime();
      if (Number.isFinite(ms)) dates.push(ms);
    }

    // The candidate's own work: their account, or an unlinked email (author is null).
    const authored = item.commit?.author?.date ?? when;
    if (
      authored &&
      verdict.cls !== "BOT" &&
      verdict.cls !== "AGENT_AUTHORED" &&
      (authorLogin === lower || !authorLogin) &&
      (!out.lastOwn || Date.parse(authored) > Date.parse(out.lastOwn.date))
    ) {
      out.lastOwn = { date: authored, linked: authorLogin === lower };
    }
    if (authored && authorLogin === lower && (!out.lastLinked || Date.parse(authored) > Date.parse(out.lastLinked))) {
      out.lastLinked = authored;
    }

    if (verdict.cls === "BOT") {
      out.audit.botAuthored += 1;
      continue;
    }

    out.shareDenom += 1;
    out.aiWeight += verdict.weight;

    if (verdict.cls === "AGENT_AUTHORED" || verdict.cls === "AGENT_TRAILERED") {
      out.audit.aiAttributed += 1;
      out.hardCommits += 1;
      out.tools.set(verdict.tool, (out.tools.get(verdict.tool) ?? 0) + 1);
      const week = isoWeek(when);
      if (week) out.weeks.add(week);
      if (!quotedTools.has(verdict.tool)) {
        quotedTools.add(verdict.tool);
        signalLines.push(`${verdict.tool}: ${verdict.quote} (${item.sha.slice(0, 7)})`);
      }
    } else if (verdict.cls === "AGENT_MARKER") {
      out.markerCommits += 1;
      out.tools.set(verdict.tool, (out.tools.get(verdict.tool) ?? 0) + 1);
      if (!quotedTools.has(`marker:${verdict.tool}`)) {
        quotedTools.add(`marker:${verdict.tool}`);
        signalLines.push(`${verdict.tool} body marker (no vendor email): "${verdict.quote}" (${item.sha.slice(0, 7)})`);
      }
    } else if (verdict.cls === "SUGGESTION") {
      out.suggestionCommits += 1;
      if (!quotedTools.has(`suggestion:${verdict.tool}`)) {
        quotedTools.add(`suggestion:${verdict.tool}`);
        signalLines.push(`Accepted AI review suggestion (human-written code): ${verdict.quote} (${item.sha.slice(0, 7)})`);
      }
    }
  }

  out.audit.humanAuthored = Math.max(0, out.audit.analyzed - out.audit.aiAttributed - out.audit.botAuthored);

  // ── Behavioural signals — reported, but hard-capped at `low` by the mapper ──
  // Dense bursts are dominated by `git rebase`, which rewrites every committer.date to
  // "now", so this measures "history was rewritten or pushed at once", not authorship.
  dates.sort((a, b) => a - b);
  let bulk = 0;
  let runStart = 0;
  for (let i = 1; i <= dates.length; i++) {
    const contiguous = i < dates.length && dates[i] - dates[i - 1] <= 120_000;
    if (contiguous) continue;
    const runLength = i - runStart;
    if (runLength >= 4) bulk += runLength;
    runStart = i;
  }
  out.audit.bulkCommitRatio = out.audit.analyzed > 0 ? Number((bulk / out.audit.analyzed).toFixed(2)) : 0;
  out.audit.singleDumpRepo = out.audit.analyzed > 0 && out.audit.analyzed <= 2 && fileCount >= 25;

  if (out.audit.bulkCommitRatio >= 0.6 && out.audit.analyzed >= 5) {
    signalLines.push(
      `${bulk} of ${out.audit.analyzed} commits share timestamps within 2 minutes — consistent with a rebase, squash or one-shot push (behavioural only).`,
    );
  }
  if (out.audit.singleDumpRepo) {
    signalLines.push(
      `${out.audit.analyzed === 1 ? "The entire project" : "Nearly the whole project"} (${fileCount} files) landed in ${out.audit.analyzed} commit${out.audit.analyzed === 1 ? "" : "s"} — common for scaffolds and local-then-push work, so behavioural only.`,
    );
  }
  if (out.audit.botAuthored > 0) {
    signalLines.push(`${out.audit.botAuthored} commit(s) from ordinary CI/dependency automation — not counted as AI authorship.`);
  }

  const aiShare = out.shareDenom > 0 ? out.aiWeight / Math.max(out.shareDenom, MIN_SHARE_DENOM) : 0;
  out.audit.aiLikelihood = mapLikelihood({
    hardCommits: out.hardCommits,
    markerCommits: out.markerCommits,
    suggestionCommits: out.suggestionCommits,
    aiShare,
    spread: out.weeks.size,
  });
  out.audit.signals = signalLines.slice(0, 6);
  return out;
}

// ── Repo discovery ──────────────────────────────────────────────────────────

/** Extract `owner/repo` from a GitHub repository URL. */
function parseRepoRef(url: string): { owner: string; repo: string } | null {
  const m = (url ?? "").match(/github\.com\/([^/?#\s]+)\/([^/?#\s]+)/i);
  if (!m) return null;
  const owner = decodeURIComponent(m[1]);
  const repo = decodeURIComponent(m[2]).replace(/\.git$/i, "");
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * One page of owned repos (100 max), continuing only while GitHub's Link header says
 * there is more and we still have scan headroom. The old 3-page unconditional loop
 * spent up to 3 calls on every candidate, most of them for nothing. `status` is the
 * first page's HTTP status, so the caller can tell a missing user (404) or a rejected
 * token (401) from a profile that simply has no repos.
 */
async function listOwnedRepos(
  username: string,
  token: string,
  budget: CallBudget,
): Promise<{ repos: GhRepoMeta[]; status: number }> {
  const repos: GhRepoMeta[] = [];
  let status = 0;
  for (let page = 1; page <= 2; page++) {
    const res = await ghGet<GhRepoMeta[]>(
      `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&type=owner&sort=pushed&direction=desc&page=${page}`,
      token,
      budget,
    );
    if (page === 1) status = res.status;
    if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) break;
    repos.push(...res.data);
    if (res.data.length < 100 || repos.length >= REPO_SCAN_CAP) break;
  }
  return { repos, status };
}

/** Cheap metadata prescreen — used only to RANK repos, never to filter them out. */
function metadataRank(meta: GhRepoMeta, terms: string[]): number {
  const hay = [meta.name, meta.description ?? "", ...(meta.topics ?? []), meta.language ?? ""].join(" ").toLowerCase();
  return terms.reduce((s, t) => (t.length >= 3 && hay.includes(t) ? s + 1 : s), 0);
}

// ── Orchestration ───────────────────────────────────────────────────────────

/** Per-repo output plus the roll-up fodder the profile-level numbers need. */
interface RepoOutcome {
  analysis: RepoAnalysis;
  /** Technology key → confidence + whether any non-metadata evidence backed it. */
  techConf: Map<string, { conf: number; hard: boolean }>;
  /** Technology key → the strongest single finding behind it (empty when the repo isn't the candidate's work). */
  techHits: Map<string, { source: string; detail: string }>;
  commits: CommitOutcome;
  /** Substance term input for the Depth component. */
  substance: number;
  pushedAt: string;
}

/** Analyze one repository: tree → free blob reads → tech evidence → commit audit. */
async function analyzeRepo(
  meta: GhRepoMeta,
  owner: string,
  username: string,
  token: string,
  mandatory: TechDef[],
  goodToHave: TechDef[],
  core: Set<string>,
  budget: CallBudget,
): Promise<RepoOutcome | null> {
  const description = meta.description ?? "";
  const base: RepoAnalysis = {
    name: meta.name,
    url: meta.html_url,
    description,
    primaryLanguage: meta.language,
    stars: meta.stargazers_count ?? 0,
    createdAt: meta.created_at ?? "",
    pushedAt: meta.pushed_at ?? "",
    matchPct: 0,
    relevant: false,
    lastOwnCommit: null,
    mandatoryHit: [],
    mandatoryMissing: mandatory.map((d) => d.label),
    goodToHaveHit: [],
    evidence: [],
    commits: emptyAudit().audit,
  };

  // 1) Tree. `HEAD` is accepted as a ref by both the trees API and raw, so a non-standard
  //    default branch never needs a lookup. 409 = empty repo, 404 = gone. A very large repo
  //    (committed datasets / model weights) won't list recursively, so its top level is read
  //    instead — the root manifests, Dockerfile, README and entry files still prove the stack.
  let entries: GhTreeEntry[] = [];
  const veryLarge = (meta.size ?? 0) > TREE_SKIP_REPO_SIZE_KB;
  const tree = await ghGet<GhTree>(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(meta.name)}/git/trees/HEAD${veryLarge ? "" : "?recursive=1"}`,
    token,
    budget,
  );
  if (tree.ok && tree.data) {
    entries = Array.isArray(tree.data.tree) ? tree.data.tree : [];
    if (veryLarge) {
      base.evidence.push({ tech: "—", source: "tree", detail: "very large repository — only its top-level files were read" });
    } else if (tree.data.truncated) {
      // A truncated tree is still usable — we only ever read the first handful of
      // interesting paths — but the tail is genuinely missing, so say so in evidence.
      base.evidence.push({ tech: "—", source: "tree", detail: "repository tree truncated by GitHub; analysis is partial" });
    }
  } else if (tree.status === 409) {
    return { analysis: base, techConf: new Map(), techHits: new Map(), commits: emptyAudit(), substance: 0, pushedAt: base.pushedAt };
  }

  // 2) Free blob reads → evidence corpus.
  const corpus = entries.length > 0 ? await buildCorpus(meta, owner, entries, token) : null;

  const techConf = new Map<string, { conf: number; hard: boolean }>();
  const techHits = new Map<string, { source: string; detail: string }>();
  const evidence: TechEvidence[] = [...base.evidence];
  const confs: TechConf[] = [];

  const grade = (def: TechDef, isMandatory: boolean): void => {
    const scored = corpus ? scoreTech(def, corpus) : { conf: 0, hits: [], hard: false };
    techConf.set(def.key, { conf: scored.conf, hard: scored.hard });
    confs.push({ def, conf: scored.conf, hard: scored.hard, mandatory: isMandatory });
    const best = [...scored.hits].sort((a, b) => b.weight - a.weight)[0];
    if (best) techHits.set(def.key, { source: best.source, detail: best.detail });
    if (scored.conf >= HIT_CONF) {
      (isMandatory ? base.mandatoryHit : base.goodToHaveHit).push(def.label);
      if (best) evidence.push({ tech: def.label, source: best.source, detail: best.detail });
    }
  };

  for (const def of mandatory) grade(def, true);
  for (const def of goodToHave) grade(def, false);

  base.mandatoryMissing = mandatory.map((d) => d.label).filter((l) => !base.mandatoryHit.includes(l));
  base.evidence = evidence.slice(0, 12);

  const substance = substanceOf(corpus);
  base.matchPct = domainScore(confs, core, substance);
  base.relevant = provesDomain(confs, core);

  // 3) Commit audit — one page, no pagination. Also yields the candidate's newest own commit.
  //    In someone else's repo (a team / org / course repo) only the candidate's own commits
  //    matter, so GitHub is asked for exactly those: in a busy repo they may not be among the
  //    latest 100 at all. Same single call either way.
  const own = owner.toLowerCase() === username.toLowerCase();
  let commits = emptyAudit();
  const commitRes = await ghGet<GhCommitItem[]>(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(meta.name)}/commits?per_page=${COMMITS_PER_REPO}${
      own ? "" : `&author=${encodeURIComponent(username)}`
    }`,
    token,
    budget,
  );
  if (commitRes.ok && Array.isArray(commitRes.data)) {
    commits = auditCommits(commitRes.data, username, corpus?.fileCount ?? entries.length);
  }
  base.commits = commits.audit;

  // A repo the resume cites but someone else owns (a team / course / famous repo) only
  // counts when the candidate's own account committed to it — otherwise its code is
  // not their evidence. In their own repo, an unlinked git email is still them.
  const contributed = own || commits.lastLinked !== null;
  base.lastOwnCommit = own ? commits.lastOwn : commits.lastLinked ? { date: commits.lastLinked, linked: true } : null;
  base.relevant = base.relevant && contributed;

  return {
    analysis: base,
    techConf: contributed ? techConf : new Map(),
    techHits: contributed ? techHits : new Map(),
    commits,
    substance,
    pushedAt: base.pushedAt,
  };
}

/** The candidate behind a resume's GitHub links: the profile's user, else the first repo's owner. */
export function githubUsernameFor(profileUrl: string, repoUrls: string[]): string | null {
  return (
    parseGithubUser(profileUrl) ||
    (repoUrls ?? []).map((u) => parseGithubUser(u)).find((u): u is string => Boolean(u)) ||
    null
  );
}

/**
 * Deep-inspect a candidate's public GitHub against a JD tech spec.
 *
 * Never throws. Every reason there is no analysis — no token, no username, a missing
 * user, a rejected token, the rate limit, a profile with nothing inspectable — comes
 * back as a typed failure with a readable message, so the caller can show it instead of
 * a silent 0. Partial trouble (one repo failing, the budget running out mid-profile)
 * degrades to a partial analysis with `warning` set.
 */
export async function analyzeGithubProfile(
  profileUrl: string,
  repoUrls: string[],
  jd: JdTechSpec,
): Promise<GithubDeepResult> {
  const token = githubToken();
  if (!token) return { ok: false, reason: "no-token", message: "GITHUB_TOKEN is not set in .env.local." };

  const username = githubUsernameFor(profileUrl, repoUrls);
  if (!username) return { ok: false, reason: "no-username", message: "No GitHub username in the resume's links." };

  const mandatory = (jd?.mandatory ?? []).map(resolveTech);
  const goodToHave = (jd?.goodToHave ?? []).map(resolveTech).filter((g) => !mandatory.some((m) => m.key === g.key));
  const core = coreKeys(mandatory, goodToHave);
  const assessable = mandatory.length + goodToHave.length > 0;
  const rankTerms = [...mandatory, ...goodToHave].flatMap((d) => [d.label.toLowerCase(), ...d.aliases]);
  const rankLangs = new Set([...mandatory, ...goodToHave].flatMap((d) => d.langs ?? []).map((l) => l.toLowerCase()));

  const budget: CallBudget = { restLeft: REST_BUDGET_PER_CANDIDATE, stop: false, reason: "" };

  try {
    // ── Discover the repo pool ────────────────────────────────────────────
    const { repos: owned, status } = await listOwnedRepos(username, token, budget);
    if (owned.length === 0) {
      if (status === 401) {
        return { ok: false, reason: "auth", message: "GitHub rejected GITHUB_TOKEN (401 Bad credentials) — create a new token and update .env.local." };
      }
      if (status === 404) return { ok: false, reason: "not-found", message: `GitHub user "${username}" does not exist.` };
      if (budget.stop) return { ok: false, reason: "rate-limited", message: `GitHub rate limit reached (${budget.reason}).` };
      if (status === 0) return { ok: false, reason: "error", message: "GitHub did not respond (network error or timeout)." };
      if (status !== 200) return { ok: false, reason: "error", message: `GitHub returned HTTP ${status} for ${username}'s repositories.` };
    }

    const pool = new Map<string, GhRepoMeta>();
    for (const r of owned) {
      if (r.fork || r.archived) continue; // forks carry upstream history and upstream code
      if ((r.size ?? 0) === 0) continue; // empty repo
      if (r.name.toLowerCase() === username.toLowerCase()) continue; // profile README, zero signal
      pool.set(r.full_name.toLowerCase(), r);
    }

    // Repos the resume explicitly cites are worth a metadata call even when they are not
    // in the owned listing (renamed org repos, collaborations).
    const resumeRefs = (repoUrls ?? []).map(parseRepoRef).filter((r): r is { owner: string; repo: string } => Boolean(r));
    const resumeKeys = new Set(resumeRefs.map((r) => `${r.owner}/${r.repo}`.toLowerCase()));
    let extra = 0;
    for (const ref of resumeRefs) {
      const key = `${ref.owner}/${ref.repo}`.toLowerCase();
      if (pool.has(key) || extra >= EXTRA_REPO_META_CAP || budget.stop) continue;
      extra += 1;
      const res = await ghGet<GhRepoMeta>(
        `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`,
        token,
        budget,
      );
      if (res.ok && res.data && !res.data.fork && (res.data.size ?? 0) > 0) pool.set(key, res.data);
    }

    const scanned = [...pool.values()];
    if (scanned.length === 0) {
      return { ok: false, reason: "no-repos", message: `${username} has no public, non-fork repositories with code.` };
    }

    // ── Rank, then cap ────────────────────────────────────────────────────
    const now = Date.now();
    const ranked = [...scanned].sort((a, b) => rankScore(b) - rankScore(a));
    function rankScore(meta: GhRepoMeta): number {
      const resumeCited = resumeKeys.has(meta.full_name.toLowerCase()) ? 40 : 0;
      const jdHit = metadataRank(meta, rankTerms) * 6;
      // A domain-typical language (Python / notebooks for ML, JS/TS for web …) is a weak
      // hint the repo is worth reading — students rarely write descriptions.
      const langHit = rankLangs.has((meta.language ?? "").toLowerCase()) ? 8 : 0;
      const pushed = meta.pushed_at ? new Date(meta.pushed_at).getTime() : 0;
      const months = pushed > 0 ? (now - pushed) / (1000 * 60 * 60 * 24 * 30) : 999;
      const recency = Math.max(0, 24 - months); // 0-24, favours the last two years
      const stars = Math.min(10, meta.stargazers_count ?? 0);
      const bulk = Math.min(6, Math.log10(Math.max(1, meta.size ?? 1)) * 2);
      return resumeCited + jdHit + langHit + recency + stars + bulk;
    }

    const selected = ranked.slice(0, REPO_ANALYSIS_CAP);
    const capped = ranked.length > selected.length;

    // ── Deep-inspect ──────────────────────────────────────────────────────
    const outcomes = (
      await mapPool(selected, REPO_CONCURRENCY, async (meta) => {
        const owner = meta.owner?.login ?? meta.full_name.split("/")[0] ?? username;
        try {
          return await analyzeRepo(meta, owner, username, token, mandatory, goodToHave, core, budget);
        } catch (err) {
          console.warn("[github-analysis] repo failed:", meta.full_name, err instanceof Error ? err.message : err);
          return null;
        }
      })
    ).filter((o): o is RepoOutcome => o !== null);

    let warning = "";
    if (budget.stop && budget.reason) {
      warning = `Partial analysis — ${budget.reason}.`;
      console.warn(`[github-analysis] stopped early for ${username}: ${budget.reason}`);
    }

    // ── Roll up the JD match ──────────────────────────────────────────────
    const rollup = (def: TechDef, isMandatory: boolean): TechConf => {
      const per = outcomes
        .map((o) => o.techConf.get(def.key) ?? { conf: 0, hard: false })
        .sort((a, b) => b.conf - a.conf);
      const hard = per.some((p) => p.hard && p.conf > 0);
      // Diminishing returns: a second and third repo corroborate, they do not double.
      let conf = clamp01((per[0]?.conf ?? 0) + 0.5 * (per[1]?.conf ?? 0) + 0.25 * (per[2]?.conf ?? 0));
      if (!hard) conf = Math.min(conf, CAP_META_ONLY);
      return { def, conf, hard, mandatory: isMandatory };
    };
    const rolled = [...mandatory.map((d) => rollup(d, true)), ...goodToHave.map((d) => rollup(d, false))];

    // Depth of the profile: how many domain projects, how recent, how substantial.
    const relevant = outcomes.filter((o) => o.analysis.relevant);
    const eighteenMonthsAgo = now - 1000 * 60 * 60 * 24 * 30 * 18;
    const touched = (o: RepoOutcome) => Date.parse(o.analysis.lastOwnCommit?.date ?? o.pushedAt) || 0;
    const projects = Math.min(1, relevant.length / 3);
    const recency = relevant.length ? relevant.filter((o) => touched(o) >= eighteenMonthsAgo).length / relevant.length : 0;
    const substance = relevant.reduce((m, o) => Math.max(m, o.substance), 0);
    const depth = 0.6 * projects + 0.25 * recency + 0.15 * substance;

    const overallMatchPct = assessable ? domainScore(rolled, core, depth) : 0;

    // Technologies the profile genuinely proves — domain ones first, then plain languages.
    const proven = (t: TechConf) => t.hard && t.conf >= HIT_CONF;
    const provenRolled = rolled
      .filter(proven)
      .sort((a, b) => Number(core.has(b.def.key)) - Number(core.has(a.def.key)) || b.conf - a.conf);
    const provenTechs = provenRolled.map((t) => t.def.label);

    // The proof behind each: the strongest finding in the repo that proves the tech best.
    const bestProof = (def: TechDef): TechProof | null => {
      let best: RepoOutcome | null = null;
      for (const o of outcomes) {
        const conf = o.techConf.get(def.key)?.conf ?? 0;
        if (conf > 0 && (!best || conf > (best.techConf.get(def.key)?.conf ?? 0))) best = o;
      }
      const hit = best?.techHits.get(def.key);
      return best && hit
        ? { tech: def.label, repo: best.analysis.name, repoUrl: best.analysis.url, source: hit.source, detail: hit.detail }
        : null;
    };
    const techEvidence = provenRolled.map((t) => bestProof(t.def)).filter((e): e is TechProof => e !== null);
    const mandatoryGaps: TechGap[] = rolled
      .filter((t) => t.mandatory && !proven(t))
      .map((t) => {
        const proof = bestProof(t.def);
        return {
          tech: t.def.label,
          reason: t.conf <= 0 ? "none" : !t.hard ? "readme-only" : "weak",
          confidence: Math.round(t.conf * 100),
          detail: proof ? `${proof.detail} (${proof.repo})` : "",
        };
      });

    // Newest own commit to a domain-relevant repo.
    let lastDomainCommit: DomainCommit | null = null;
    for (const o of relevant) {
      const own = o.analysis.lastOwnCommit;
      if (!own) continue;
      if (!lastDomainCommit || Date.parse(own.date) > Date.parse(lastDomainCommit.date)) {
        lastDomainCommit = { date: own.date, repo: o.analysis.name, repoUrl: o.analysis.url, linked: own.linked };
      }
    }

    // ── Languages (Jupyter Notebook folded into Python — otherwise every DS repo
    //    fails a Python check) ──────────────────────────────────────────────
    const langMap = new Map<string, number>();
    for (const o of outcomes) {
      const raw = o.analysis.primaryLanguage;
      if (!raw) continue;
      const lang = raw === "Jupyter Notebook" ? "Python" : raw;
      langMap.set(lang, (langMap.get(lang) ?? 0) + 1);
    }
    const languages = [...langMap.entries()]
      .map(([lang, count]) => ({ lang, count }))
      .sort((a, b) => b.count - a.count);

    // ── Roll up authenticity ──────────────────────────────────────────────
    const totalCommitsAnalyzed = outcomes.reduce((s, o) => s + o.commits.audit.analyzed, 0);
    const aiAttributedCommits = outcomes.reduce((s, o) => s + o.commits.audit.aiAttributed, 0);
    const genuineCommits = outcomes.reduce((s, o) => s + o.commits.audit.humanAuthored, 0);
    const hardCommits = outcomes.reduce((s, o) => s + o.commits.hardCommits, 0);
    const markerCommits = outcomes.reduce((s, o) => s + o.commits.markerCommits, 0);
    const suggestionCommits = outcomes.reduce((s, o) => s + o.commits.suggestionCommits, 0);
    const shareDenom = outcomes.reduce((s, o) => s + o.commits.shareDenom, 0);
    const aiWeight = outcomes.reduce((s, o) => s + o.commits.aiWeight, 0);
    const reposWithHard = outcomes.filter((o) => o.commits.hardCommits > 0).length;
    const weeks = new Set<string>();
    for (const o of outcomes) for (const w of o.commits.weeks) weeks.add(w);

    const aiShare = shareDenom > 0 ? aiWeight / Math.max(shareDenom, MIN_SHARE_DENOM) : 0;
    const aiLikelihood = mapLikelihood({
      hardCommits,
      markerCommits,
      suggestionCommits,
      aiShare,
      spread: Math.max(reposWithHard, weeks.size),
    });

    const tools = new Map<string, number>();
    for (const o of outcomes) for (const [tool, n] of o.commits.tools) tools.set(tool, (tools.get(tool) ?? 0) + n);
    const toolList = [...tools.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tool, n]) => `${tool} (${n})`)
      .join(", ");

    // A share and the tools named — never an accusatory verdict beside a person's name.
    // Absence of markers is NOT evidence of unassisted work: Copilot inline, Cursor Tab,
    // Windsurf and bolt.new leave nothing in commit metadata, and every marker here is
    // one CLI flag away from being switched off.
    const pct = shareDenom > 0 ? Math.round((aiAttributedCommits / shareDenom) * 100) : 0;
    const summary =
      totalCommitsAnalyzed === 0
        ? "No commit history could be inspected."
        : aiAttributedCommits > 0
          ? `${aiAttributedCommits} of ${shareDenom} inspected commits (${pct}%) carry a vendor AI-agent signature — ${toolList || "unattributed"}.`
          : markerCommits > 0
            ? `No vendor-signed AI commits; ${markerCommits} commit(s) carry an AI tool body marker without a vendor email. AI tooling that leaves no marker is undetectable here.`
            : `${totalCommitsAnalyzed} commits inspected across ${outcomes.length} repo(s); no AI-agent signature found. Absence of a marker is not proof of unassisted work.`;

    const signals: string[] = [];
    for (const o of outcomes) {
      for (const s of o.commits.audit.signals) {
        const line = `${o.analysis.name}: ${s}`;
        if (!signals.includes(line)) signals.push(line);
      }
    }

    return {
      ok: true,
      analysis: {
        username,
        reposScanned: scanned.length,
        reposAnalyzed: outcomes.length,
        capped,
        overallMatchPct,
        matchingCount: relevant.length,
        assessable,
        provenTechs,
        techEvidence,
        mandatoryGaps,
        lastDomainCommit,
        warning,
        languages,
        // Domain-relevant repos first, then by match.
        topRepos: outcomes
          .map((o) => o.analysis)
          .sort((a, b) => Number(b.relevant) - Number(a.relevant) || b.matchPct - a.matchPct),
        authenticity: {
          totalCommitsAnalyzed,
          aiAttributedCommits,
          genuineCommits,
          aiLikelihood,
          summary,
          signals: signals.slice(0, 8),
        },
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[github-analysis] deep analysis failed:", message);
    return { ok: false, reason: "error", message: `GitHub analysis failed: ${message.slice(0, 160)}` };
  }
}

/**
 * Is the configured token usable right now? One `/rate_limit` call — it costs no quota
 * — so a run can fail fast with a clear message instead of scoring every candidate's
 * GitHub as 0 behind a rejected or exhausted token.
 */
export async function checkGithubAccess(): Promise<
  { ok: true; remaining: number; limit: number; resetAt: string } | { ok: false; message: string }
> {
  const token = githubToken();
  if (!token) return { ok: false, message: "GITHUB_TOKEN is not set in .env.local — add a GitHub personal access token." };
  try {
    const init: RequestInit = {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": UA,
      },
    };
    let res: Response;
    try {
      res = await fetchWithTimeout("https://api.github.com/rate_limit", init);
    } catch {
      res = await fetchWithTimeout("https://api.github.com/rate_limit", init, RETRY_TIMEOUT_MS);
    }
    if (res.status === 401) {
      return { ok: false, message: "GitHub rejected GITHUB_TOKEN (401 Bad credentials) — it is expired or revoked. Create a new token and update .env.local." };
    }
    if (!res.ok) return { ok: false, message: `GitHub returned HTTP ${res.status} when checking the token.` };
    const data = (await res.json()) as { resources?: { core?: { remaining?: number; limit?: number; reset?: number } } };
    const core = data.resources?.core ?? {};
    return {
      ok: true,
      remaining: Number(core.remaining ?? 0),
      limit: Number(core.limit ?? 0),
      resetAt: core.reset ? new Date(core.reset * 1000).toISOString() : "",
    };
  } catch (err) {
    return { ok: false, message: `Could not reach GitHub (${err instanceof Error ? err.message : "network error"}).` };
  }
}

/** Which technologies a deep inspection will look for — shown to the user before a run. */
export function describeJdTechSpec(jd: JdTechSpec): { core: string[]; languages: string[] } {
  const defs = [...jd.mandatory, ...jd.goodToHave].map(resolveTech);
  const core = coreKeys(
    jd.mandatory.map(resolveTech),
    jd.goodToHave.map(resolveTech),
  );
  return {
    core: defs.filter((d) => core.has(d.key)).map((d) => d.label),
    languages: defs.filter((d) => !core.has(d.key)).map((d) => d.label),
  };
}

/**
 * Commit-authorship audit for ONE repository, from its raw REST commit list
 * (`GET /repos/{o}/{r}/commits` items). Exposed for Assignment Evaluation, which
 * fetches the commits itself.
 */
export function auditRepoCommits(items: unknown[], username: string, fileCount: number): CommitAudit {
  return auditCommits(items as GhCommitItem[], username, fileCount).audit;
}

// ── Project-level inspection (Candidate Bucketing) ──────────────────────────
//
// Candidate Bucketing verifies ONE repository per resume project: what its own code
// proves (every catalogued technology, not a JD subset), its whole commit history (for
// the strict authorship audit in bucketing/commit-integrity.ts) and its tree paths (for
// AI-tool trace files). It reuses the tree + free raw-read evidence pipeline above.

/** A REST budget shared by every GitHub call one candidate's bucketing run makes. */
export type GithubBudget = CallBudget;

export function githubBudget(calls: number): GithubBudget {
  return { restLeft: calls, stop: false, reason: "" };
}

/** A raw REST commit item (`GET /repos/{o}/{r}/commits`) — only the fields this module reads. */
export type GithubCommitItem = GhCommitItem;

export type GithubCommitClass = CommitClass;

/** One technology a repository's own code / manifests / config / artifacts prove. */
export interface DetectedTech {
  key: string;
  label: string;
  /** 0-1 evidence confidence (see scoreTech). */
  conf: number;
  /** Backed by more than topics / README prose. */
  hard: boolean;
  /** The strongest quotable proof, e.g. "import express in server.js". */
  detail: string;
}

export interface RepoInspection {
  owner: string;
  repo: string;
  url: string;
  defaultBranch: string;
  fork: boolean;
  /** "owner/repo" of the upstream when this is a fork. */
  parent: string;
  archived: boolean;
  homepage: string;
  description: string;
  pushedAt: string;
  sizeKb: number;
  /** Every non-vendored path in the tree. */
  paths: string[];
  /** GitHub truncated the tree, or the repo was too large to list. */
  treeTruncated: boolean;
  techs: DetectedTech[];
  /** Declared manifest dependencies (canonical names). */
  dependencies: string[];
  srcFiles: number;
  srcBytes: number;
  notebooks: number;
  readme: string;
  /** Default-branch history, newest first (merges included). */
  commits: GithubCommitItem[];
  /** History is longer than what was fetched (or a later page failed). */
  commitsTruncated: boolean;
}

export type RepoInspectionFailure = "not-found" | "empty" | "unavailable";

export type RepoInspectionResult =
  | { ok: true; repo: RepoInspection }
  | { ok: false; failure: RepoInspectionFailure; message: string };

/** Why a REST call gave nothing: a missing / private repo is evidence, anything else is not. */
function inspectionFailure(budget: GithubBudget, status: number, what: string): Extract<RepoInspectionResult, { ok: false }> {
  if (status === 404 || status === 451) return { ok: false, failure: "not-found", message: `${what}: repository not found or private.` };
  if (status === 401) return { ok: false, failure: "unavailable", message: `${what}: GitHub rejected GITHUB_TOKEN (401).` };
  return {
    ok: false,
    failure: "unavailable",
    message: `${what}: GitHub unavailable (${budget.reason || (status ? `HTTP ${status}` : "network error")}).`,
  };
}

/** Authenticated REST GET for callers outside this module (profiles, PRs, repo lists), on a shared budget. */
export async function githubGetJson<T>(path: string, budget: GithubBudget): Promise<{ ok: boolean; status: number; data: T | null }> {
  const token = githubToken();
  if (!token) return { ok: false, status: 401, data: null };
  return ghGet<T>(path.startsWith("http") ? path : `https://api.github.com${path}`, token, budget);
}

/**
 * Inspect one repository for a resume project. Costs 2 + ⌈commits/100⌉ REST calls
 * (meta, tree, commit pages); file reads go through raw.githubusercontent.com (free).
 * Never throws.
 */
export async function inspectRepository(
  owner: string,
  repo: string,
  budget: GithubBudget,
  opts: { maxCommits: number },
): Promise<RepoInspectionResult> {
  const token = githubToken();
  if (!token) return { ok: false, failure: "unavailable", message: "GITHUB_TOKEN is not set in .env.local." };
  const what = `${owner}/${repo}`;
  try {
    const metaRes = await ghGet<GhRepoMeta & { default_branch?: string; homepage?: string | null; parent?: { full_name?: string } }>(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      token,
      budget,
    );
    if (!metaRes.ok || !metaRes.data) return inspectionFailure(budget, metaRes.status, what);
    const meta = metaRes.data;
    // Canonical casing / renamed repos.
    const [o, r] = meta.full_name.includes("/") ? meta.full_name.split("/") : [owner, repo];
    if ((meta.size ?? 0) === 0) return { ok: false, failure: "empty", message: `${what}: repository is empty.` };
    const base = `https://api.github.com/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}`;

    let entries: GhTreeEntry[] = [];
    let treeTruncated = false;
    if ((meta.size ?? 0) <= TREE_SKIP_REPO_SIZE_KB) {
      const tree = await ghGet<GhTree>(`${base}/git/trees/HEAD?recursive=1`, token, budget);
      if (tree.ok && tree.data) {
        entries = Array.isArray(tree.data.tree) ? tree.data.tree : [];
        treeTruncated = Boolean(tree.data.truncated);
      } else if (tree.status === 409) {
        return { ok: false, failure: "empty", message: `${what}: repository is empty.` };
      } else {
        return inspectionFailure(budget, tree.status, what);
      }
    } else {
      treeTruncated = true;
    }

    const corpus = entries.length > 0 ? await buildCorpus({ ...meta, name: r }, o, entries, token) : null;
    const techs: DetectedTech[] = [];
    if (corpus) {
      for (const def of TECHS) {
        const scored = scoreTech(def, corpus);
        if (scored.conf <= 0) continue;
        const best = [...scored.hits].sort((a, b) => b.weight - a.weight)[0];
        techs.push({ key: def.key, label: def.label, conf: Number(scored.conf.toFixed(2)), hard: scored.hard, detail: best?.detail ?? "" });
      }
      techs.sort((a, b) => b.conf - a.conf);
    }

    const commits: GhCommitItem[] = [];
    let commitsTruncated = false;
    const pages = Math.max(1, Math.ceil(opts.maxCommits / COMMITS_PER_REPO));
    for (let page = 1; page <= pages; page++) {
      const res = await ghGet<GhCommitItem[]>(`${base}/commits?per_page=${COMMITS_PER_REPO}&page=${page}`, token, budget);
      if (!res.ok || !Array.isArray(res.data)) {
        if (res.status === 409) break; // empty history
        if (page === 1) return inspectionFailure(budget, res.status, what);
        commitsTruncated = true; // a later page failed: the audit is partial
        break;
      }
      commits.push(...res.data);
      if (res.data.length < COMMITS_PER_REPO) break;
      if (page === pages) commitsTruncated = true;
    }

    return {
      ok: true,
      repo: {
        owner: o,
        repo: r,
        url: meta.html_url || `https://github.com/${o}/${r}`,
        defaultBranch: meta.default_branch ?? "",
        fork: Boolean(meta.fork),
        parent: meta.fork ? (meta.parent?.full_name ?? "unknown upstream") : "",
        archived: Boolean(meta.archived),
        homepage: (meta.homepage ?? "").trim(),
        description: meta.description ?? "",
        pushedAt: meta.pushed_at ?? "",
        sizeKb: meta.size ?? 0,
        paths: corpus?.paths ?? [],
        treeTruncated,
        techs,
        dependencies: corpus ? [...corpus.manifestDeps.keys()] : [],
        srcFiles: corpus?.srcFiles ?? 0,
        srcBytes: corpus?.srcBytes ?? 0,
        notebooks: corpus?.notebooks ?? 0,
        readme: corpus?.readme ?? "",
        commits,
        commitsTruncated,
      },
    };
  } catch (err) {
    return { ok: false, failure: "unavailable", message: `${what}: ${err instanceof Error ? err.message.slice(0, 160) : "inspection failed"}` };
  }
}

/** Classify one commit against the AI-authorship rubric (vendor logins / emails / trailers / markers). */
export function classifyCommitItem(item: GithubCommitItem): { cls: GithubCommitClass; tool: string; quote: string } {
  const v = classifyCommit(item, "");
  return { cls: v.cls, tool: v.tool, quote: v.quote };
}

/** dependabot / renovate / github-actions and other ordinary automation (never `web-flow`). */
export function isOrdinaryAutomation(login: string): boolean {
  return Boolean(login) && login.toLowerCase() !== "web-flow" && ORDINARY_AUTOMATION.test(login);
}

/** Catalogued technologies a piece of text names (by alias) — for what a resume CLAIMS, never as proof. */
export function techKeysInText(text: string): string[] {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return [];
  return TECHS.filter(
    (def) => def.aliases.some((a) => mentions(t, a)) || (!labelIsWord(def) && mentions(t, def.label)) || wordIn(def, text),
  ).map((def) => def.key);
}

/** Technology key → display label. */
export function techLabel(key: string): string {
  return TECH_INDEX.get(canon(key))?.label ?? key;
}
