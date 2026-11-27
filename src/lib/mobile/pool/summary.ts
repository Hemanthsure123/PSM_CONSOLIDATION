import type { ShareOutcome, ShareStatus } from "@/lib/mobile/pool/shares";

/**
 * GET /pool's header summary and mentor groups (PSM 1.10.0). Pure, tested in
 * scripts/academy-shares-selftest.ts.
 *
 * Groups: the caller's own group first (only when they have candidates), then every other mentor
 * A–Z, then "Unassigned". A group's key is the mentor's roster email, or `name:<lower name>` for a
 * sheet mentor who isn't on the roster; the unassigned group's key is "unassigned".
 */

export interface GroupMentor {
  name: string;
  email: string | null;
}

export interface SummaryItem {
  mentor: GroupMentor;
  mine: boolean;
  /** Null when the shares were never synced. */
  sharesCount: number | null;
  /** The most advanced outcome across companies (null: never shared). */
  stage: ShareOutcome | null;
  /** 1.12.0: the most advanced status (when known, it decides the in-process / selected counts). */
  status?: ShareStatus | null;
  upcomingInterviews: number;
}

export interface PoolSummaryDto {
  total: number;
  assigned: number;
  unassigned: number;
  shared: number;
  neverShared: number;
  inProcess: number;
  selected: number;
  upcomingInterviews: number;
}

export interface PoolGroupDto {
  key: string;
  mentor: GroupMentor | null;
  mine: boolean;
  total: number;
  shared: number;
  neverShared: number;
  upcomingInterviews: number;
}

export const UNASSIGNED_KEY = "unassigned";

/** The group a candidate belongs to. */
export function groupKeyOf(m: GroupMentor): string {
  if (m.email) return m.email;
  const name = m.name.replace(/\s+/g, " ").trim().toLowerCase();
  return name ? `name:${name}` : UNASSIGNED_KEY;
}

const isShared = (i: SummaryItem) => (i.sharesCount ?? 0) > 0;
const isNeverShared = (i: SummaryItem) => i.sharesCount === 0;

export function poolSummary(items: SummaryItem[]): PoolSummaryDto {
  const unassigned = items.filter((i) => groupKeyOf(i.mentor) === UNASSIGNED_KEY).length;
  return {
    total: items.length,
    assigned: items.length - unassigned,
    unassigned,
    shared: items.filter(isShared).length,
    neverShared: items.filter(isNeverShared).length,
    inProcess: items.filter((i) => (i.status !== undefined ? i.status === "in_process" || i.status === "awaiting" : i.stage === "in_process")).length,
    selected: items.filter((i) => (i.status !== undefined ? i.status === "selected" : i.stage === "selected")).length,
    upcomingInterviews: items.reduce((n, i) => n + i.upcomingInterviews, 0),
  };
}

export function poolGroups(items: SummaryItem[]): PoolGroupDto[] {
  const groups = new Map<string, PoolGroupDto>();
  for (const i of items) {
    const key = groupKeyOf(i.mentor);
    const g =
      groups.get(key) ??
      { key, mentor: key === UNASSIGNED_KEY ? null : { name: i.mentor.name.trim(), email: i.mentor.email }, mine: false, total: 0, shared: 0, neverShared: 0, upcomingInterviews: 0 };
    g.mine ||= i.mine;
    g.total++;
    if (isShared(i)) g.shared++;
    if (isNeverShared(i)) g.neverShared++;
    g.upcomingInterviews += i.upcomingInterviews;
    groups.set(key, g);
  }
  const all = [...groups.values()];
  const mine = all.filter((g) => g.mine);
  const others = all
    .filter((g) => !g.mine && g.key !== UNASSIGNED_KEY)
    .sort((a, b) => (a.mentor?.name ?? "").localeCompare(b.mentor?.name ?? "", "en", { sensitivity: "base" }) || a.key.localeCompare(b.key));
  const unassigned = all.filter((g) => !g.mine && g.key === UNASSIGNED_KEY);
  return [...mine, ...others, ...unassigned];
}
