/**
 * Checks everything the Android app's server side needs, against the real services, without
 * printing a secret (keys show as …last4, tokens are never printed).
 *
 *   npm run mobile:check                      # all checks
 *   npm run mobile:check -- --push <fcmToken> # also send one real test push to that device
 *
 * Checks: MOBILE_JWT_SECRET; GOOGLE_OAUTH_WEB_CLIENT_ID (and that it matches the app's Firebase
 * file when ../psm-android is next to this repo); allowed domains and admins; FCM permission for
 * the service account (a validate-only send: nothing is delivered); ElevenLabs keys (mint a
 * realtime STT single-use token); Deepgram keys (mint a 30 s temporary token). Exit code 1 if any
 * check fails.
 */
import fs from "node:fs";
import path from "node:path";
import { JWT } from "google-auth-library";

try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local: rely on the process environment (CI / Render shell).
}

type Status = "ok" | "warn" | "fail";
const results: { status: Status; name: string; detail: string }[] = [];
const report = (status: Status, name: string, detail: string) => results.push({ status, name, detail });
const mask = (key: string) => (key.length > 8 ? `…${key.slice(-4)}` : "…");
const env = (name: string) => (process.env[name] ?? "").trim().replace(/^["']|["']$/g, "");
const csv = (value: string) => value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Same rule as src/lib/env.ts keyPool: *_API_KEYS, *_API_KEY_1…N, *_API_KEY. */
function keyPool(poolName: string, singleName: string): string[] {
  const numbered = Object.keys(process.env)
    .map((name) => ({ name, n: Number(name.slice(singleName.length + 1)) }))
    .filter(({ name, n }) => name.startsWith(`${singleName}_`) && Number.isInteger(n) && n > 0)
    .sort((a, b) => a.n - b.n)
    .map(({ name }) => process.env[name] ?? "");
  const keys = [...env(poolName).split(","), ...numbered, env(singleName)]
    .map((k) => k.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return Array.from(new Set(keys));
}

function checkJwt() {
  const secret = env("MOBILE_JWT_SECRET");
  if (!secret) return report("fail", "MOBILE_JWT_SECRET", "missing");
  if (secret.length < 32) return report("fail", "MOBILE_JWT_SECRET", `too short (${secret.length} chars, need ≥ 32)`);
  const prod = env("MOBILE_JWT_SECRET_PRODUCTION");
  if (prod && prod === secret) return report("warn", "MOBILE_JWT_SECRET", "same value as the production secret: use a different one locally");
  report("ok", "MOBILE_JWT_SECRET", `set (${secret.length} chars)`);
}

function checkGoogleClient() {
  const id = env("GOOGLE_OAUTH_WEB_CLIENT_ID");
  const m = id.match(/^(\d+)-[a-z0-9]+\.apps\.googleusercontent\.com$/);
  if (!m) return report("fail", "GOOGLE_OAUTH_WEB_CLIENT_ID", id ? "doesn't look like a Google OAuth client id" : "missing");
  const projectNumber = m[1];
  const firebaseFile = path.resolve("..", "psm-android", "app", "src", "debug", "google-services.json");
  if (!fs.existsSync(firebaseFile)) {
    return report("ok", "GOOGLE_OAUTH_WEB_CLIENT_ID", `format ok (project ${projectNumber}); app's Firebase file not found to cross-check`);
  }
  const g = JSON.parse(fs.readFileSync(firebaseFile, "utf8")) as {
    project_info: { project_number: string; project_id: string };
    client: { oauth_client?: { client_id: string; client_type: number }[] }[];
  };
  const webClients = g.client.flatMap((c) => c.oauth_client ?? []).filter((o) => o.client_type === 3).map((o) => o.client_id);
  if (g.project_info.project_number !== projectNumber) {
    return report("fail", "GOOGLE_OAUTH_WEB_CLIENT_ID", `belongs to project ${projectNumber}, but the app's Firebase project is ${g.project_info.project_number}`);
  }
  report(
    webClients.includes(id) ? "ok" : "warn",
    "GOOGLE_OAUTH_WEB_CLIENT_ID",
    webClients.includes(id)
      ? `matches the web client in the app's Firebase file (project ${g.project_info.project_id})`
      : "same project as the app, but not the web client listed in google-services.json",
  );
  const androidClients = g.client.flatMap((c) => c.oauth_client ?? []).filter((o) => o.client_type === 1);
  if (androidClients.length === 0) {
    report(
      "warn",
      "Android SHA-1 in Firebase",
      "google-services.json lists no Android OAuth client. Google sign-in only needs the Android client in Google Cloud " +
        "(package + SHA-1); adding the SHA-1 in Firebase → Project settings → your app is recommended too.",
    );
  }
}

function checkDomains() {
  const domains = csv(env("MOBILE_ALLOWED_EMAIL_DOMAINS")).map((d) => d.replace(/^@/, ""));
  const admins = csv(env("MOBILE_ADMIN_EMAILS"));
  if (domains.length === 0) report("fail", "MOBILE_ALLOWED_EMAIL_DOMAINS", "missing: nobody could sign in");
  else report("ok", "MOBILE_ALLOWED_EMAIL_DOMAINS", domains.join(", "));
  if (admins.length === 0) return report("fail", "MOBILE_ADMIN_EMAILS", "missing: nobody could manage the roster");
  const outside = admins.filter((a) => !domains.includes(a.split("@")[1] ?? ""));
  if (outside.length) report("fail", "MOBILE_ADMIN_EMAILS", `not in an allowed domain: ${outside.join(", ")}`);
  else report("ok", "MOBILE_ADMIN_EMAILS", admins.join(", "));
}

async function fcmAccessToken(): Promise<string> {
  const client = new JWT({
    email: env("GCP_SERVICE_ACCOUNT_CLIENT_EMAIL"),
    key: env("GCP_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
  });
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("no access token returned");
  return token;
}

async function fcmSend(projectId: string, accessToken: string, message: object, validateOnly: boolean) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ validate_only: validateOnly, message }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: { status?: string; message?: string }; name?: string };
  return { status: res.status, body };
}

async function checkFcm(pushToken: string | null) {
  const projectId = env("FCM_PROJECT_ID") || env("GCP_PROJECT_ID");
  if (!projectId) return report("fail", "FCM", "FCM_PROJECT_ID / GCP_PROJECT_ID missing");
  let accessToken: string;
  try {
    accessToken = await fcmAccessToken();
  } catch (e) {
    return report("fail", "FCM credentials", `service account sign-in failed: ${(e as Error).message.slice(0, 160)}`);
  }
  // A validate-only send to a dummy token: INVALID_ARGUMENT means the permission is fine.
  const probe = await fcmSend(projectId, accessToken, { token: "permission-check", data: { type: "test" } }, true);
  const reason = `${probe.body.error?.status ?? probe.status}: ${(probe.body.error?.message ?? "").slice(0, 160)}`;
  if (probe.status === 400 && probe.body.error?.status === "INVALID_ARGUMENT") {
    report("ok", "FCM permission", `${env("GCP_SERVICE_ACCOUNT_CLIENT_EMAIL")} can send to project ${projectId}`);
  } else if (probe.status === 403) {
    return report(
      "fail",
      "FCM permission",
      `${reason}. Grant the service account "Firebase Cloud Messaging API Admin" and enable the Firebase Cloud Messaging API.`,
    );
  } else {
    return report("fail", "FCM permission", reason);
  }

  if (!pushToken) return;
  const deadline = new Date(Date.now() + 30 * 60_000).toISOString();
  const sent = await fcmSend(
    projectId,
    accessToken,
    {
      token: pushToken,
      android: { priority: "HIGH" },
      // Same shape as PushMessage in docs/mobile-api.yaml. "test-notification" is the app's test task id.
      data: { type: "test", taskId: "test-notification", company: "Push test", profilesRequired: "5", deadline },
    },
    false,
  );
  if (sent.status === 200) report("ok", "FCM test push", `delivered to FCM (${sent.body.name?.split("/").pop() ?? "message"})`);
  else report("fail", "FCM test push", `${sent.body.error?.status ?? sent.status}: ${(sent.body.error?.message ?? "").slice(0, 160)}`);
}

async function checkElevenLabs() {
  const keys = keyPool("ELEVENLABS_API_KEYS", "ELEVENLABS_API_KEY");
  if (keys.length === 0) return report("warn", "ElevenLabs", "no keys (voice intake would use Deepgram only)");
  for (const key of keys) {
    const res = await fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", {
      method: "POST",
      headers: { "xi-api-key": key },
      signal: AbortSignal.timeout(20_000),
    }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }) as unknown as Response);
    const text = res.ok ? "" : (await res.text().catch(() => "")).slice(0, 160);
    report(
      res.ok ? "ok" : "fail",
      `ElevenLabs key ${mask(key)}`,
      res.ok ? "can mint realtime speech-to-text tokens" : `HTTP ${res.status} ${text}`,
    );
  }
}

async function checkDeepgram() {
  const keys = keyPool("DEEPGRAM_API_KEYS", "DEEPGRAM_API_KEY");
  if (keys.length === 0) return report("warn", "Deepgram", "no keys (no fallback for voice intake)");
  for (const key of keys) {
    const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl_seconds: 30 }),
      signal: AbortSignal.timeout(20_000),
    }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }) as unknown as Response);
    const text = res.ok ? "" : (await res.text().catch(() => "")).slice(0, 160);
    report(
      res.ok ? "ok" : "fail",
      `Deepgram key ${mask(key)}`,
      res.ok ? "can mint temporary tokens" : `HTTP ${res.status} ${text}${res.status === 403 ? " (the key needs Member role or higher)" : ""}`,
    );
  }
}

async function main() {
  const pushIndex = process.argv.indexOf("--push");
  const pushToken = pushIndex > 0 ? (process.argv[pushIndex + 1] ?? null) : null;

  checkJwt();
  checkGoogleClient();
  checkDomains();
  await checkFcm(pushToken);
  await checkElevenLabs();
  await checkDeepgram();

  const icon: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" };
  for (const r of results) console.log(`${icon[r.status]} ${r.name}: ${r.detail}`);
  const failed = results.filter((r) => r.status === "fail").length;
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll required checks passed.");
  process.exitCode = failed ? 1 : 0;
}

void main();
