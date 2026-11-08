import "server-only";
import { query } from "@/lib/db/client";
import type { RosterUser } from "@/lib/mobile/roster";

/**
 * The notification inbox behind the app's bell icon: every push the person was sent (kept 180 days
 * by the retention job, migration 012), newest first, with unread ones counted. Rows from before
 * migration 015 have no title; they are skipped (they were never shown in an inbox).
 */

export interface InboxItemDto {
  id: string;
  at: string;
  kind: string;
  title: string;
  body: string;
  data: Record<string, string>;
  read: boolean;
}

const PAGE = 50;

export async function listInbox(user: RosterUser, before: string | null): Promise<{ items: InboxItemDto[]; unread: number; hasMore: boolean }> {
  const cursor = before && /^\d{1,18}$/.test(before) ? before : null;
  const [rows, unread] = await Promise.all([
    query<{ id: string; at: Date; kind: string; title: string; body: string | null; data: Record<string, string> | null; read_at: Date | null }>(
      `select id, at, kind, title, body, data, read_at from app.notifications
        where user_email = $1 and title is not null and ($2::bigint is null or id < $2::bigint)
        order by id desc limit $3`,
      [user.email, cursor, PAGE + 1],
    ),
    unreadCount(user),
  ]);
  return {
    items: rows.slice(0, PAGE).map((r) => ({
      id: String(r.id),
      at: r.at.toISOString(),
      kind: r.kind,
      title: r.title,
      body: r.body ?? "",
      data: r.data ?? {},
      read: r.read_at !== null,
    })),
    unread,
    hasMore: rows.length > PAGE,
  };
}

export async function unreadCount(user: RosterUser): Promise<number> {
  const r = await query<{ n: number }>("select count(*)::int n from app.notifications where user_email = $1 and title is not null and read_at is null", [user.email]);
  return r[0]?.n ?? 0;
}

/** Marks some (ids) or all of the person's notifications read. Returns the unread count left. */
export async function markInboxRead(user: RosterUser, ids: unknown, all: boolean): Promise<number> {
  if (all) {
    await query("update app.notifications set read_at = now() where user_email = $1 and read_at is null", [user.email]);
  } else if (Array.isArray(ids) && ids.length) {
    const list = [...new Set(ids.map(String).filter((x) => /^\d{1,18}$/.test(x)))].slice(0, 200);
    if (list.length) {
      await query("update app.notifications set read_at = now() where user_email = $1 and read_at is null and id = any($2::bigint[])", [user.email, list]);
    }
  }
  return unreadCount(user);
}
