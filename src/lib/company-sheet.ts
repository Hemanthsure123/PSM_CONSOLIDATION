/**
 * Analysis model for the "Analyze Company Sheet" flow.
 *
 * A *company sheet* tracks every candidate who was sent to a company, with a
 * column per interview round (Assessment Round, TR Round 1, MR Round, Final
 * Status, …). This module turns such a sheet into two funnels:
 *
 *   1. Company-wise funnel — the Edge / Academy / External / Not-tracked split
 *      of everyone sent to the company.
 *   2. Round-wise funnel — how many candidates were sent to each round, with the
 *      same source split at every stage.
 *
 * Source is not present in the sheet itself; it is resolved by matching each
 * candidate against BigQuery `source_track`. A candidate with no warehouse match
 * is classified as **untracked** ("Not tracked anywhere").
 */

import { classifySourceTrack } from "@/lib/source-track";
import { coerceCell } from "@/lib/utils";

export type TrackBucket = "edge" | "academy" | "external" | "untracked";

export const TRACK_BUCKETS: { id: TrackBucket; label: string; color: string }[] = [
  { id: "edge", label: "Edge", color: "#6366f1" },
  { id: "academy", label: "Academy", color: "#10b981" },
  { id: "external", label: "External", color: "#f59e0b" },
  { id: "untracked", label: "Not tracked", color: "#94a3b8" },
];

export function trackColor(id: TrackBucket): string {
  return TRACK_BUCKETS.find((b) => b.id === id)?.color ?? "#94a3b8";
}

export function trackLabel(id: TrackBucket): string {
  return TRACK_BUCKETS.find((b) => b.id === id)?.label ?? "Not tracked";
}

/**
 * Classify a candidate. When they weren't found in BigQuery (`matched=false`)
 * they can't be placed in any of the three source tracks → "untracked".
 */
export function classifyTrack(sourceTrack: string, matched: boolean): TrackBucket {
  if (!matched) return "untracked";
  return classifySourceTrack(sourceTrack);
}

export function emptyCounts(): Record<TrackBucket, number> {
  return { edge: 0, academy: 0, external: 0, untracked: 0 };
}

/** Columns that describe the candidate, not a round — never treated as rounds. */
const IDENTITY_HINT =
  /\b(full\s*)?name\b|mobile|phone|contact|whatsapp|email|mail|college|course|department|degree|graduation|percentage|\bcgpa\b|gender|resume|\bcv\b|current\s*state|city|location|\bdob\b|birth|address|user\s*id|candidate\s*id|student\s*id|father|guardian|branch|\bage\b/i;

/** Columns that look like an interview round / stage / outcome. */
const ROUND_HINT =
  /round|assessment|screening|aptitude|coding|\btest\b|interview|\btr\b|\bmr\b|\bhr\b|technical|managerial|final|status|result|selection|shortlist|offer|verdict|feedback|stage/i;

/**
 * Suggest which headers are round columns: those that read like a round/stage
 * and aren't obvious identity/academic fields. Order is preserved.
 */
export function suggestRoundColumns(headers: string[]): string[] {
  return headers.filter((h) => {
    const s = h.toLowerCase();
    if (IDENTITY_HINT.test(s) && !ROUND_HINT.test(s)) return false;
    return ROUND_HINT.test(s);
  });
}

/** Cell values that mean the candidate has NOT been sent to this round yet. */
const NOT_SENT =
  /^(yet\s*to.*|not\s*(yet|attempted|scheduled|started|reached|conducted|applicable).*|to\s*be\s*(scheduled|decided)|pending\s*schedul.*|tbd|-+)$/i;

/**
 * Whether a candidate was sent to (reached) a round, from its cell value.
 * Non-empty ⇒ sent, except for explicit "yet to / not attempted" placeholders.
 * `coerceCell` already blanks "-", "NA", "N/A", "null", etc.
 */
export function reachedRound(raw: string): boolean {
  const v = coerceCell(raw);
  if (!v) return false;
  return !NOT_SENT.test(v.trim());
}

/** One candidate from the company sheet, decorated with their source bucket. */
export interface AnalyzedCandidate {
  id: string;
  name: string;
  /** Email/phone/etc. used to match against BigQuery. */
  identifier: string;
  subsheet: string;
  bucket: TrackBucket;
  matched: boolean;
  sourceTrack: string;
  /** Per-round cell values, keyed by round column header. */
  rounds: Record<string, string>;
}

/** One stage of the round-wise funnel with its per-bucket composition. */
export interface FunnelStage {
  round: string;
  total: number;
  counts: Record<TrackBucket, number>;
}

/** Result of analysing a company sheet — everything the dashboard needs. */
export interface SheetAnalysis {
  id: string;
  companyName: string;
  sheetTitle: string;
  createdAt: string;
  subsheets: string[];
  roundColumns: string[];
  total: number;
  /** Company-wise source split. */
  company: Record<TrackBucket, number>;
  /** Round-wise funnel, first stage = everyone sent to the company. */
  stages: FunnelStage[];
  candidates: AnalyzedCandidate[];
  /** Non-fatal note (e.g. BigQuery unavailable → all untracked). */
  note?: string;
}

/**
 * Build both funnels from the analysed candidates and the ordered round columns.
 */
export function buildFunnels(
  candidates: AnalyzedCandidate[],
  roundColumns: string[],
): { company: Record<TrackBucket, number>; stages: FunnelStage[] } {
  const company = emptyCounts();
  for (const c of candidates) company[c.bucket]++;

  const stages: FunnelStage[] = [
    { round: "Sent to company", total: candidates.length, counts: { ...company } },
  ];

  for (const col of roundColumns) {
    const counts = emptyCounts();
    let total = 0;
    for (const c of candidates) {
      if (reachedRound(c.rounds[col] ?? "")) {
        counts[c.bucket]++;
        total++;
      }
    }
    stages.push({ round: col, total, counts });
  }

  return { company, stages };
}
