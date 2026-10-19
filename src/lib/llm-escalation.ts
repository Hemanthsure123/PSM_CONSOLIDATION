/**
 * Provider escalation for one LLM judgement: tiers are tried top to bottom, and the
 * chain only LEAVES a provider for the next one when that provider's own rule allows it.
 *
 *   gemini (each model)  → leave on ANY failure: the next provider is just as capable;
 *   openai               → leave only when THROTTLED (rate limit, quota, overload, no
 *                          usable key / model) — a bad answer or a rejected request does
 *                          not hand the candidate to a smaller model; the row is retried;
 *   mistral              → last.
 *
 * A model that was throttled is skipped for the rest of the chain (a second tier on the
 * same model — e.g. the same model given text instead of the PDF — would hit the same limit).
 *
 * Pure: no I/O of its own, so the policy is unit-tested directly.
 */

/** Why a tier gave no usable answer. The first three mean "out of capacity". */
export type TierFailure = "rate" | "quota" | "unavailable" | "unusable" | "error";

export type TierResult<T> = { ok: true; value: T } | { ok: false; kind: TierFailure; detail: string };

export interface EscalationTier<T> {
  provider: string;
  model: string;
  /** Short label for logs / results, e.g. "openai/gpt-5.4-mini (pdf)". */
  label: string;
  run: () => Promise<TierResult<T>>;
}

export type EscalationResult<T> =
  | { ok: true; value: T; provider: string; model: string; label: string; attempts: string[] }
  /** `throttled`: the chain ended only because every provider it could reach was out of capacity. */
  | { ok: false; error: string; throttled: boolean; attempts: string[] };

const THROTTLED: ReadonlySet<TierFailure> = new Set(["rate", "quota", "unavailable"]);

export const isThrottled = (kind: TierFailure) => THROTTLED.has(kind);

/**
 * Run the tiers. `leaveOn[provider]` is "any" (move to the next provider on any failure)
 * or "throttle" (only when the provider was out of capacity); unknown providers default
 * to "throttle" — the strict rule.
 */
export async function escalate<T>(
  tiers: EscalationTier<T>[],
  leaveOn: Record<string, "any" | "throttle">,
  log?: (line: string) => void,
): Promise<EscalationResult<T>> {
  const attempts: string[] = [];
  const throttledModels = new Set<string>();
  const throttledProviders = new Set<string>();
  const failedProviders = new Set<string>();
  let current = "";
  let lastThrottled = false;

  for (const tier of tiers) {
    if (tier.provider !== current) {
      // Leaving `current` for the next provider — only where its rule allows.
      if (current && failedProviders.has(current) && (leaveOn[current] ?? "throttle") === "throttle" && !throttledProviders.has(current)) {
        attempts.push(`stop: ${current} failed for a reason other than a rate limit — not escalated to ${tier.provider}`);
        return { ok: false, error: summarize(attempts), throttled: false, attempts };
      }
      current = tier.provider;
    }
    const modelKey = `${tier.provider}/${tier.model}`;
    if (throttledModels.has(modelKey)) continue;

    let res: TierResult<T>;
    try {
      res = await tier.run();
    } catch (err) {
      res = { ok: false, kind: "error", detail: err instanceof Error ? err.message : String(err) };
    }
    if (res.ok) {
      return { ok: true, value: res.value, provider: tier.provider, model: tier.model, label: tier.label, attempts };
    }
    failedProviders.add(tier.provider);
    lastThrottled = isThrottled(res.kind);
    if (lastThrottled) {
      throttledModels.add(modelKey);
      throttledProviders.add(tier.provider);
    }
    const line = `${tier.label}: ${res.kind} — ${res.detail.replace(/\s+/g, " ").slice(0, 160)}`;
    attempts.push(line);
    log?.(line);
  }
  return { ok: false, error: summarize(attempts), throttled: lastThrottled, attempts };
}

function summarize(attempts: string[]): string {
  return attempts.slice(-3).join(" | ") || "no model is configured";
}
