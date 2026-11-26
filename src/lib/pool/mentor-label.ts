import { normalisePhone } from "@/lib/pool/parse";

/**
 * The Mentor column of the shortlisting outputs. Pure and client-safe (tested in
 * scripts/mentor-column-selftest.ts); src/lib/pool/mentors.ts reads the data.
 *
 * The data is the Academy assessed pool (app.pool_candidates: the MENTOR and TechStack cells of
 * the "> 8LPA Assessed Pool" tab, plus the track the mentor chose in the app). The column sits
 * right after Internal Standing:
 *  - "Mentor" in the sheet-automation shortlist (psm_final_shortlisted_<date>) and the Standing
 *    lookup;
 *  - "Assigned Mentor" in Domain shortlisting's CSVs.
 * The value is "<Mentor> · Mentor assigned · <Tech stack>", "<Mentor> · Mentor assigned" when
 * there is no tech stack, and blank when the candidate has no mentor or isn't in the pool.
 *
 * A person is matched by phone (the last 10 digits) first, then UID, then email. The first key
 * that finds a pool row decides, even when that row has no mentor: a phone match never falls
 * through to someone else's UID.
 */

/** The column's header in the sheet-automation shortlist and the Standing lookup. */
export const MENTOR_HEADER = "Mentor";
/** The column's header in Domain shortlisting's CSVs (the owner's wording). */
export const ASSIGNED_MENTOR_HEADER = "Assigned Mentor";
/** The tag between the mentor's name and the tech stack. */
export const MENTOR_ASSIGNED_TAG = "Mentor assigned";
/** The separator between the label's parts. */
export const MENTOR_SEPARATOR = " · ";

/** Mentor labels by "p:<phone>" / "u:<uid>" / "e:<email>". "" = in the pool, no mentor. */
export type MentorLabels = Record<string, string>;

/** Who to look up: any of the three ids (blank or missing ones are skipped). */
export interface MentorRef {
  phone?: string | null;
  userId?: string | null;
  email?: string | null;
}

/** A cell that means "nobody": "-", "NA", "None", "Not assigned" … */
const PLACEHOLDER = /^(?:[-–—._/\s]+|n\s*[/.]?\s*a\.?|nil|none|null|undefined|tbd|tba|not assigned|unassigned|no mentor|yet to assign|yet to be assigned)$/i;

/** The cell's text on one line, trimmed; "" for a blank or placeholder cell. */
export function cleanCell(raw: unknown): string {
  const t = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t && !PLACEHOLDER.test(t) ? t : "";
}

/** "<Mentor> · Mentor assigned · <Tech stack>", or without the tech stack; "" when there's no mentor. */
export function mentorLabel(mentorName: unknown, techStack?: unknown): string {
  const name = cleanCell(mentorName).slice(0, 80);
  if (!name) return "";
  const stack = cleanCell(techStack).slice(0, 120);
  return [name, MENTOR_ASSIGNED_TAG, ...(stack ? [stack] : [])].join(MENTOR_SEPARATOR);
}

/** A label back in its parts (for the screen): the mentor's name and the tech stack. */
export function mentorParts(label: string): { name: string; techStack: string } | null {
  const parts = String(label ?? "").split(MENTOR_SEPARATOR);
  const at = parts.indexOf(MENTOR_ASSIGNED_TAG);
  if (at < 1) return null;
  return { name: parts.slice(0, at).join(MENTOR_SEPARATOR), techStack: parts.slice(at + 1).join(MENTOR_SEPARATOR) };
}

/** The phone's last 10 digits ("+91 98765 43210" → "9876543210"); null when it has fewer. */
export function phoneKey(raw: unknown): string | null {
  const s = String(raw ?? "");
  const p = normalisePhone(s);
  if (p) return p;
  const d = s.replace(/\D/g, "");
  // Longer than a country code + number is more likely two numbers in one cell: no guess.
  return d.length >= 10 && d.length <= 13 ? d.slice(-10) : null;
}

/** A UID / user id, trimmed and lower-cased; null when blank or implausible. */
export function uidKey(raw: unknown): string | null {
  const v = String(raw ?? "").trim().toLowerCase();
  return v && v.length <= 64 && /^[a-z0-9][a-z0-9_-]*$/.test(v) ? v : null;
}

/** An email address, trimmed and lower-cased; null when it isn't one. */
export function emailKey(raw: unknown): string | null {
  const v = String(raw ?? "").trim().toLowerCase();
  return v.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
}

/** One person's keys in matching order: phone, then UID, then email. */
export function mentorKeys(ref: MentorRef | null | undefined): string[] {
  if (!ref) return [];
  const p = phoneKey(ref.phone);
  const u = uidKey(ref.userId);
  const e = emailKey(ref.email);
  return [...(p ? [`p:${p}`] : []), ...(u ? [`u:${u}`] : []), ...(e ? [`e:${e}`] : [])];
}

/**
 * The Mentor cell of one person. Each ref is tried in turn (phone, UID, email), so a caller can
 * pass the sheet's ids first and the matched pool record's ids as a fallback.
 */
export function mentorLabelFor(labels: MentorLabels | null | undefined, ...refs: (MentorRef | null | undefined)[]): string {
  if (!labels) return "";
  for (const ref of refs) {
    for (const k of mentorKeys(ref)) {
      if (Object.prototype.hasOwnProperty.call(labels, k)) return labels[k] ?? "";
    }
  }
  return "";
}

/**
 * A sheet row's Mentor cell: the row's own ids first, then those of the eligible-pool record it
 * matched (`records` keyed "p:<phone>" / "u:<userId>", as /api/pool/lookup returns standings), so
 * a row with only a phone still finds a pool row stored under its UID.
 */
export function mentorForRow(labels: MentorLabels | null | undefined, row: MentorRef, records?: Record<string, MentorRef> | null): string {
  if (!labels) return "";
  const p = phoneKey(row.phone);
  const u = uidKey(row.userId);
  const record = records ? ((p ? records[`p:${p}`] : undefined) ?? (u ? records[`u:${u}`] : undefined)) : undefined;
  return mentorLabelFor(labels, row, record);
}

/** One row of the assessed pool, as the label needs it. */
export interface PoolMentorRow {
  uid: string;
  phone: string | null;
  email: string | null;
  /** The sheet's MENTOR cell ("" = unassigned). */
  mentorName: string | null;
  /** The sheet's TechStack, else the track the mentor chose (as a label); null when neither. */
  techStack: string | null;
  /** Newer rows win a tie between two rows with the same key (ms since epoch). */
  updatedAt?: number;
}

/**
 * The labels of the pool rows, by every key each row has. `displayName` maps the sheet's mentor
 * name to the roster's (null = not on the roster: the sheet's name, trimmed, is used). When two
 * rows share a key, the one with a mentor wins, then the newer one.
 */
export function buildMentorLabels(rows: PoolMentorRow[], displayName: (sheetName: string) => string | null | undefined = () => null): MentorLabels {
  const best = new Map<string, { label: string; at: number }>();
  for (const r of rows) {
    const sheetName = cleanCell(r.mentorName);
    const label = sheetName ? mentorLabel(cleanCell(displayName(sheetName)) || sheetName, r.techStack) : "";
    const at = Number.isFinite(r.updatedAt) ? (r.updatedAt as number) : 0;
    for (const k of mentorKeys({ phone: r.phone, userId: r.uid, email: r.email })) {
      const cur = best.get(k);
      if (!cur || (label && !cur.label) || (Boolean(label) === Boolean(cur.label) && at > cur.at)) best.set(k, { label, at });
    }
  }
  return Object.fromEntries([...best].map(([k, v]) => [k, v.label]));
}
