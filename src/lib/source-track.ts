/**
 * Classification of a candidate's `source_track` (read from BigQuery) into the
 * three buckets the company-sheet dashboard reports on:
 *   - Edge      → NxtWave CCBP / Edge cohort
 *   - Academy   → NxtWave Academy cohort
 *   - External  → anything else (external applicants), incl. unknown/blank
 *
 * The match is intentionally loose (case-insensitive substring) so minor
 * variations in the warehouse value ("edge", "CCBP Edge", "academy_2024", …)
 * still bucket correctly. Adjust the keyword lists if your taxonomy differs.
 */

export type SourceBucket = "edge" | "academy" | "external";

export const SOURCE_BUCKETS: { id: SourceBucket; label: string; color: string }[] = [
  { id: "edge", label: "Edge", color: "#6366f1" },
  { id: "academy", label: "Academy", color: "#10b981" },
  { id: "external", label: "External", color: "#f59e0b" },
];

const EDGE_KEYWORDS = ["edge", "ccbp", "niat"];
const ACADEMY_KEYWORDS = ["academy", "academ"];

export function classifySourceTrack(raw: string | undefined | null): SourceBucket {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return "external";
  if (EDGE_KEYWORDS.some((k) => v.includes(k))) return "edge";
  if (ACADEMY_KEYWORDS.some((k) => v.includes(k))) return "academy";
  return "external";
}

export function bucketLabel(id: SourceBucket): string {
  return SOURCE_BUCKETS.find((b) => b.id === id)?.label ?? "External";
}

export function bucketColor(id: SourceBucket): string {
  return SOURCE_BUCKETS.find((b) => b.id === id)?.color ?? "#f59e0b";
}
