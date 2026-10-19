import "server-only";
import type { Part, Schema } from "@google/generative-ai";
import { env } from "@/lib/env";
import { geminiJsonForModel, geminiUsableKeyCount, type GeminiFailureKind } from "@/lib/gemini-keys";
import { ChatPoolError, filePart, hasProviderKeys, pooledChatJson, strictJsonSchema, type ChatProvider } from "@/lib/key-pool";

/**
 * LLM routing for long-context jobs (Assignment Evaluation).
 *
 * Gemini is the engine. Its models are tried top to bottom, each rotating
 * round-robin across every Gemini key without sleeping:
 *   gemini-2.5-pro → gemini-3.1-pro-preview → gemini-3.8-flash → gemini-3.5-flash → gemini-2.5-flash
 * A model a key can't use (retired for new keys, no free-tier quota) is parked
 * for that key after its first failure, so dead tiers cost nothing later.
 *
 * Mistral is ONLY a rate-limit fallback: it is used when Gemini failed because
 * of rate limits / quota / overload / slowness (or no usable Gemini key exists),
 * rotating round-robin across MISTRAL_API_KEYS on free-tier models:
 *   codestral → ministral-14b → ministral-8b
 * If Gemini failed for any other reason (bad output), the job reports an error
 * instead of quietly handing the analysis to a weaker model.
 *
 * Override the order with ASSIGNMENT_LLM_CHAIN="provider:model,…" (Groq may be
 * added there explicitly; it is not in the default chain — its small free-tier
 * window is too shallow for whole-repository review).
 *
 * "openai:<model>" tiers (OPENAI_API_KEY_1…N) are fallbacks like Mistral, tried in
 * chain order; they answer to a strict JSON schema and can read the file itself
 * (ChainPrompt.inline) — so they can stand in for Gemini on scanned resumes.
 */

export type LlmProvider = "gemini" | "openai" | "mistral" | "groq";

export interface LlmTier {
  provider: LlmProvider;
  model: string;
  /** Characters of variable content (repo code, document text) this tier can take. */
  budget: number;
}

/**
 * Model IDs verified against the Gemini / Mistral model listings (Sep 2026).
 * gemini-2.5-pro is retired for newly created Gemini keys and the 3.x Pro
 * models need a billing-enabled key; the 3.x Flash models work on free keys.
 */
const DEFAULT_CHAIN =
  "gemini:gemini-2.5-pro,gemini:gemini-3.1-pro-preview,gemini:gemini-3.8-flash,gemini:gemini-3.5-flash,gemini:gemini-2.5-flash," +
  // Free-tier Mistral models (checked 2026-09-29): codestral 125 req/min, ministral-14b 30,
  // ministral-8b 188. mistral-small / mistral-medium allow 0 req/min on this plan.
  "mistral:codestral-latest,mistral:ministral-14b-latest,mistral:ministral-8b-latest";

/** Content budgets — well inside each provider's context window and free-tier TPM. */
const BUDGET: Record<LlmProvider, number> = {
  gemini: 380_000,
  // ~50k tokens: inside one OpenAI key's per-minute token allowance.
  openai: 200_000,
  mistral: 280_000,
  groq: 22_000,
};

/** Parse a "provider:model,…" chain; defaults to the Assignment Evaluation chain. */
export function llmChain(spec?: string): LlmTier[] {
  const raw = spec?.trim() || env.assignment.llmChain.trim() || DEFAULT_CHAIN;
  const tiers: LlmTier[] = [];
  for (const entry of raw.split(",")) {
    const [p, ...rest] = entry.trim().split(":");
    const provider = p?.trim().toLowerCase() as LlmProvider;
    const model = rest.join(":").trim();
    if (!model || !(provider in BUDGET)) continue;
    tiers.push({ provider, model, budget: BUDGET[provider] });
  }
  return tiers.filter((t) => (t.provider === "gemini" ? env.gemini.apiKeys.length > 0 : hasProviderKeys(t.provider)));
}

export interface ChainPrompt {
  /** Gemini input — may include inline PDF parts. */
  geminiParts: string | Array<string | Part>;
  /** Plain-text user message for the OpenAI-compatible providers. */
  text: string;
  /** The file itself (PDF / image) for providers that can read it — OpenAI; sent with `text`. */
  inline?: { mimeType: string; data: string };
}

export interface ChainRequest {
  system: string;
  /** Gemini response schema. */
  schema: Schema;
  /** JSON shape description appended to the system prompt for schema-less providers. */
  shapeHint: string;
  temperature: number;
  build: (tier: LlmTier, budget: number) => ChainPrompt;
  /** Extra acceptance check on the parsed JSON (e.g. "has criteria"). */
  accept?: (parsed: unknown) => boolean;
  timeoutMs?: number;
  maxOutputTokens?: number;
  /** Gemini thinking effort ("low" for extraction-style jobs that must be fast). Omit = model default. */
  thinking?: "low" | "high";
  /** OpenAI reasoning effort for "openai:" tiers (default: `thinking`, else OPENAI_REASONING_EFFORT). */
  openaiReasoning?: string;
  /** A different "provider:model,…" chain (e.g. a fast one for small extraction jobs). */
  chain?: string;
  /** Latency-first: never wait for a rate-limited Mistral key to cool down — move on. */
  fast?: boolean;
  /** Label for server logs. */
  label?: string;
}

export type ChainResult =
  | { ok: true; json: unknown; provider: LlmProvider; model: string; budget: number; ms: number }
  | { ok: false; error: string };

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some models wrap the object in prose — take the outermost {...}.
    const a = trimmed.indexOf("{");
    const b = trimmed.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(trimmed.slice(a, b + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/** Parsed + accepted JSON, or undefined. */
function acceptJson(text: string, req: ChainRequest): unknown {
  const json = parseJson(text);
  if (json === undefined || typeof json !== "object" || json === null) return undefined;
  if (req.accept && !req.accept(json)) return undefined;
  return json;
}

function warn(req: ChainRequest, tier: LlmTier, msg: string) {
  console.warn(`[llm-router${req.label ? `:${req.label}` : ""}] ${tier.provider}/${tier.model}: ${msg.slice(0, 220)}`);
}

export async function runLlmChain(req: ChainRequest): Promise<ChainResult> {
  const tiers = llmChain(req.chain);
  if (tiers.length === 0) {
    return { ok: false, error: "No LLM keys configured (GEMINI_API_KEYS / MISTRAL_API_KEYS)." };
  }
  const started = Date.now();
  const errors: string[] = [];
  const geminiTiers = tiers.filter((t) => t.provider === "gemini");
  const fallbackTiers = tiers.filter((t) => t.provider !== "gemini");
  const kinds = new Set<GeminiFailureKind>();

  // 1) Gemini, best model first.
  for (const tier of geminiTiers) {
    // One extra try on the same model when the answer itself was unusable.
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = req.build(tier, tier.budget);
      const res = await geminiJsonForModel(prompt.geminiParts, tier.model, {
        systemInstruction: req.system,
        schema: req.schema,
        temperature: req.temperature,
        // A saturated model can take minutes; cut it off and try the next model instead.
        timeoutMs: req.timeoutMs ?? (/pro/i.test(tier.model) ? 240_000 : 150_000),
        maxOutputTokens: req.maxOutputTokens,
        thinking: req.thinking,
      });
      if (res.ok) {
        const json = acceptJson(res.text, req);
        if (json !== undefined) {
          return { ok: true, json, provider: "gemini", model: tier.model, budget: tier.budget, ms: Date.now() - started };
        }
        kinds.add("error");
        warn(req, tier, `response JSON was invalid or incomplete (${res.text.length} chars, ends ${JSON.stringify(res.text.slice(-60))})`);
        continue;
      }
      kinds.add(res.kind);
      if (res.kind !== "unavailable") {
        errors.push(`gemini/${tier.model}: ${res.kind} — ${res.detail.slice(0, 160)}`);
        // Tiers already parked on every key are skipped silently — they were logged when first hit.
        if (!/every key is parked/.test(res.detail)) warn(req, tier, `${res.kind}: ${res.detail}`);
      }
      break; // rate / quota / unavailable / request error → next Gemini model
    }
  }

  // 2) Mistral only when Gemini was throttled (or has no usable key at all).
  const throttled = kinds.has("rate") || kinds.has("quota");
  const noGemini = geminiTiers.length === 0 || geminiUsableKeyCount() === 0;
  if (!throttled && !noGemini) {
    return {
      ok: false,
      error: `Gemini could not complete the analysis (not a rate limit, so no fallback) — ${errors.slice(-2).join(" | ") || "invalid responses"}`,
    };
  }

  for (const tier of fallbackTiers) {
    let budget = tier.budget;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const prompt = req.build(tier, budget);
        const openai = tier.provider === "openai";
        const { text } = await pooledChatJson(tier.provider as ChatProvider, tier.model, {
          system: `${req.system}\n\n${req.shapeHint}`,
          user: prompt.text,
          ...(openai
            ? {
                userParts: prompt.inline ? [filePart(prompt.inline), { type: "text" as const, text: prompt.text }] : undefined,
                jsonSchema: { name: "answer", schema: strictJsonSchema(req.schema) },
                reasoningEffort: req.openaiReasoning ?? req.thinking ?? env.openai.reasoningEffort,
              }
            : {}),
          temperature: req.temperature,
          timeoutMs: req.timeoutMs ?? 240_000,
          singleRound: req.fast,
        });
        const json = acceptJson(text, req);
        if (json === undefined) throw new Error("response JSON was invalid or incomplete");
        return { ok: true, json, provider: tier.provider, model: tier.model, budget, ms: Date.now() - started };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof ChatPoolError && err.kind === "context" && attempt === 0) {
          budget = Math.floor(budget / 2);
          continue; // same tier, half the content
        }
        errors.push(`${tier.provider}/${tier.model}: ${msg.slice(0, 160)}`);
        warn(req, tier, msg);
        break;
      }
    }
  }
  return { ok: false, error: `All models are rate-limited or failed — ${errors.slice(-3).join(" | ")}` };
}
