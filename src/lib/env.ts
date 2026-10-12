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
 * A comma-separated key POOL (e.g. MISTRAL_API_KEYS) with the single-key var
 * (MISTRAL_API_KEY) as fallback — deduplicated, never throws, [] when unset.
 */
function keyPool(poolName: string, singleName: string): string[] {
  const pool = (process.env[poolName] ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (pool.length > 0) return Array.from(new Set(pool));
  const single = (process.env[singleName] ?? "").trim();
  return single ? [single] : [];
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
  groq: {
    get apiKey() {
      return optional("GROQ_API_KEY", "");
    },
    /** Round-robin pool: GROQ_API_KEYS (comma-separated), else GROQ_API_KEY. */
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
    /** Round-robin pool: MISTRAL_API_KEYS (comma-separated), else MISTRAL_API_KEY. */
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
  benchmarks: {
    /**
     * Chain for Benchmark Projects, "provider:model,…".
     * Empty = the built-in default in benchmark-evaluator.ts.
     */
    get llmChain() {
      return optional("BENCHMARK_LLM_CHAIN", "");
    },
  },
  github: {
    /** Personal Access Token used to fetch candidate GitHub project stats. */
    get token() {
      return optional("GITHUB_TOKEN", "");
    },
  },
};
