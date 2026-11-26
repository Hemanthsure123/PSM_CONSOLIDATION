import "server-only";
import { query } from "@/lib/db/client";
import { UserError } from "@/lib/mobile/http";
import { pushToUser } from "@/lib/mobile/push";
import { listRoster } from "@/lib/mobile/roster";

/**
 * Sticky notifications: the admin sends one to a mentor from the app; it stays on the mentor's
 * phone (it can't be swiped away) until the mentor taps Acknowledge. The phone also asks for open
 * notices when the app starts, so a notice survives a restart or a cleared notification shade.
 * Normal notifications are untouched.
 */

export interface NoticeDto {
  id: string;
  toEmail: string;
  toName: string;
  title: string;
  body: string;
  sentBy: string;
  sentByName: string;
  createdAt: string;
  /** Phones the push reached when it was sent (0 = the mentor sees it next time the app opens). */
  delivered: number;
  acknowledgedAt: string | null;
}

interface Row {
  id: string;
  to_email: string;
  title: string;
  body: string;
  sent_by: string;
  created_at: Date;
  delivered: number;
  acknowledged_at: Date | null;
}

const toDto = (r: Row, names: Map<string, string>): NoticeDto => ({
  id: r.id,
  toEmail: r.to_email,
  toName: names.get(r.to_email) ?? r.to_email,
  title: r.title,
  body: r.body,
  sentBy: r.sent_by,
  sentByName: names.get(r.sent_by) ?? r.sent_by,
  createdAt: r.created_at.toISOString(),
  delivered: r.delivered,
  acknowledgedAt: r.acknowledged_at?.toISOString() ?? null,
});

const clean = (v: unknown, max: number) => String(v ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim().slice(0, max);

/** Admin: send a sticky notification to one active team member. */
export async function sendNotice(from: { email: string }, body: { to?: unknown; title?: unknown; body?: unknown }): Promise<NoticeDto> {
  const roster = await listRoster();
  const to = String(body.to ?? "").trim().toLowerCase();
  const member = roster.find((u) => u.email === to && u.active);
  if (!member) throw new UserError(422, "Choose a team member.", "invalid_recipient");
  const title = clean(body.title, 120);
  const text = clean(body.body, 1000);
  if (!title) throw new UserError(422, "Add a title.", "no_title");
  if (!text) throw new UserError(422, "Write the message.", "no_body");
  const rows = await query<Row>(
    "insert into app.admin_notices (to_email, title, body, sent_by) values ($1, $2, $3, $4) returning *",
    [member.email, title, text, from.email],
  );
  const notice = rows[0];
  const push = await pushToUser({
    email: member.email,
    kind: "admin_notice",
    data: { noticeId: notice.id, title, body: text, sticky: "true", from: roster.find((u) => u.email === from.email)?.name ?? "Admin" },
    dedupeKey: `admin_notice:${notice.id}`,
  }).catch(() => ({ delivered: 0, skipped: true }));
  await query("update app.admin_notices set delivered = $2 where id = $1", [notice.id, push.delivered]).catch(() => undefined);
  await query("insert into app.audit_log (actor_email, action, target, detail) values ($1, 'admin_notice_sent', $2, $3)", [
    from.email,
    member.email,
    JSON.stringify({ noticeId: notice.id, delivered: push.delivered }),
  ]).catch(() => undefined);
  const names = new Map(roster.map((u) => [u.email, u.name]));
  return toDto({ ...notice, delivered: push.delivered }, names);
}

/** Admin: the notices sent lately, with who acknowledged. */
export async function listNotices(limit = 100): Promise<NoticeDto[]> {
  const [rows, roster] = await Promise.all([
    query<Row>("select * from app.admin_notices order by created_at desc limit $1", [Math.min(200, Math.max(1, limit))]),
    listRoster(),
  ]);
  const names = new Map(roster.map((u) => [u.email, u.name]));
  return rows.map((r) => toDto(r, names));
}

/** The signed-in person's notices not acknowledged yet (the phone shows each as a sticky notification). */
export async function openNotices(email: string): Promise<NoticeDto[]> {
  const [rows, roster] = await Promise.all([
    query<Row>("select * from app.admin_notices where to_email = $1 and acknowledged_at is null order by created_at desc limit 200", [email]),
    listRoster(),
  ]);
  const names = new Map(roster.map((u) => [u.email, u.name]));
  return rows.map((r) => toDto(r, names));
}

/** The recipient acknowledges a notice (idempotent: a second tap answers with the first time). */
export async function acknowledgeNotice(email: string, id: string): Promise<{ id: string; acknowledgedAt: string }> {
  const rows = await query<{ acknowledged_at: Date }>(
    "update app.admin_notices set acknowledged_at = coalesce(acknowledged_at, now()) where id = $1 and to_email = $2 returning acknowledged_at",
    [id, email],
  );
  if (!rows[0]) throw new UserError(404, "This notice isn't yours or no longer exists.", "not_found");
  return { id, acknowledgedAt: rows[0].acknowledged_at.toISOString() };
}
