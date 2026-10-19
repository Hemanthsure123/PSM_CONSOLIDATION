/**
 * Centralized, validated access to server-side environment variables.
 *
 * Values are resolved LAZILY (via getters) so that simply importing this module
 * never throws — important because `next build` imports the server-action module
 * graph without a populated `.env.local`. Validation happens the first time a
 * value is actually read, i.e. at request time.
 *
 * Keep this server-only — importing it from a Client Component is a mistake.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Add it to .env.local (see .env.local.example).`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

/**
 * Every key configured for a provider: the comma-separated POOL (e.g.
 * MISTRAL_API_KEYS), the numbered vars (MISTRAL_API_KEY_1, MISTRAL_API_KEY_2, …)
 * and the single var (MISTRAL_API_KEY) — deduplicated, never throws, [] when unset.
 */
function keyPool(poolName: string, singleName: string): string[] {
  const pool = (process.env[poolName] ?? "").split(",");
  const numbered = Object.keys(process.env)
    .map((name) => ({ name, n: Number(name.slice(singleName.length + 1)) }))
    .filter(({ name, n }) => name.startsWith(`${singleName}_`) && Number.isInteger(n) && n > 0)
    .sort((a, b) => a.n - b.n)
    .map(({ name }) => process.env[name] ?? "");
  const keys = [...pool, ...numbered, process.env[singleName] ?? ""]
    .map((k) => k.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return Array.from(new Set(keys));
}

/**
 * The GCP private key is stored single-line with literal "\n" escapes in
 * .env.local. Convert those back to real newlines for the SDK. Also strips
 * accidental wrapping quotes.
 */
function normalizePrivateKey(raw: string): string {
  return raw.replace(/^["']|["']$/g, "").replace(/\\n/g, "\n");
}

export const env = {
  gcp: {
    get projectId() {
      return required("GCP_PROJECT_ID");
    },
    get datasetId() {
      return required("BIGQUERY_DATASET_ID");
    },
    get tableId() {
      return required("BIGQUERY_TABLE_ID");
    },
    get clientEmail() {
      return required("GCP_SERVICE_ACCOUNT_CLIENT_EMAIL");
    },
    get privateKey() {
      return normalizePrivateKey(required("GCP_SERVICE_ACCOUNT_PRIVATE_KEY"));
    },
  },
  drive: {
    get folderId() {
      return required("GOOGLE_DRIVE_FOLDER_ID");
    },
    /**
     * Optional Workspace user to impersonate via domain-wide delegation. When
     * set, the Drive client acts AS this user (who has real Drive storage), so
     * uploads to a normal My Drive folder succeed and produce shareable links —
     * no Shared Drive required. Leave blank to use the service account directly.
     */
    get impersonateUser() {
      return optional("GOOGLE_DRIVE_IMPERSONATE_USER", "");
    },
  },
  gemini: {
    get apiKey() {
      return required("GEMINI_API_KEY");
    },
    get model() {
      return optional("GEMINI_MODEL", "gemini-2.5-flash");
    },
    /**
     * Round-robin key pool powering ALL Gemini analysis (highlights, projects,
     * domain shortlisting, DSA extraction). Prefers GEMINI_API_KEYS
     * (comma-separated); falls back to the single GEMINI_API_KEY so it still
     * works with one key. Adding more keys multiplies the per-run daily budget.
     * Never throws (returns [] when nothing is configured) — callers degrade
     * gracefully.
     */
    get apiKeys(): string[] {
      const pool = (process.env.GEMINI_API_KEYS ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      if (pool.length > 0) return Array.from(new Set(pool));
      const single = (process.env.GEMINI_API_KEY ?? "").trim();
      return single ? [single] : [];
    },
  },
  /** Optional fallback LLM providers (used when Gemini's daily quota is hit). */
  openai: {
    /** Round-robin pool: OPENAI_API_KEYS (comma-separated), OPENAI_API_KEY_1…N, OPENAI_API_KEY. */
    get apiKeys(): string[] {
      return keyPool("OPENAI_API_KEYS", "OPENAI_API_KEY");
    },
    /**
     * Models for the Domain Shortlisting fallback, best-calibrated first (OPENAI_MODEL,
     * comma-separated). Each model has its own daily request allowance on every key —
     * 50/day per model per key on the current keys — so a second model adds capacity.
     */
    get models(): string[] {
      const list = optional("OPENAI_MODEL", "gpt-5.4-mini,gpt-5.5")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      return Array.from(new Set(list));
    },
    /** The first (preferred) OpenAI model. */
    get model() {
      return this.models[0] ?? "gpt-5.4-mini";
    },
    /**
     * Reasoning effort for GPT-5-family models: none | low | medium | high. "none" by
     * default: on real resumes (2026-10-14) every reasoning setting scored well below the
     * domain prompt's own rubric (failing full-stack candidates with real projects and
     * internships), while "none" matched the Gemini judgements and the rubric bands.
     */
    get reasoningEffort() {
      return optional("OPENAI_REASONING_EFFORT", "none");
    },
  },
  groq: {
    get apiKey() {
      return optional("GROQ_API_KEY", "");
    },
    /** Round-robin pool: GROQ_API_KEYS (comma-separated), GROQ_API_KEY_1…N, GROQ_API_KEY. */
    get apiKeys(): string[] {
      return keyPool("GROQ_API_KEYS", "GROQ_API_KEY");
    },
    get model() {
      return optional("GROQ_MODEL", "llama-3.3-70b-versatile");
    },
  },
  mistral: {
    get apiKey() {
      return optional("MISTRAL_API_KEY", "");
    },
    /** Round-robin pool: MISTRAL_API_KEYS (comma-separated), MISTRAL_API_KEY_1…N, MISTRAL_API_KEY. */
    get apiKeys(): string[] {
      return keyPool("MISTRAL_API_KEYS", "MISTRAL_API_KEY");
    },
    get model() {
      // ministral-8b is on Mistral's free tier; mistral-small allows 0 req/min there.
      return optional("MISTRAL_MODEL", "ministral-8b-latest");
    },
  },
  assignment: {
    /**
     * Top-to-bottom model chain for Assignment Evaluation, as comma-separated
     * `provider:model` pairs. Empty = the built-in default in llm-router.ts.
     */
    get llmChain() {
      return optional("ASSIGNMENT_LLM_CHAIN", "");
    },
  },
  links: {
    /**
     * Fast chain for the resume profile-link fallback (DSA consolidation),
     * "provider:model,…". Empty = the built-in default in resume-links.ts.
     */
    get llmChain() {
      return optional("LINKS_LLM_CHAIN", "");
    },
  },
  experience: {
    /**
     * Chain for Experience Analysis (internships / jobs from resumes),
     * "provider:model,…". Empty = the built-in default in experience-analyzer.ts.
     */
    get llmChain() {
      return optional("EXPERIENCE_LLM_CHAIN", "");
    },
  },
  qa: {
    /**
     * Chain for QA Resume Screening, "provider:model,…".
     * Empty = the built-in default in qa-evaluator.ts.
     */
    get llmChain() {
      return optional("QA_LLM_CHAIN", "");
    },
  },
  domain: {
    /**
     * Chain for Domain Shortlisting's resume judgement, "provider:model,…".
     * Empty = the built-in default in actions/llm.ts (Gemini → OpenAI → Mistral).
     */
    get llmChain() {
      return optional("DOMAIN_LLM_CHAIN", "");
    },
  },
  zaggle: {
    /**
     * Chain for the Zaggle SDE 1 screening, "provider:model,…".
     * Empty = the built-in default in zaggle/evaluator.ts (Gemini → OpenAI → Mistral).
     */
    get llmChain() {
      return optional("ZAGGLE_LLM_CHAIN", "");
    },
  },
  benchmarks: {
    /**
     * Chain for Benchmark Projects, "provider:model,…".
     * Empty = the built-in default in benchmark-evaluator.ts.
     */
    get llmChain() {
      return optional("BENCHMARK_LLM_CHAIN", "");
    },
  },
  bucketing: {
    /**
     * Chain for Candidate Bucketing's producing agents (extraction, domain analyst,
     * bucketing agent), "provider:model,…". Empty = the default in bucketing/config.ts.
     */
    get llmChain() {
      return optional("BUCKETING_LLM_CHAIN", "");
    },
    /** Chain for the verifying agents — should lead with a different model than the producers. */
    get verifierChain() {
      return optional("BUCKETING_VERIFIER_CHAIN", "");
    },
  },
  github: {
    /** Personal Access Token used to fetch candidate GitHub project stats. */
    get token() {
      return optional("GITHUB_TOKEN", "");
    },
    /** Hours a Domain Shortlisting GitHub inspection is reused (default 24; 0 = never cache). */
    get cacheTtlHours() {
      const hours = Number(optional("GITHUB_CACHE_TTL_HOURS", "24"));
      return Number.isFinite(hours) && hours >= 0 ? hours : 24;
    },
    /** Folder for cached GitHub inspections ("" = .cache/github-inspect in the app folder). */
    get cacheDir() {
      return optional("GITHUB_CACHE_DIR", "");
    },
  },
};
