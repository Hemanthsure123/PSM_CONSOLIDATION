import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal HS256 JWTs for the app's 15-minute access tokens (no dependency). Only what we issue
 * ourselves is ever verified here: alg is fixed, the header is not trusted, exp is required.
 */

export interface AccessClaims {
  /** The user's email (the roster key). */
  sub: string;
  role: "member" | "lead" | "admin";
  name: string;
  /** The session (device) this token belongs to. */
  sid: string;
  iat: number;
  exp: number;
}

export const ACCESS_TTL_SECONDS = 15 * 60;

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

export function signAccessToken(claims: Omit<AccessClaims, "iat" | "exp">, secret: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const payload: AccessClaims = { ...claims, iat, exp: iat + ACCESS_TTL_SECONDS };
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/** The claims, or null when the token is malformed, forged or expired. */
export function verifyAccessToken(token: string, secret: string, now = Date.now()): AccessClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as AccessClaims;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;
    if (typeof claims.sub !== "string" || typeof claims.sid !== "string") return null;
    return claims;
  } catch {
    return null;
  }
}
