import "server-only";
import { google, type Auth } from "googleapis";
import { query } from "@/lib/db/client";
import { decryptSecret, encryptSecret } from "@/lib/team/secret";

/**
 * The team Google account (GOOGLE_WORKSPACE_ACCOUNT, e.g. mockinterviews2@nxtwave.tech). An admin
 * connects it once (Google consent, offline access); the server keeps its refresh token
 * encrypted in app.integrations and uses it for every prep document, Meet link, calendar invite
 * and email — whoever taps the button in the app. Reading the sheets and source documents stays
 * with the service account.
 *
 * A password change on the team account revokes the token: the next call marks the integration
 * "broken" and admins are asked to reconnect.
 */

export const TEAM_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/meetings.space.created",
  "https://www.googleapis.com/auth/meetings.space.settings",
];

/** The scopes the features can't work without (openid / email are only for the identity check). */
const REQUIRED = TEAM_SCOPES.filter((s) => s.includes("googleapis.com/auth/") && !s.endsWith("userinfo.email"));

export class TeamAccountError extends Error {
  constructor(
    message: string,
    readonly code: "not_configured" | "not_connected" | "broken" | "wrong_account" | "missing_scopes",
  ) {
    super(message);
  }
}

/** A pasted client id may carry "http://" and a trailing "/": keep only the id itself. */
export function cleanClientId(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

export function teamConfig() {
  const account = (process.env.GOOGLE_WORKSPACE_ACCOUNT ?? "").trim().toLowerCase();
  const clientId = cleanClientId(process.env.GOOGLE_TEAM_OAUTH_CLIENT_ID ?? "");
  const clientSecret = (process.env.GOOGLE_TEAM_OAUTH_CLIENT_SECRET ?? "").trim();
  return { account, clientId, clientSecret, configured: Boolean(account && clientId && clientSecret) };
}

function oauth(redirectUri?: string): Auth.OAuth2Client {
  const c = teamConfig();
  if (!c.configured) {
    throw new TeamAccountError(
      "The team Google account isn't set up on the server (GOOGLE_WORKSPACE_ACCOUNT, GOOGLE_TEAM_OAUTH_CLIENT_ID, GOOGLE_TEAM_OAUTH_CLIENT_SECRET).",
      "not_configured",
    );
  }
  return new google.auth.OAuth2(c.clientId, c.clientSecret, redirectUri);
}

export function consentUrl(redirectUri: string, state: string): string {
  return oauth(redirectUri).generateAuthUrl({
    access_type: "offline",
    // Always ask, so Google returns a refresh token even if the account consented before.
    prompt: "consent",
    include_granted_scopes: false,
    scope: TEAM_SCOPES,
    login_hint: teamConfig().account,
    state,
  });
}

/** Finishes the consent: checks the account and the scopes, stores the refresh token. */
export async function completeConsent(code: string, redirectUri: string, adminEmail: string): Promise<{ account: string }> {
  const client = oauth(redirectUri);
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new TeamAccountError("Google didn't return a long-term permission. Try connecting again.", "not_connected");
  if (!tokens.id_token) throw new TeamAccountError("Google didn't confirm which account signed in. Try again.", "not_connected");
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: teamConfig().clientId });
  const email = ticket.getPayload()?.email?.toLowerCase() ?? "";
  if (email !== teamConfig().account) {
    // Don't keep a token for the wrong account: revoke it at once.
    await client.revokeToken(tokens.refresh_token).catch(() => undefined);
    throw new TeamAccountError(`You signed in as ${email || "another account"}. Sign in as ${teamConfig().account}.`, "wrong_account");
  }
  const granted = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
  const missing = REQUIRED.filter((s) => !granted.includes(s));
  if (missing.length) {
    await client.revokeToken(tokens.refresh_token).catch(() => undefined);
    throw new TeamAccountError(
      `Some permissions weren't granted (${missing.map((s) => s.split("/").pop()).join(", ")}). Connect again and tick every box.`,
      "missing_scopes",
    );
  }
  await query(
    `insert into app.integrations (provider, account_email, refresh_token_enc, scopes, status, last_error, connected_by, connected_at, last_ok_at)
     values ('google_team', $1, $2, $3, 'connected', null, $4, now(), now())
     on conflict (provider) do update set account_email = excluded.account_email, refresh_token_enc = excluded.refresh_token_enc,
       scopes = excluded.scopes, status = 'connected', last_error = null, connected_by = excluded.connected_by,
       connected_at = now(), last_ok_at = now()`,
    [email, encryptSecret(tokens.refresh_token), granted, adminEmail],
  );
  g.__teamAuth = undefined;
  return { account: email };
}

export interface TeamStatus {
  configured: boolean;
  account: string;
  connected: boolean;
  status: "not_configured" | "not_connected" | "connected" | "broken";
  connectedBy: string | null;
  connectedAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
}

export async function teamStatus(): Promise<TeamStatus> {
  const c = teamConfig();
  const rows = await query<{ account_email: string; status: string; connected_by: string; connected_at: Date; last_ok_at: Date | null; last_error: string | null }>(
    "select account_email, status, connected_by, connected_at, last_ok_at, last_error from app.integrations where provider = 'google_team'",
  );
  const r = rows[0];
  const sameAccount = r && r.account_email === c.account;
  return {
    configured: c.configured,
    account: c.account,
    connected: Boolean(sameAccount && r.status === "connected"),
    status: !c.configured ? "not_configured" : !sameAccount ? "not_connected" : r.status === "broken" ? "broken" : "connected",
    connectedBy: r?.connected_by ?? null,
    connectedAt: r?.connected_at?.toISOString() ?? null,
    lastOkAt: r?.last_ok_at?.toISOString() ?? null,
    lastError: r?.last_error ?? null,
  };
}

const g = globalThis as unknown as { __teamAuth?: { at: number; client: Auth.OAuth2Client } };

/** An authorised client for the team account. Throws TeamAccountError with a sentence when it can't. */
export async function teamAuth(): Promise<Auth.OAuth2Client> {
  if (g.__teamAuth && Date.now() - g.__teamAuth.at < 10 * 60_000) return g.__teamAuth.client;
  const c = teamConfig();
  const rows = await query<{ account_email: string; refresh_token_enc: string; status: string }>(
    "select account_email, refresh_token_enc, status from app.integrations where provider = 'google_team'",
  );
  const r = rows[0];
  if (!c.configured) oauth();
  if (!r || r.account_email !== c.account) {
    throw new TeamAccountError(`The team Google account (${c.account}) isn't connected yet. An admin can connect it in Me → Team.`, "not_connected");
  }
  if (r.status === "broken") {
    throw new TeamAccountError(`The team Google account (${c.account}) needs to be reconnected (its permission was revoked, e.g. by a password change).`, "broken");
  }
  const client = oauth();
  client.setCredentials({ refresh_token: decryptSecret(r.refresh_token_enc) });
  g.__teamAuth = { at: Date.now(), client };
  return client;
}

/** Runs a team-account call; a revoked permission marks the integration broken (and tells admins once). */
export async function withTeam<T>(work: (auth: Auth.OAuth2Client) => Promise<T>): Promise<T> {
  const auth = await teamAuth();
  try {
    const out = await work(auth);
    void query("update app.integrations set last_ok_at = now() where provider = 'google_team' and (last_ok_at is null or last_ok_at < now() - interval '5 minutes')").catch(() => undefined);
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/invalid_grant|Token has been expired or revoked|unauthorized_client/i.test(msg)) {
      g.__teamAuth = undefined;
      await query("update app.integrations set status = 'broken', last_error = $1 where provider = 'google_team'", [msg.slice(0, 300)]).catch(() => undefined);
      throw new TeamAccountError(`The team Google account (${teamConfig().account}) needs to be reconnected (its permission was revoked).`, "broken");
    }
    throw err;
  }
}
