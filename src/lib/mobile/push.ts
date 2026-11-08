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

export type PushKind =
  | "assignment"
  | "reminder"
  | "overdue"
  | "escalation"
  | "job_update"
  | "test"
  | "prep_assigned"
  | "prep_reminder"
  | "prep_overdue"
  | "prep_escalation"
  | "prep_unassigned"
  | "interview_checkin"
  | "prep_digest"
  | "recording_ready"
  | "meeting_reminder"
  | "prep_doc_ready"
  | "team_account";

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

/**
 * The line the app's notification inbox shows for a push (the bell icon). Pushes that carry their
 * own title / body keep them; the others get a plain sentence from their fields.
 */
export function inboxText(kind: PushKind, d: Record<string, string>): { title: string; body: string } {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  if (d.title) return { title: clip(d.title, 200), body: clip(d.body ?? "", 1000) };
  const who = [d.candidate, d.company, d.round].filter(Boolean).join(" · ");
  const company = d.company || "a company";
  const t: Record<PushKind, [string, string]> = {
    assignment: [`New task · ${company}`, d.profilesRequired ? `${d.profilesRequired} profiles required.` : "Open the task to start."],
    reminder: [`Reminder · ${company}`, "This task is still waiting to be started."],
    overdue: [`Overdue · ${company}`, "This task is past its deadline."],
    escalation: [`Escalation · ${company}`, "A task on your team needs attention."],
    job_update: [`${company} · screening ${d.jobStatus ?? "updated"}`, d.earlyShortlist === "true" ? "The early shortlist is ready." : "Open the job for details."],
    test: ["Test notification", "Notifications work on this phone."],
    prep_assigned: [`Prep assigned · ${who || company}`, "Open the prep to get started."],
    prep_reminder: [`Prep due soon · ${who || company}`, "Give the prep before the interview."],
    prep_overdue: [`Prep overdue · ${who || company}`, "This prep is past its time."],
    prep_escalation: [`Prep needs attention · ${who || company}`, "A prep on your team is overdue."],
    prep_unassigned: [`No one on this prep · ${who || company}`, "Assign a mentor."],
    interview_checkin: [`How did the interview go? · ${who || company}`, "Update the candidate's status."],
    prep_digest: ["Your day", ""],
    recording_ready: [`Call recording ready · ${who || company}`, "Its transcript and summary are in the sheet."],
    meeting_reminder: ["Meeting soon", d.company ? `With ${d.company}.` : "Your meeting starts in 10 minutes."],
    prep_doc_ready: [`Prep document ready · ${[d.company, d.round].filter(Boolean).join(" ") || "your prep"}`, "Open it to review."],
    team_account: ["Team Google account needs attention", "An admin should reconnect it in Me → Team."],
  };
  const [title, body] = t[kind] ?? ["Notification", ""];
  return { title: clip(title, 200), body: clip(body, 1000) };
}

/** Only the short string fields go into the inbox row (no URLs longer than needed, nothing nested). */
function inboxData(d: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) if (typeof v === "string" && k !== "title" && k !== "body") out[k] = v.slice(0, 500);
  return out;
}

/** Sends to every device of the user. Returns how many devices got it (0 = none signed in). */
export async function pushToUser(p: PushRequest): Promise<{ delivered: number; skipped: boolean }> {
  const text = inboxText(p.kind, p.data);
  const data = JSON.stringify(inboxData(p.data));
  if (p.dedupeKey) {
    const claimed = await query<{ id: string }>(
      `insert into app.notifications (user_email, kind, task_id, job_id, dedupe_key, title, body, data)
       values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (dedupe_key) do nothing returning id`,
      [p.email, p.kind, p.taskId ?? null, p.jobId ?? null, p.dedupeKey, text.title, text.body, data],
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
      "insert into app.notifications (user_email, kind, task_id, job_id, delivered, failed, title, body, data) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [p.email, p.kind, p.taskId ?? null, p.jobId ?? null, delivered, failed, text.title, text.body, data],
    );
  }
  return { delivered, skipped: false };
}
