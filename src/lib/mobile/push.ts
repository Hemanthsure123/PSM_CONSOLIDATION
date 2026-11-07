import "server-only";
import { JWT } from "google-auth-library";
import { query } from "@/lib/db/client";
import { env } from "@/lib/env";

/**
 * FCM HTTP v1 pushes through the existing service account (it has "Firebase Cloud Messaging API
 * Admin" in project FCM_PROJECT_ID). Data messages only: the app builds every notification itself
 * (PushMessage in docs/mobile-api.yaml). Each push is recorded in app.notifications; a dedupe key
 * makes sure a reminder goes out once even if two server ticks race.
 */

export type PushKind = "assignment" | "reminder" | "overdue" | "escalation" | "job_update" | "test";

const g = globalThis as unknown as { __fcmAuth?: JWT };

function auth(): JWT {
  g.__fcmAuth ??= new JWT({
    email: process.env.GCP_SERVICE_ACCOUNT_CLIENT_EMAIL,
    key: (process.env.GCP_SERVICE_ACCOUNT_PRIVATE_KEY ?? "").replace(/^["']|["']$/g, "").replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
  });
  return g.__fcmAuth;
}

async function sendOne(token: string, data: Record<string, string>, accessToken: string): Promise<"ok" | "dead" | "error"> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${env.mobile.fcmProjectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { token, data, android: { priority: "HIGH", ttl: "86400s" } } }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res) return "error";
  if (res.ok) return "ok";
  const body = (await res.json().catch(() => ({}))) as { error?: { status?: string; details?: { errorCode?: string }[] } };
  const code = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status ?? "";
  // The app was uninstalled or the token rotated: forget it.
  if (res.status === 404 || code === "UNREGISTERED" || (res.status === 400 && /INVALID_ARGUMENT/.test(code))) return "dead";
  return "error";
}

export interface PushRequest {
  email: string;
  kind: PushKind;
  data: Record<string, string>;
  /** One push per key, ever (e.g. "reminder:half:<taskId>"). Omit for one-offs like tests. */
  dedupeKey?: string;
  taskId?: string;
  jobId?: string;
}

/** Sends to every device of the user. Returns how many devices got it (0 = none signed in). */
export async function pushToUser(p: PushRequest): Promise<{ delivered: number; skipped: boolean }> {
  if (p.dedupeKey) {
    const claimed = await query<{ id: string }>(
      `insert into app.notifications (user_email, kind, task_id, job_id, dedupe_key)
       values ($1, $2, $3, $4, $5) on conflict (dedupe_key) do nothing returning id`,
      [p.email, p.kind, p.taskId ?? null, p.jobId ?? null, p.dedupeKey],
    );
    if (!claimed.length) return { delivered: 0, skipped: true };
  }
  const devices = await query<{ fcm_token: string }>("select fcm_token from app.devices where user_email = $1", [p.email]);
  let delivered = 0;
  let failed = 0;
  if (devices.length) {
    const { token: accessToken } = await auth().getAccessToken();
    if (!accessToken) throw new Error("FCM: no access token for the service account");
    const data = { ...p.data, type: p.kind };
    for (const d of devices) {
      const outcome = await sendOne(d.fcm_token, data, accessToken);
      if (outcome === "ok") delivered++;
      else failed++;
      if (outcome === "dead") await query("delete from app.devices where fcm_token = $1", [d.fcm_token]);
    }
  }
  if (p.dedupeKey) {
    await query("update app.notifications set delivered = $2, failed = $3 where dedupe_key = $1", [p.dedupeKey, delivered, failed]);
  } else {
    await query(
      "insert into app.notifications (user_email, kind, task_id, job_id, delivered, failed) values ($1, $2, $3, $4, $5, $6)",
      [p.email, p.kind, p.taskId ?? null, p.jobId ?? null, delivered, failed],
    );
  }
  return { delivered, skipped: false };
}
