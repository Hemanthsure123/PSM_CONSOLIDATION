import "server-only";
import { createHash } from "node:crypto";
import { databaseConfigured, query } from "@/lib/db/client";
import { UserError } from "@/lib/mobile/http";
import { decryptSecret, encryptSecret } from "@/lib/team/secret";

/**
 * API keys the admin manages from the app (Me → API keys): Deepgram and ElevenLabs for call
 * transcripts and voice input, Gemini, Mistral and Groq for the AI features that already use
 * those providers. They are ADDED to the keys in the server's environment — nothing about how a
 * feature picks or rotates keys changes. Keys are stored encrypted; the app only ever sees the
 * label and the last four characters.
 *
 * The decrypted keys live in memory (globalThis) and are re-read at most once a minute, and at
 * once after an admin change; env.ts merges them into each provider's pool.
 */

export const KEY_PROVIDERS = ["deepgram", "elevenlabs", "mistral", "gemini", "groq"] as const;
export type KeyProvider = (typeof KEY_PROVIDERS)[number];

export const PROVIDER_LABEL: Record<KeyProvider, string> = {
  deepgram: "Deepgram",
  elevenlabs: "ElevenLabs",
  mistral: "Mistral",
  gemini: "Gemini",
  groq: "Groq",
};

/** What each provider's keys are used for (shown in the app). */
export const PROVIDER_USE: Record<KeyProvider, string> = {
  deepgram: "Call transcripts and voice input (after ElevenLabs)",
  elevenlabs: "Call transcripts and voice input (first choice)",
  gemini: "AI features: screening, prep documents, RSAs, summaries",
  mistral: "AI features (fallback after Gemini and OpenAI)",
  groq: "AI features that use Groq",
};

const MAX_KEYS_PER_PROVIDER = 50;
const TTL_MS = 60_000;

type Cache = { at: number; keys: Partial<Record<KeyProvider, string[]>> };
const g = globalThis as unknown as { __psmAdminKeys?: Cache; __psmAdminKeysLoading?: Promise<void> | null };

/** The admin's keys for a provider, from memory (env.ts merges them). Never throws. */
export function cachedAdminKeys(provider: KeyProvider): string[] {
  return g.__psmAdminKeys?.keys[provider] ?? [];
}

/** Loads the admin's keys when the in-memory copy is older than a minute. Never throws. */
export async function ensureAdminKeys(force = false): Promise<void> {
  if (!databaseConfigured()) return;
  if (!force && g.__psmAdminKeys && Date.now() - g.__psmAdminKeys.at < TTL_MS) return;
  if (g.__psmAdminKeysLoading) return g.__psmAdminKeysLoading;
  g.__psmAdminKeysLoading = (async () => {
    try {
      const rows = await query<{ provider: KeyProvider; key_enc: string }>("select provider, key_enc from app.api_keys where enabled and status <> 'invalid' order by created_at");
      const keys: Cache["keys"] = {};
      for (const r of rows) {
        try {
          (keys[r.provider] ??= []).push(decryptSecret(r.key_enc));
        } catch {
          // Encrypted with another server's secret (a local copy): skipped, never sent anywhere.
        }
      }
      g.__psmAdminKeys = { at: Date.now(), keys };
    } catch (err) {
      // The table may not exist yet (before the migration) or the database is busy: keep the last copy.
      g.__psmAdminKeys = { at: Date.now(), keys: g.__psmAdminKeys?.keys ?? {} };
      console.warn("[api-keys] not loaded:", err instanceof Error ? err.message.slice(0, 160) : err);
    } finally {
      g.__psmAdminKeysLoading = null;
    }
  })();
  return g.__psmAdminKeysLoading;
}

// ── Admin: list / add / edit / delete / test ─────────────────────────────────

export interface ApiKeyDto {
  id: string;
  provider: KeyProvider;
  label: string;
  /** "…a1b2" — never the key. */
  masked: string;
  enabled: boolean;
  status: "unchecked" | "ok" | "invalid" | "error";
  statusNote: string | null;
  checkedAt: string | null;
  addedBy: string;
  updatedAt: string;
}

interface KeyRow {
  id: string;
  provider: KeyProvider;
  label: string;
  last4: string;
  enabled: boolean;
  status: ApiKeyDto["status"];
  status_note: string | null;
  checked_at: Date | null;
  created_by: string;
  updated_at: Date;
}

const dto = (r: KeyRow): ApiKeyDto => ({
  id: r.id,
  provider: r.provider,
  label: r.label,
  masked: `…${r.last4}`,
  enabled: r.enabled,
  status: r.status,
  statusNote: r.status_note,
  checkedAt: r.checked_at?.toISOString() ?? null,
  addedBy: r.created_by,
  updatedAt: r.updated_at.toISOString(),
});

const SELECT = "select id, provider, label, last4, enabled, status, status_note, checked_at, created_by, updated_at from app.api_keys";

/** Keys from the server's environment, counted per provider (never shown). */
function envCounts(): Record<KeyProvider, number> {
  const pool = (...names: string[]) => {
    const set = new Set<string>();
    for (const n of names) for (const k of (process.env[n] ?? "").split(",").map((x) => x.trim()).filter(Boolean)) set.add(k);
    for (const [name, v] of Object.entries(process.env)) if (names.some((n) => name.startsWith(`${n.replace(/S$/, "")}_`) && /_\d+$/.test(name)) && v?.trim()) set.add(v.trim());
    return set.size;
  };
  return {
    deepgram: pool("DEEPGRAM_API_KEYS", "DEEPGRAM_API_KEY"),
    elevenlabs: pool("ELEVENLABS_API_KEYS", "ELEVENLABS_API_KEY"),
    gemini: pool("GEMINI_API_KEYS", "GEMINI_API_KEY"),
    mistral: pool("MISTRAL_API_KEYS", "MISTRAL_API_KEY"),
    groq: pool("GROQ_API_KEYS", "GROQ_API_KEY"),
  };
}

export async function listApiKeys() {
  const rows = await query<KeyRow>(`${SELECT} order by provider, created_at`);
  const env = envCounts();
  return {
    providers: KEY_PROVIDERS.map((p) => ({ id: p, label: PROVIDER_LABEL[p], use: PROVIDER_USE[p], serverKeys: env[p] })),
    keys: rows.map(dto),
  };
}

const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex");

/** Plausible key text: one line, no spaces, a sane length. Providers' formats differ, so no stricter check. */
function cleanKey(raw: unknown): string {
  const key = String(raw ?? "").trim();
  if (!key) throw new UserError(422, "Paste the API key.", "invalid_key");
  if (/\s/.test(key) || key.length < 16 || key.length > 300) throw new UserError(422, "That doesn't look like an API key (one line, no spaces).", "invalid_key");
  return key;
}

const cleanLabel = (raw: unknown, fallback: string) => String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || fallback;

function cleanProvider(raw: unknown): KeyProvider {
  const p = String(raw ?? "").toLowerCase();
  if (!(KEY_PROVIDERS as readonly string[]).includes(p)) throw new UserError(422, "Choose Deepgram, ElevenLabs, Mistral, Gemini or Groq.", "invalid_provider");
  return p as KeyProvider;
}

async function audit(actor: string, action: string, target: string, detail: Record<string, unknown>) {
  await query("insert into app.audit_log (actor_email, action, target, detail) values ($1, $2, $3, $4)", [actor, action, target, JSON.stringify(detail)]).catch(() => undefined);
}

export async function addApiKey(actor: string, body: { provider?: unknown; label?: unknown; key?: unknown }): Promise<ApiKeyDto> {
  const provider = cleanProvider(body.provider);
  const key = cleanKey(body.key);
  const count = await query<{ n: number }>("select count(*)::int as n from app.api_keys where provider = $1", [provider]);
  if ((count[0]?.n ?? 0) >= MAX_KEYS_PER_PROVIDER) throw new UserError(422, `Up to ${MAX_KEYS_PER_PROVIDER} ${PROVIDER_LABEL[provider]} keys.`, "too_many_keys");
  const check = await testKey(provider, key);
  const rows = await query<KeyRow>(
    `insert into app.api_keys (provider, label, key_enc, fingerprint, last4, status, status_note, checked_at, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, now(), $8, $8)
     on conflict (provider, fingerprint) do nothing
     returning id, provider, label, last4, enabled, status, status_note, checked_at, created_by, updated_at`,
    [provider, cleanLabel(body.label, `${PROVIDER_LABEL[provider]} key`), encryptSecret(key), fingerprint(key), key.slice(-4), check.status, check.note, actor],
  );
  if (!rows[0]) throw new UserError(409, "This key is already added.", "duplicate_key");
  await audit(actor, "api_key_added", rows[0].id, { provider, status: check.status });
  await ensureAdminKeys(true);
  return dto(rows[0]);
}

export async function updateApiKey(actor: string, id: string, body: { label?: unknown; key?: unknown; enabled?: unknown }): Promise<ApiKeyDto> {
  const cur = (await query<KeyRow>(`${SELECT} where id = $1`, [id]))[0];
  if (!cur) throw new UserError(404, "This key was deleted.", "not_found");
  const sets: string[] = [];
  const args: unknown[] = [id];
  const add = (sql: string, v: unknown) => {
    args.push(v);
    sets.push(`${sql} = $${args.length}`);
  };
  if (body.label !== undefined) add("label", cleanLabel(body.label, cur.label));
  if (typeof body.enabled === "boolean") add("enabled", body.enabled);
  let status: string | null = null;
  if (body.key !== undefined && String(body.key).trim()) {
    const key = cleanKey(body.key);
    const dup = await query("select 1 from app.api_keys where provider = $1 and fingerprint = $2 and id <> $3", [cur.provider, fingerprint(key), id]);
    if (dup.length) throw new UserError(409, "This key is already added.", "duplicate_key");
    const check = await testKey(cur.provider, key);
    status = check.status;
    add("key_enc", encryptSecret(key));
    add("fingerprint", fingerprint(key));
    add("last4", key.slice(-4));
    add("status", check.status);
    add("status_note", check.note);
    sets.push("checked_at = now()");
  }
  if (!sets.length) return dto(cur);
  add("updated_by", actor);
  const rows = await query<KeyRow>(
    `update app.api_keys set ${sets.join(", ")}, updated_at = now() where id = $1
     returning id, provider, label, last4, enabled, status, status_note, checked_at, created_by, updated_at`,
    args,
  );
  await audit(actor, "api_key_updated", id, { provider: cur.provider, keyChanged: status !== null, enabled: body.enabled });
  await ensureAdminKeys(true);
  return dto(rows[0]);
}

export async function deleteApiKey(actor: string, id: string): Promise<void> {
  const rows = await query<{ provider: string }>("delete from app.api_keys where id = $1 returning provider", [id]);
  if (!rows[0]) throw new UserError(404, "This key was already deleted.", "not_found");
  await audit(actor, "api_key_deleted", id, { provider: rows[0].provider });
  await ensureAdminKeys(true);
}

/** Re-checks a saved key with its provider. */
export async function retestApiKey(actor: string, id: string): Promise<ApiKeyDto> {
  const row = (await query<KeyRow & { key_enc: string }>(`${SELECT.replace("select id,", "select key_enc, id,")} where id = $1`, [id]))[0];
  if (!row) throw new UserError(404, "This key was deleted.", "not_found");
  let key: string;
  try {
    key = decryptSecret(row.key_enc);
  } catch {
    throw new UserError(409, "This key was saved by another server and can't be read here. Paste it again.", "key_unreadable");
  }
  const check = await testKey(row.provider, key);
  const rows = await query<KeyRow>(
    `update app.api_keys set status = $2, status_note = $3, checked_at = now() where id = $1
     returning id, provider, label, last4, enabled, status, status_note, checked_at, created_by, updated_at`,
    [id, check.status, check.note],
  );
  await audit(actor, "api_key_tested", id, { provider: row.provider, status: check.status });
  return dto(rows[0]);
}

/**
 * A cheap, read-only call that proves the key works (no usage is spent): the provider's
 * account / model list. 401 / 403 = invalid; anything else unexpected = "error" (the key is
 * still saved — the provider may just be down).
 */
export async function testKey(provider: KeyProvider, key: string): Promise<{ status: "ok" | "invalid" | "error"; note: string | null }> {
  const req: Record<KeyProvider, () => Promise<Response>> = {
    deepgram: () => fetch("https://api.deepgram.com/v1/projects", { headers: { Authorization: `Token ${key}` }, signal: AbortSignal.timeout(10_000) }),
    elevenlabs: () => fetch("https://api.elevenlabs.io/v1/models", { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(10_000) }),
    gemini: () => fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10_000) }),
    mistral: () => fetch("https://api.mistral.ai/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) }),
    groq: () => fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) }),
  };
  try {
    const res = await req[provider]();
    if (res.ok) return { status: "ok", note: null };
    if (res.status === 401 || res.status === 403 || (provider === "gemini" && res.status === 400)) {
      return { status: "invalid", note: `${PROVIDER_LABEL[provider]} rejected the key (${res.status}).` };
    }
    return { status: "error", note: `${PROVIDER_LABEL[provider]} answered ${res.status}; the key is saved and will be tried.` };
  } catch {
    return { status: "error", note: `${PROVIDER_LABEL[provider]} couldn't be reached; the key is saved and will be tried.` };
  }
}
