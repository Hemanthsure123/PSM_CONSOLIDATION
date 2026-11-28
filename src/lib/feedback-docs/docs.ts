import "server-only";
import { query } from "@/lib/db/client";
import { feedbackSchemaReady } from "@/lib/mobile/pool/schema";
import type { RosterUser } from "@/lib/mobile/roster";
import { type FeedbackContent, periodLabel } from "@/lib/feedback-docs/model";

/**
 * Candidate feedback documents (PSM 1.13.0) — the stored documents and what the app reads about them.
 * Kept apart from service.ts so the pool detail can list them without importing the builder.
 */

export type FeedbackStatus = "draft" | "reviewed" | "shared";

export interface FeedbackDocDto {
  id: string;
  uid: string;
  candidate: string;
  periodFrom: string;
  periodTo: string;
  periodLabel: string;
  url: string;
  title: string;
  version: number;
  status: FeedbackStatus;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  sharedAt: string | null;
  sharedBy: string | null;
  shareCount: number;
  counts: { jobs: number; selected: number; awaited: number; notMovedForward: number; notKnown: number };
  notes: string[];
  whatsappText: string;
  canEdit: boolean;
}

export interface DocRow {
  id: string;
  uid: string;
  period_from: string;
  period_to: string;
  candidate: string;
  external_id: string;
  url: string;
  title: string;
  version: number;
  content: FeedbackContent;
  status: FeedbackStatus;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  shared_by: string | null;
  shared_at: Date | null;
  share_count: number;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

export const DOC_COLS = `id, uid, to_char(period_from, 'YYYY-MM-DD') as period_from, to_char(period_to, 'YYYY-MM-DD') as period_to, candidate, external_id, url, title, version,
  content, status, reviewed_by, reviewed_at, shared_by, shared_at, share_count, created_by, updated_by, created_at, updated_at`;

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

/** The message sent with the PDF (plain text, no emojis, like the team's other WhatsApp messages). */
export function whatsappText(candidate: string, period: string, sender: string): string {
  const hi = firstName(candidate) ? `Hi ${firstName(candidate)},` : "Hi,";
  return [
    hi,
    "",
    `Here is your resume feedback for ${period}: how each application went, why some didn't move forward, and what to work on next.`,
    "",
    'Please read it fully and start on the points under "What to Improve". We are here to help you get placed.',
    "",
    sender,
    "NxtWave Placements",
  ].join("\n");
}

export const namesOf = (roster: RosterUser[]) => new Map(roster.map((u) => [u.email, u.name]));

export function toDto(r: DocRow, names: Map<string, string>, me: RosterUser, canEdit: boolean): FeedbackDocDto {
  const name = (e: string | null) => (e ? names.get(e) ?? e : null);
  const c = r.content;
  return {
    id: r.id,
    uid: r.uid,
    candidate: r.candidate,
    periodFrom: r.period_from,
    periodTo: r.period_to,
    periodLabel: c?.period?.short ?? periodLabel(r.period_from, r.period_to, true).label,
    url: r.url,
    title: r.title,
    version: r.version,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    createdBy: name(r.created_by) ?? r.created_by,
    updatedAt: r.updated_at.toISOString(),
    updatedBy: name(r.updated_by) ?? r.updated_by,
    reviewedAt: r.reviewed_at?.toISOString() ?? null,
    reviewedBy: name(r.reviewed_by),
    sharedAt: r.shared_at?.toISOString() ?? null,
    sharedBy: name(r.shared_by),
    shareCount: r.share_count,
    counts: {
      jobs: c?.counts?.jobs ?? 0,
      selected: c?.counts?.selected ?? 0,
      awaited: c?.counts?.awaited ?? 0,
      notMovedForward: c?.counts?.notMovedForward ?? 0,
      notKnown: c?.counts?.notKnown ?? 0,
    },
    notes: Array.isArray(c?.notes) ? c.notes.slice(0, 40) : [],
    whatsappText: whatsappText(r.candidate, c?.period?.label ?? periodLabel(r.period_from, r.period_to).label, me.name),
    canEdit,
  };
}

export async function docsOf(uid: string): Promise<DocRow[]> {
  return query<DocRow>(`select ${DOC_COLS} from app.candidate_feedback_docs where uid = $1 order by period_from desc, period_to desc`, [uid]);
}

export async function docById(id: string): Promise<DocRow | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return (await query<DocRow>(`select ${DOC_COLS} from app.candidate_feedback_docs where id = $1`, [id]))[0] ?? null;
}

/** The candidate's documents for the pool detail (newest period first, at most 5; [] before migration 023). */
export async function feedbackDocsForDetail(user: RosterUser, uid: string, canEdit: boolean, roster: RosterUser[]): Promise<FeedbackDocDto[]> {
  if (!(await feedbackSchemaReady().catch(() => false))) return [];
  const names = namesOf(roster);
  return (await docsOf(uid).catch(() => [])).slice(0, 5).map((r) => toDto(r, names, user, canEdit));
}
