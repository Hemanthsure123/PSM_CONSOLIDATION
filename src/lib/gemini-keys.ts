import "server-only";
import type { GenerationConfig, Schema, Part } from "@google/generative-ai";
import { getGeminiForKey } from "@/lib/gemini";
import { env } from "@/lib/env";

/**
 * Round-robin Gemini key rotation — powers ALL Gemini analysis (resume
 * highlights, projects extraction, domain shortlisting) and the DSA
 * link-extraction step.
 *
 * The pool comes from GEMINI_API_KEYS (comma-separated) with the single
 * GEMINI_API_KEY as fallback. Keys are tried in rotation; a key that hits its
 * DAILY free-tier quota for a model is parked for that model (cooldown) so we stop wasting calls on it and
 * move to the next key. Because each candidate rotates to the next key, the
 * daily throughput of a whole run scales with the number of keys configured.
 * Per-minute 429s / 5xx are retried briefly on the SAME key. Best-effort: when
 * every key is exhausted it returns `null` and the caller degrades gracefully
 * (fails over to Groq / Mistral, or to annotation + text extraction).
 *
 * State lives on `globalThis` so the rotation cursor + cooldowns persist across
 * separate server-action invocations within the same server process (same
 * pattern as the Gemini / BigQuery client singletons).
 */

interface KeyState {
  key: string;
  /** Epoch ms until which this key is parked for EVERY model (dead / invalid key). */
  cooldownUntil: number;
  /**
   * Per-model parking (daily quota). Free-tier quotas are per model, so a key
   * that exhausted gemini-2.5-pro can still serve gemini-2.5-flash.
   */
  modelCooldown: Record<string, number>;
  /** Why each model is parked on this key — lets callers tell "rate limited" from "not served". */
  modelParkReason?: Record<string, GeminiFailureKind>;
}

interface KeyPool {
  keys: KeyState[];
  cursor: number;
  signature: string;
}

/** Daily quota won't recover within a run — park the key for the rest of it. */
const DAILY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Upper bound on any single Gemini request when the caller sets none. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** A model that is overloaded or too slow is skipped (on every key) for this long. */
const SATURATED_PARK_MS = 60_000;

const FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"];

const globalForKeys = globalThis as unknown as { __geminiKeyPool?: KeyPool };

function getPool(): KeyPool {
  const keys = env.gemini.apiKeys;
  const signature = keys.join("|");
  const existing = globalForKeys.__geminiKeyPool;
  // Rebuild if the configured keys changed (e.g. env reloaded in dev).
  if (!existing || existing.signature !== signature) {
    globalForKeys.__geminiKeyPool = {
      keys: keys.map((key) => ({ key, cooldownUntil: 0, modelCooldown: {} })),
      cursor: 0,
      signature,
    };
  }
  return globalForKeys.__geminiKeyPool!;
}

function modelChain(): string[] {
  const configured = env.gemini.model
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set([...configured, ...FALLBACK_MODELS]));
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Quota that won't recover within a run: a per-DAY limit, or a model with no
 * free-tier allowance at all ("limit: 0"). Parks that key+model only.
 */
function isDailyQuotaError(err: unknown): boolean {
  return /PerDay|RequestsPerDay|GenerateRequestsPerDayPerProject|limit:\s*0\b/i.test(msgOf(err));
}

/**
 * The model is not served to this key (retired for new users, wrong name, not
 * enabled for the project). Parks that key+model only — other models still work.
 */
function isModelUnavailableError(err: unknown): boolean {
  return /\[404|no longer available|is not found for API version|not supported for generateContent/i.test(msgOf(err));
}

/**
 * A permanent problem with THIS key (bad/expired/unauthorized key, or billing
 * not enabled). Like a daily quota, retrying it is pointless — park the key so
 * subsequent candidates skip it. This also makes the DUMMY-key default fail fast
 * until real keys are added. Quota errors also mention "billing" ("check your
 * plan and billing details") — those are per-model limits, never a dead key.
 */
function isKeyDeadError(err: unknown): boolean {
  const m = msgOf(err);
  if (/quota/i.test(m)) return false;
  return /API_KEY_INVALID|api key not valid|api key expired|invalid api key|PERMISSION_DENIED|API keys are not supported|CONSUMER_INVALID|invalid authentication credentials|UNAUTHENTICATED|\[401|billing/i.test(
    m,
  );
}

function isRetryable(err: unknown): boolean {
  if (isDailyQuotaError(err) || isModelUnavailableError(err)) return false;
  return /\[429|\[503|\[500|fetch failed|ECONNRESET|ETIMEDOUT|overloaded|high demand/i.test(msgOf(err));
}

function retryDelayMs(err: unknown): number {
  const m = msgOf(err).match(/retry in ([\d.]+)s/i) || msgOf(err).match(/"retryDelay":\s*"(\d+)s"/);
  const s = m ? Number(m[1]) : 0;
  return Math.min(Number.isFinite(s) && s > 0 ? s : 3, 12) * 1000 + Math.random() * 300;
}

export interface GeminiGenOptions {
  systemInstruction?: string;
  schema?: Schema;
  temperature?: number;
  /** Pin the model chain for this call (default: GEMINI_MODEL + fallbacks). */
  models?: string[];
  /** Per-request timeout; long-context calls (whole repositories) need minutes. */
  timeoutMs?: number;
  /** Observe each failed key+model attempt (for diagnostics; the key is masked). */
  onError?: (info: { model: string; key: string; message: string }) => void;
  /** Raise for long structured answers so a big rubric is never cut off mid-JSON. */
  maxOutputTokens?: number;
  /**
   * How much the model thinks before answering. Omit = the model's default.
   * Gemini 3 takes a thinking level; Gemini 2.5 gets an equivalent token budget.
   */
  thinking?: "low" | "high";
}

/** thinkingConfig for the model family (the SDK passes generationConfig through as-is). */
function thinkingConfig(modelName: string, level: "low" | "high") {
  return /^gemini-3/i.test(modelName)
    ? { thinkingLevel: level }
    : { thinkingBudget: level === "low" ? 1024 : -1 };
}

type Parts = string | Array<string | Part>;

/** Call one key+model once, with bounded retries for transient blips only. */
async function generateOnce(
  apiKey: string,
  modelName: string,
  parts: Parts,
  opts: GeminiGenOptions,
  attempts = 2,
): Promise<string> {
  const model = getGeminiForKey(apiKey).getGenerativeModel(
    {
      model: modelName,
      systemInstruction: opts.systemInstruction,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: opts.schema,
        temperature: opts.temperature ?? 0.2,
        ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
        ...(opts.thinking ? { thinkingConfig: thinkingConfig(modelName, opts.thinking) } : {}),
      } as GenerationConfig,
    },
    // Always bounded: an overloaded model can otherwise hold a request open for
    // many minutes and stall whatever batch is waiting on it.
    { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await model.generateContent(parts);
      return res.response.text();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, retryDelayMs(err)));
    }
  }
  throw lastErr;
}

/**
 * Generate JSON text using the key pool in round-robin order. Returns the raw
 * JSON string, or `null` when no key is configured or every key/model failed.
 */
export async function geminiGenerateJson(parts: Parts, opts: GeminiGenOptions = {}): Promise<string | null> {
  const pool = getPool();
  if (pool.keys.length === 0) return null;

  const models = opts.models?.length ? opts.models : modelChain();
  const now = Date.now();
  const n = pool.keys.length;

  // Visit each key once, starting at the rotating cursor; advance the cursor so
  // the next call starts on the next key (true round-robin).
  const start = pool.cursor;
  pool.cursor = (pool.cursor + 1) % n;

  for (let step = 0; step < n; step++) {
    const state = pool.keys[(start + step) % n];
    if (state.cooldownUntil > now) continue; // parked (dead key) — skip
    state.modelCooldown ??= {}; // pools built before per-model parking existed (dev hot reload)

    for (const modelName of models) {
      if ((state.modelCooldown[modelName] ?? 0) > now) continue; // this model's quota is spent on this key
      try {
        return await generateOnce(state.key, modelName, parts, opts);
      } catch (err) {
        opts.onError?.({ model: modelName, key: `…${state.key.slice(-4)}`, message: msgOf(err).slice(0, 300) });
        if (isKeyDeadError(err)) {
          state.cooldownUntil = Date.now() + DAILY_COOLDOWN_MS;
          break; // this key is unusable — move to the next key
        }
        if (isDailyQuotaError(err) || isModelUnavailableError(err)) {
          state.modelCooldown[modelName] = Date.now() + DAILY_COOLDOWN_MS;
        }
        // Quota/transient/model-specific error — try the next model on the same key.
      }
    }
  }

  return null;
}

// ── Single-model call with classified failures (Assignment Evaluation) ───────

/**
 * Why a single-model call gave up:
 *  - "rate"        per-minute limit / temporary overload — Google is throttling us right now;
 *  - "quota"       daily quota or no free-tier allowance for this model on these keys;
 *  - "unavailable" the model isn't served to these keys (retired, wrong name) or no usable key;
 *  - "error"       the request itself failed (bad request, timeout, blocked output).
 */
export type GeminiFailureKind = "rate" | "quota" | "unavailable" | "error";

export type GeminiModelResult = { ok: true; text: string; key: string } | { ok: false; kind: GeminiFailureKind; detail: string };

/** Short park after a per-minute 429 when Google gives no retry hint. */
const RATE_PARK_MS = 30_000;

function isOverloaded(err: unknown): boolean {
  return /\[503|\[500|overloaded|high demand|UNAVAILABLE/i.test(msgOf(err));
}

function isRateLimited(err: unknown): boolean {
  return /\[429|RESOURCE_EXHAUSTED|rate limit|too many requests/i.test(msgOf(err));
}

/** The SDK aborts at opts.timeoutMs — a model that slow is saturated; move on rather than wait again. */
function isTimeout(err: unknown): boolean {
  return /aborted|timed? ?out|deadline exceeded/i.test(msgOf(err)) && !/ECONNRESET|fetch failed/i.test(msgOf(err));
}

function isNetwork(err: unknown): boolean {
  return /fetch failed|ECONNRESET|ETIMEDOUT|timed? ?out|aborted|socket hang up/i.test(msgOf(err));
}

function hintedDelayMs(err: unknown): number {
  const m = msgOf(err).match(/retry in ([\d.]+)s/i) || msgOf(err).match(/"retryDelay":\s*"(\d+)s"/);
  const s = m ? Number(m[1]) : 0;
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, 120_000) : RATE_PARK_MS;
}

/**
 * One JSON generation on ONE model, rotating round-robin over the key pool
 * with no sleeping: a rate-limited key is parked briefly and the next key is
 * tried at once; an overloaded model stops immediately (every key would see
 * the same overload). The failure kind tells the caller whether to fail over
 * to another provider (rate / quota) or not.
 */
export async function geminiJsonForModel(parts: Parts, model: string, opts: GeminiGenOptions = {}): Promise<GeminiModelResult> {
  const pool = getPool();
  const n = pool.keys.length;
  if (n === 0) return { ok: false, kind: "unavailable", detail: "no Gemini API key configured" };

  const start = pool.cursor;
  pool.cursor = (pool.cursor + 1) % n;
  const seen = new Set<GeminiFailureKind>();
  const details: string[] = [];
  let attempted = 0;

  for (let step = 0; step < n; step++) {
    const state = pool.keys[(start + step) % n];
    const now = Date.now();
    if (state.cooldownUntil > now) continue;
    state.modelCooldown ??= {};
    state.modelParkReason ??= {};
    if ((state.modelCooldown[model] ?? 0) > now) {
      seen.add(state.modelParkReason[model] ?? "quota");
      continue;
    }
    attempted++;
    const label = `…${state.key.slice(-4)}`;
    try {
      const text = await generateOnce(state.key, model, parts, opts, 1);
      return { ok: true, text, key: label };
    } catch (err) {
      const msg = msgOf(err)
        .replace(/^\[GoogleGenerativeAI Error\]:\s*/, "")
        .replace(/^Error fetching from \S+:\s*/, "")
        .replace(/\s+/g, " ")
        .slice(0, 180);
      details.push(`${label}: ${msg}`);
      opts.onError?.({ model, key: label, message: msg });
      if (isKeyDeadError(err)) {
        state.cooldownUntil = Date.now() + DAILY_COOLDOWN_MS;
        continue;
      }
      if (isModelUnavailableError(err)) {
        state.modelCooldown[model] = Date.now() + DAILY_COOLDOWN_MS;
        state.modelParkReason[model] = "unavailable";
        seen.add("unavailable");
        continue;
      }
      if (isDailyQuotaError(err)) {
        state.modelCooldown[model] = Date.now() + DAILY_COOLDOWN_MS;
        state.modelParkReason[model] = "quota";
        seen.add("quota");
        continue;
      }
      if (isRateLimited(err)) {
        state.modelCooldown[model] = Date.now() + hintedDelayMs(err);
        state.modelParkReason[model] = "rate";
        seen.add("rate");
        continue;
      }
      if (isOverloaded(err) || isTimeout(err)) {
        seen.add("rate");
        // Model-wide overload / too slow right now: every key would see the same,
        // so park the model on all keys briefly — the next calls switch instantly.
        const until = Date.now() + SATURATED_PARK_MS;
        for (const k of pool.keys) {
          k.modelCooldown ??= {};
          k.modelParkReason ??= {};
          if ((k.modelCooldown[model] ?? 0) < until) {
            k.modelCooldown[model] = until;
            k.modelParkReason[model] = "rate";
          }
        }
        break;
      }
      seen.add("error");
      if (isNetwork(err)) continue; // a timeout on one key may not repeat on the next
      break; // bad request / blocked output — another key won't change it
    }
  }

  const kind: GeminiFailureKind = seen.has("rate")
    ? "rate"
    : seen.has("quota")
      ? "quota"
      : seen.has("error")
        ? "error"
        : "unavailable";
  return {
    ok: false,
    kind,
    detail: details.slice(-2).join(" | ") || (attempted ? "failed" : "every key is parked for this model"),
  };
}

/** Keys that are configured and not parked as dead/invalid right now. */
export function geminiUsableKeyCount(): number {
  const now = Date.now();
  return getPool().keys.filter((k) => k.cooldownUntil <= now).length;
}
