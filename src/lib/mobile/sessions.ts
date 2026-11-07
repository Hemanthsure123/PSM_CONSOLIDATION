import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { query, transaction } from "@/lib/db/client";
import { env } from "@/lib/env";
import { UserError } from "@/lib/mobile/http";
import { ACCESS_TTL_SECONDS, signAccessToken } from "@/lib/mobile/jwt";
import { ensureBootstrapAdmin, type RosterUser } from "@/lib/mobile/roster";

/** Refresh tokens live 60 days; each use replaces it with a new one. */
const REFRESH_TTL_DAYS = 60;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let oauthClient: OAuth2Client | null = null;

/**
 * Verifies a Google ID token from the app (Credential Manager): signature, audience (our web
 * client), issuer, expiry, a verified email in an allowed domain. Returns the lower-cased email.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<{ email: string; name: string }> {
  oauthClient ??= new OAuth2Client();
  let payload;
  try {
    const ticket = await oauthClient.verifyIdToken({ idToken, audience: env.mobile.googleWebClientId });
    payload = ticket.getPayload();
  } catch {
    throw new UserError(401, "Google couldn't confirm this sign-in. Try again.", "invalid_google_token");
  }
  const email = (payload?.email ?? "").toLowerCase();
  if (!email || !payload?.email_verified) throw new UserError(401, "This Google account has no verified email.", "invalid_google_token");
  const domain = email.split("@")[1] ?? "";
  if (!env.mobile.allowedEmailDomains.includes(domain)) {
    throw new UserError(403, `Sign in with your NxtWave account (${env.mobile.allowedEmailDomains.join(" or ")}).`, "domain_not_allowed");
  }
  return { email, name: payload.name ?? email.split("@")[0] };
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; email: string; name: string; role: string; teamsLinked: boolean };
}

function issue(user: RosterUser, sessionId: string, refreshToken: string): IssuedSession {
  return {
    accessToken: signAccessToken({ sub: user.email, role: user.role, name: user.name, sid: sessionId }, env.mobile.jwtSecret),
    refreshToken,
    expiresIn: ACCESS_TTL_SECONDS,
    user: { id: user.email, email: user.email, name: user.name, role: user.role, teamsLinked: false },
  };
}

/** After Google sign-in: the person must be on the roster (bootstrap admins are added on first sign-in). */
export async function startSession(email: string, googleName: string, device?: DeviceInfo | null): Promise<IssuedSession> {
  await ensureBootstrapAdmin(email, googleName);
  const rows = await query<RosterUser>(
    "select email, name, aliases, role, active, lead_email as \"leadEmail\" from app.users where email = $1",
    [email],
  );
  const user = rows[0];
  if (!user || !user.active) {
    throw new UserError(403, "You're not on the PSM team roster yet. Ask your admin to add you in the app.", "not_on_roster");
  }
  const refreshToken = randomBytes(32).toString("base64url");
  const id = randomUUID();
  await query(
    `insert into app.sessions (id, user_email, refresh_hash, expires_at, family)
     values ($1, $2, $3, now() + make_interval(days => $4), $1)`,
    [id, email, sha256(refreshToken), REFRESH_TTL_DAYS],
  );
  await registerDevice(email, id, device);
  return issue(user, id, refreshToken);
}

/**
 * Rotates a refresh token. Reusing a token that was already rotated means it was copied:
 * the whole session family is revoked and the device must sign in again.
 */
export async function refreshSession(refreshToken: string): Promise<IssuedSession> {
  return transaction(async (tx) => {
    const found = await tx.query(
      `select s.id, s.family, s.expires_at, s.rotated_at, s.revoked_at,
              u.email, u.name, u.aliases, u.role, u.active, u.lead_email as "leadEmail"
         from app.sessions s join app.users u on u.email = s.user_email
        where s.refresh_hash = $1 for update of s`,
      [sha256(refreshToken)],
    );
    const s = found.rows[0];
    if (!s) throw new UserError(401, "Your session ended. Sign in again.", "invalid_refresh");
    if (s.rotated_at || s.revoked_at) {
      await tx.query("update app.sessions set revoked_at = coalesce(revoked_at, now()) where family = $1", [s.family]);
      throw new UserError(401, "Your session ended. Sign in again.", "refresh_reused");
    }
    if (new Date(s.expires_at).getTime() <= Date.now()) throw new UserError(401, "Your session ended. Sign in again.", "refresh_expired");
    if (!s.active) throw new UserError(401, "Your access was removed. Ask your admin.", "not_on_roster");

    const next = randomBytes(32).toString("base64url");
    const id = randomUUID();
    await tx.query(
      `insert into app.sessions (id, user_email, refresh_hash, expires_at, family)
       values ($1, $2, $3, now() + make_interval(days => $4), $5)`,
      [id, s.email, sha256(next), REFRESH_TTL_DAYS, s.family],
    );
    await tx.query("update app.sessions set rotated_at = now(), replaced_by = $2, last_used_at = now() where id = $1", [s.id, id]);
    await tx.query("update app.devices set session_id = $2 where session_id = $1", [s.id, id]);
    const user: RosterUser = { email: s.email, name: s.name, aliases: s.aliases, role: s.role, active: s.active, leadEmail: s.leadEmail };
    return issue(user, id, next);
  });
}

/** Sign-out: this session ends and its device stops getting pushes. */
export async function endSession(sessionId: string): Promise<void> {
  await query("update app.sessions set revoked_at = now() where id = $1 and revoked_at is null", [sessionId]);
  await query("delete from app.devices where session_id = $1", [sessionId]);
}

export interface DeviceInfo {
  platform?: string;
  appVersion?: string;
  osVersion?: number;
  model?: string;
  fcmToken?: string;
}

/** Saves the device's push token (a token moves to whoever signs in on that phone last). */
export async function registerDevice(email: string, sessionId: string, d: DeviceInfo | null | undefined): Promise<void> {
  const token = (d?.fcmToken ?? "").trim();
  if (!token || token.length > 4096) return;
  await query(
    `insert into app.devices (fcm_token, user_email, session_id, platform, app_version, os_version, model)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (fcm_token) do update set user_email = excluded.user_email, session_id = excluded.session_id,
       platform = excluded.platform, app_version = excluded.app_version, os_version = excluded.os_version,
       model = excluded.model, last_seen_at = now()`,
    [token, email, sessionId, (d?.platform ?? "android").slice(0, 20), d?.appVersion?.slice(0, 40) ?? null, d?.osVersion ?? null, d?.model?.slice(0, 80) ?? null],
  );
}
