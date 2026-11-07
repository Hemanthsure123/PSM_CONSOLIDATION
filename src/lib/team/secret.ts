import "server-only";
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Server-side secrets at rest (the team account's refresh token) and short signed values (OAuth
 * state). Keys are derived from MOBILE_JWT_SECRET with HKDF, one per purpose, so no extra key has
 * to be configured; INTEGRATIONS_KEY overrides it when set.
 */

function master(): Buffer {
  const raw = (process.env.INTEGRATIONS_KEY || process.env.MOBILE_JWT_SECRET || "").trim();
  if (raw.length < 32) throw new Error("INTEGRATIONS_KEY (or MOBILE_JWT_SECRET) must be at least 32 characters.");
  return Buffer.from(raw, "utf8");
}

function key(purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master(), Buffer.from("psm-integrations"), Buffer.from(purpose), 32));
}

/** AES-256-GCM: "v1.<iv>.<tag>.<ciphertext>" (base64url). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key("token-at-rest"), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptSecret(blob: string): string {
  const [v, iv, tag, body] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("Unreadable secret.");
  const decipher = createDecipheriv("aes-256-gcm", key("token-at-rest"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

/** A short signed value: "<payload>.<hmac>" with an expiry inside the payload. */
export function signValue(data: Record<string, unknown>, ttlSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  const mac = createHmac("sha256", key("signed-value")).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function verifyValue<T extends Record<string, unknown>>(value: string): T | null {
  const [payload, mac] = value.split(".");
  if (!payload || !mac) return null;
  const want = createHmac("sha256", key("signed-value")).update(payload).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T & { exp?: number };
    if (!data.exp || data.exp < Date.now() / 1000) return null;
    return data;
  } catch {
    return null;
  }
}
