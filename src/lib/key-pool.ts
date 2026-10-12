import "server-only";
import { env } from "@/lib/env";

/**
 * Round-robin API-key pools for the OpenAI-compatible fallback providers
 * (Mistral, Groq) — the same idea as the Gemini pool in gemini-keys.ts.
 *
 * Every call advances the pool's cursor, so consecutive calls start on
 * consecutive keys and load spreads evenly across all configured keys
 * (MISTRAL_API_KEYS / GROQ_API_KEYS, falling back to the single *_API_KEY).
 * Within one call each usable key is tried at most once per round:
 *  - 401 / 403             → the key is dead: parked for every model.
 *  - daily/monthly quota   → parked for THAT model only (other models may still have quota).
 *  - per-second/minute 429 → short cooldown honouring Retry-After, move to the next key.
 *  - context too long / unknown model → thrown at once (another key cannot fix it).
 * When a whole round fails only on short rate limits, it waits for the earliest
 * cooldown (capped) and runs one more round.
 *
 * State lives on `globalThis` so cursors and cooldowns persist across server
 * actions within the same server process.
 */

export type ChatProvider = "mistral" | "groq";

const ENDPOINTS: Record<ChatProvider, string> = {
  mistral: "https://api.mistral.ai/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
};

const LONG_PARK_MS = 6 * 60 * 60 * 1000;
const SHORT_PARK_DEFAULT_MS = 15_000;
const MAX_ROUND_WAIT_MS = 20_000;
const ROUNDS = 2;

interface PoolKey {
  key: string;
  /** Parked for every model until this epoch ms (dead / unauthorised key). */
  deadUntil: number;
  /** Per-model parking (quota or short rate limit). */
  modelCooldown: Record<string, number>;
}

interface Pool {
  keys: PoolKey[];
  cursor: number;
  signature: string;
}

const globalForPools = globalThis as unknown as { __chatKeyPools?: Partial<Record<ChatProvider, Pool>> };

export function providerKeys(provider: ChatProvider): string[] {
  return provider === "mistral" ? env.mistral.apiKeys : env.groq.apiKeys;
}

export function hasProviderKeys(provider: ChatProvider): boolean {
  return providerKeys(provider).length > 0;
}

function getPool(provider: ChatProvider): Pool {
  const keys = providerKeys(provider);
  const signature = keys.join("|");
  const pools = (globalForPools.__chatKeyPools ??= {});
  const existing = pools[provider];
  if (!existing || existing.signature !== signature) {
    pools[provider] = { keys: keys.map((key) => ({ key, deadUntil: 0, modelCooldown: {} })), cursor: 0, signature };
  }
  return pools[provider]!;
}

/** Log-safe key label: the last 4 characters only. */
export function maskKey(key: string): string {
  return key.length > 8 ? `…${key.slice(-4)}` : "…";
}

/** Why a pooled call gave up — lets the router decide whether a smaller prompt could help. */
export class ChatPoolError extends Error {
  constructor(
    message: string,
    readonly kind: "context" | "model" | "exhausted",
  ) {
    super(message);
    this.name = "ChatPoolError";
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterMs: number,
    /** The provider reports an allowance of 0 requests for this model (not in the key's plan). */
    readonly zeroLimit = false,
  ) {
    super(`HTTP ${status}: ${zeroLimit ? "this model allows 0 requests/minute on this key's plan — " : ""}${body.slice(0, 300)}`);
  }
}

export interface ChatRequest {
  system: string;
  user: string;
  temperature: number;
  /** Default 180 s — whole-repository prompts are slow. */
  timeoutMs?: number;
  /**
   * Try each key once and give up instead of waiting for a rate-limited key to
   * cool down — for small, latency-sensitive jobs that have somewhere else to go.
   */
  singleRound?: boolean;
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 0;
  const s = Number(value);
  if (Number.isFinite(s) && s > 0) return Math.min(s * 1000, 120_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 120_000)) : 0;
}

/** Message content can be a string, or (reasoning models) an array of typed chunks. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : "",
      )
      .join("");
  }
  return "";
}

async function callOnce(provider: ChatProvider, apiKey: string, model: string, req: ChatRequest): Promise<string> {
  const res = await fetch(ENDPOINTS[provider], {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      response_format: { type: "json_object" },
      temperature: req.temperature,
    }),
    signal: AbortSignal.timeout(req.timeoutMs ?? 180_000),
  });
  if (!res.ok) {
    // Mistral reports a model outside the key's plan as a 429 with a per-minute limit of 0.
    const zeroLimit = res.headers.get("x-ratelimit-limit-req-minute") === "0";
    throw new HttpError(res.status, await res.text().catch(() => ""), parseRetryAfter(res.headers.get("retry-after")), zeroLimit);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  return contentText(data.choices?.[0]?.message?.content);
}

const CONTEXT_RE = /context|too long|too large|maximum.{0,40}tokens|reduce the length|prompt is too long|request too large/i;
const LONG_QUOTA_RE = /month|daily|per day|tokens per day|requests per day|\bTPD\b|\bRPD\b|billing|insufficient|credit/i;

/**
 * One JSON chat completion through the provider's key pool. Returns the raw
 * content plus the masked key that served it; throws ChatPoolError otherwise.
 */
export async function pooledChatJson(
  provider: ChatProvider,
  model: string,
  req: ChatRequest,
): Promise<{ text: string; key: string }> {
  const pool = getPool(provider);
  const n = pool.keys.length;
  if (n === 0) throw new ChatPoolError(`${provider}: no API key configured`, "exhausted");

  const start = pool.cursor;
  pool.cursor = (pool.cursor + 1) % n;
  const errors: string[] = [];

  const rounds = req.singleRound ? 1 : ROUNDS;
  for (let round = 0; round < rounds; round++) {
    let earliestShort = Infinity;
    for (let step = 0; step < n; step++) {
      const state = pool.keys[(start + step) % n];
      const now = Date.now();
      if (state.deadUntil > now) continue;
      const cooldown = state.modelCooldown[model] ?? 0;
      if (cooldown > now) {
        if (cooldown - now <= MAX_ROUND_WAIT_MS) earliestShort = Math.min(earliestShort, cooldown);
        continue;
      }
      try {
        const text = await callOnce(provider, state.key, model, req);
        if (text.trim()) return { text, key: maskKey(state.key) };
        errors.push(`${maskKey(state.key)}: empty response`);
      } catch (err) {
        if (err instanceof HttpError) {
          if (err.status === 401 || err.status === 403) {
            state.deadUntil = Date.now() + LONG_PARK_MS;
          } else if (err.status === 413 || (err.status === 400 && CONTEXT_RE.test(err.body))) {
            throw new ChatPoolError(`${provider}/${model}: prompt too large for the model`, "context");
          } else if (
            err.status === 404 ||
            (err.status === 400 && /model/i.test(err.body) && /invalid|not found|does not exist|unknown/i.test(err.body))
          ) {
            throw new ChatPoolError(`${provider}/${model}: model unavailable (${err.message.slice(0, 160)})`, "model");
          } else if (err.status === 429 && err.zeroLimit) {
            // This model has no allowance on this key's plan — other models on the key still work.
            state.modelCooldown[model] = Date.now() + LONG_PARK_MS;
          } else if (err.status === 429) {
            if (LONG_QUOTA_RE.test(err.body)) {
              state.modelCooldown[model] = Date.now() + LONG_PARK_MS;
            } else {
              const until = Date.now() + (err.retryAfterMs || SHORT_PARK_DEFAULT_MS);
              state.modelCooldown[model] = until;
              earliestShort = Math.min(earliestShort, until);
            }
          }
          errors.push(`${maskKey(state.key)}: ${err.message.slice(0, 160)}`);
        } else {
          errors.push(`${maskKey(state.key)}: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
        }
      }
    }
    // Only short rate limits left — wait for the first key to free up, then go again.
    if (round < rounds - 1 && Number.isFinite(earliestShort)) {
      const wait = Math.min(Math.max(earliestShort - Date.now(), 500), MAX_ROUND_WAIT_MS);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    break;
  }

  throw new ChatPoolError(
    `${provider}/${model}: all keys failed (${errors.slice(-3).join(" | ") || "all keys parked"})`,
    "exhausted",
  );
}
