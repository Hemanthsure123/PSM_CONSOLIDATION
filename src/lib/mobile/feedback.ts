import "server-only";
import { query } from "@/lib/db/client";
import { UserError } from "@/lib/mobile/http";
import { pushToUser } from "@/lib/mobile/push";
import { listRoster, type RosterUser } from "@/lib/mobile/roster";

/**
 * "Report feedback" (migration 019): anyone signed in sends a problem, an idea or anything else;
 * every active admin gets it at once as a "feedback" push (a heads-up notification on the phone)
 * and reads the list in Me → Feedback. 10 per person per hour.
 */

export type FeedbackCategory = "problem" | "idea" | "other";
export const FEEDBACK_CATEGORIES: FeedbackCategory[] = ["problem", "idea", "other"];
const LABEL: Record<FeedbackCategory, string> = { problem: "Problem", idea: "Idea", other: "Other" };
export const MAX_MESSAGE = 2000;
const PER_HOUR = 10;

export interface FeedbackInput {
  category: FeedbackCategory;
  message: string;
  screen: string | null;
  appVersion: string | null;
  device: string | null;
}

const line = (v: unknown, max: number): string | null => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
  return s || null;
};

/** The request body, checked: 422 invalid_category / no_message. The message keeps its line breaks. */
export function cleanFeedback(body: unknown): FeedbackInput {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const category = String(b.category ?? "").trim().toLowerCase() as FeedbackCategory;
  if (!FEEDBACK_CATEGORIES.includes(category)) throw new UserError(422, "Pick Problem, Idea or Other.", "invalid_category");
  const message = String(typeof b.message === "string" ? b.message : "").replace(/\r\n/g, "\n").trim();
  if (!message) throw new UserError(422, "Write what happened or what you'd like.", "no_message");
  if (message.length > MAX_MESSAGE) throw new UserError(422, `Keep it to ${MAX_MESSAGE} characters.`, "too_long");
  return { category, message, screen: line(b.screen, 100), appVersion: line(b.appVersion, 40), device: line(b.device, 120) };
}

/** The push an admin gets: "Feedback from Asha · Problem" and the first 300 characters. */
export function feedbackPush(id: string, fromName: string, f: Pick<FeedbackInput, "category" | "message">): Record<string, string> {
  const flat = f.message.replace(/\s+/g, " ").trim();
  return {
    feedbackId: id,
    from: fromName,
    category: f.category,
    title: `Feedback from ${fromName} · ${LABEL[f.category]}`,
    body: flat.length > 300 ? `${flat.slice(0, 299)}…` : flat,
  };
}

/** Before migration 019 the table doesn't exist: say so instead of a bare 500. */
function notReady(err: unknown): never {
  if (/relation "app\.feedback" does not exist/.test(err instanceof Error ? err.message : String(err))) {
    throw new UserError(503, "Feedback isn't set up on the server yet. Tell your admin.", "not_ready");
  }
  throw err;
}

/** POST /feedback: stores it and pushes every active admin. 429 too_many past 10 an hour. */
export async function submitFeedback(user: RosterUser, body: unknown): Promise<{ id: string }> {
  const f = cleanFeedback(body);
  const recent = await query<{ n: number }>(
    "select count(*)::int n from app.feedback where from_email = $1 and created_at > now() - interval '1 hour'",
    [user.email],
  ).catch(notReady);
  if ((recent[0]?.n ?? 0) >= PER_HOUR) throw new UserError(429, "That's a lot of feedback in an hour. Try again a bit later.", "too_many");
  const rows = await query<{ id: string }>(
    "insert into app.feedback (from_email, category, message, screen, app_version, device) values ($1, $2, $3, $4, $5, $6) returning id",
    [user.email, f.category, f.message, f.screen, f.appVersion, f.device],
  ).catch(notReady);
  const id = rows[0].id;
  const roster = await listRoster();
  const fromName = roster.find((u) => u.email === user.email)?.name ?? user.name;
  const data = feedbackPush(id, fromName, f);
  for (const admin of roster.filter((u) => u.active && u.role === "admin")) {
    // A push that fails is still in the admin's list (GET /admin/feedback).
    await pushToUser({ email: admin.email, kind: "feedback", data, dedupeKey: `feedback:${id}:${admin.email}` }).catch((err) =>
      console.warn("[mobile] feedback push failed:", err instanceof Error ? err.message.slice(0, 200) : err),
    );
  }
  return { id };
}

export interface FeedbackDto {
  id: string;
  fromEmail: string;
  fromName: string;
  category: FeedbackCategory;
  message: string;
  screen: string | null;
  appVersion: string | null;
  device: string | null;
  createdAt: string;
  readAt: string | null;
}

interface Row {
  id: string;
  from_email: string;
  category: FeedbackCategory;
  message: string;
  screen: string | null;
  app_version: string | null;
  device: string | null;
  created_at: Date;
  read_at: Date | null;
}

/** GET /admin/feedback: newest first, up to 200, and how many are unread (of all). */
export async function listFeedback(): Promise<{ items: FeedbackDto[]; unread: number }> {
  const [rows, unread, roster] = await Promise.all([
    query<Row>("select * from app.feedback order by created_at desc limit 200").catch(notReady),
    query<{ n: number }>("select count(*)::int n from app.feedback where read_at is null").catch(notReady),
    listRoster(),
  ]);
  const names = new Map(roster.map((u) => [u.email, u.name]));
  return {
    items: rows.map((r) => ({
      id: r.id,
      fromEmail: r.from_email,
      fromName: names.get(r.from_email) ?? r.from_email,
      category: r.category,
      message: r.message,
      screen: r.screen,
      appVersion: r.app_version,
      device: r.device,
      createdAt: r.created_at.toISOString(),
      readAt: r.read_at?.toISOString() ?? null,
    })),
    unread: unread[0]?.n ?? 0,
  };
}

/** POST /admin/feedback/{id}/read: idempotent (a second call answers with the first time). */
export async function markFeedbackRead(id: string): Promise<{ id: string; readAt: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new UserError(404, "This feedback no longer exists.", "not_found");
  const rows = await query<{ read_at: Date }>(
    "update app.feedback set read_at = coalesce(read_at, now()) where id = $1 returning read_at",
    [id],
  ).catch(notReady);
  if (!rows[0]) throw new UserError(404, "This feedback no longer exists.", "not_found");
  return { id, readAt: rows[0].read_at.toISOString() };
}
