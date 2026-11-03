import type { ParseIssue, Product } from "@/lib/pool/types";

/**
 * Assessment final scores — what is measured, and the shapes shared by the import (server), the
 * database and the Standing lookup. Client-safe.
 *
 * Only ONE final score per assessment is kept (overall_candidate_score, "Total (/15)", "Overall
 * Score (out of 100)" …), never the sections it is made of — with the attempt's verdict, date and
 * (interviews) recording. Everyone the Academy assessed keeps their marks; whether they can be put
 * forward for job opportunities is the JobEligibility tag, derived from the eligible pool.
 */

export const ASSESSMENT_KEYS = [
  "old_offline",
  "dsa_offline",
  "frontend_offline",
  "backend_offline",
  "software_offline",
  "dsa_interview",
  "frontend_interview",
  "backend_interview",
  "software_interview",
  "bucket_a_tr1",
  "bucket_a_tr2",
  "bucket_b_tr1",
  "bucket_b_tr2",
] as const;
export type AssessmentKey = (typeof ASSESSMENT_KEYS)[number];

export interface AssessmentInfo {
  key: AssessmentKey;
  /** "DSA offline exam" — chips, cells, the database catalogue. */
  label: string;
  product: Product;
  /** The usual maximum; a sheet's own maximum (overall_total_score) wins when it has one. */
  max: number;
  kind: "exam" | "interview";
}

/** Catalogue order = the order of the lookup's chips and of a cell's lines. */
export const ASSESSMENTS: AssessmentInfo[] = [
  { key: "old_offline", label: "Old offline assessment", product: "academy", max: 230, kind: "exam" },
  { key: "dsa_offline", label: "DSA offline exam", product: "academy", max: 130, kind: "exam" },
  { key: "frontend_offline", label: "Frontend offline exam", product: "academy", max: 115, kind: "exam" },
  { key: "backend_offline", label: "Backend offline exam", product: "academy", max: 95, kind: "exam" },
  { key: "software_offline", label: "Software Engineering offline exam", product: "academy", max: 215, kind: "exam" },
  { key: "dsa_interview", label: "DSA competency interview", product: "academy", max: 100, kind: "interview" },
  { key: "frontend_interview", label: "Frontend competency interview", product: "academy", max: 100, kind: "interview" },
  { key: "backend_interview", label: "Backend competency interview", product: "academy", max: 100, kind: "interview" },
  { key: "software_interview", label: "Software Engineering competency interview", product: "academy", max: 100, kind: "interview" },
  { key: "bucket_a_tr1", label: "Bucket A TR-1", product: "academy", max: 100, kind: "interview" },
  { key: "bucket_a_tr2", label: "Bucket A TR-2", product: "academy", max: 100, kind: "interview" },
  { key: "bucket_b_tr1", label: "Bucket B TR-1", product: "academy", max: 15, kind: "interview" },
  { key: "bucket_b_tr2", label: "Bucket B TR-2", product: "academy", max: 10, kind: "interview" },
];

const BY_KEY = new Map(ASSESSMENTS.map((a) => [a.key, a]));
export const assessmentInfo = (key: AssessmentKey): AssessmentInfo => BY_KEY.get(key)!;
export const isAssessmentKey = (v: unknown): v is AssessmentKey => typeof v === "string" && BY_KEY.has(v as AssessmentKey);

// ── One person's scores and profile (read side) ─────────────────────────────

export interface AssessmentScore {
  assessment: AssessmentKey;
  score: number;
  maxScore: number;
  /** YYYY-MM-DD, or null when the sheet has no date (the old offline assessment has a cycle). */
  takenOn: string | null;
  /** The sheet's verdict for this attempt: "Qualified", "Cleared", "Bucket A", "L3 · Medium Hire · Cleared" … */
  result: string;
  passed: boolean | null;
  /** The interview's recording, when the sheet has one. */
  recordingUrl: string | null;
  /** Which export it came from ("dsa_offline@2026-10-25") and the attempt inside it. */
  sourceKey: string;
  attempt: string;
}

export interface CandidateProfile {
  yog: number | null;
  college: string;
  degree: string;
  department: string;
}

// ── Job eligibility ─────────────────────────────────────────────────────────

/**
 * Whether a person can be put forward for job opportunities: "eligible" = in the eligible pool
 * (an Edge 2.0, Edge 1.0 or Academy record) with an eligible standing (tier 1–3); everyone else
 * assessed is "not-eligible". Derived, never stored — the database's view placement.assessed_people
 * applies the same rule.
 */
export type JobEligibility = "eligible" | "not-eligible";
export const JOB_ELIGIBILITY_LABEL: Record<JobEligibility, string> = { eligible: "Eligible", "not-eligible": "Not eligible" };
/** The Find filter's choice. */
export type EligibilityFilter = "all" | JobEligibility;
export const isEligibilityFilter = (v: unknown): v is EligibilityFilter => v === "all" || v === "eligible" || v === "not-eligible";

/** A person known to the assessments: a Find result, or someone assessed who isn't in the eligible pool. */
export interface PersonRef {
  candidateId: number;
  phone: string | null;
  userId: string | null;
  name: string;
  eligible: boolean;
}

// ── Import (write side) ─────────────────────────────────────────────────────

export interface ScoreImportResult {
  ok: boolean;
  importId: number | null;
  /** What was imported: "DSA offline exam · 25 Oct 2026". */
  label: string;
  assessment: AssessmentKey | null;
  sourceKey: string;
  mode: "sheet" | "csv";
  rowsRead: number;
  /** Scores written for the first time / changed / already identical / removed (no longer in the source). */
  inserted: number;
  updated: number;
  unchanged: number;
  removed: number;
  /** Rows not stored, by reason: no final score (not attempted, no-show, cancelled …), a test row. */
  skipped: { reason: string; count: number }[];
  /** People with a score in this export, and how many of them are eligible for job opportunities. */
  people: number;
  eligiblePeople: number;
  /** People added to the database by this import (assessed, not known before — only for a real score). */
  peopleAdded: number;
  profiles: number;
  issues: ParseIssue[];
  error: string;
  /** The import would remove many of the scores already stored for this source — resend with allowShrink. */
  needsConfirm?: { existing: number; incoming: number };
  ms: number;
}

export interface ScoreImportRun {
  id: number;
  sourceKey: string;
  assessment: string;
  mode: "sheet" | "csv";
  sourceRef: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  rowsRead: number;
  inserted: number;
  updated: number;
  unchanged: number;
  removed: number;
  peopleAdded: number;
  issueCount: number;
  error: string | null;
}

export interface ScoresSummary {
  configured: boolean;
  /**
   * Per assessment: people with a score (and how many of them are eligible), scores stored
   * (attempts), with a recording, exports imported, newest import.
   */
  assessments: { key: AssessmentKey; people: number; eligible: number; scores: number; recordings: number; sources: number; lastImportAt: string | null }[];
  /**
   * People with marks: eligible for job opportunities (of them in the Academy pool; the rest are in
   * the pool through Edge 2.0 / Edge 1.0), not eligible, and with a college / year on record.
   */
  people: { total: number; eligible: number; eligibleAcademy: number; notEligible: number; withProfile: number };
  /** Colleges and years of graduation with their head counts (largest first), for the lookup's filter. */
  colleges: { college: string; people: number }[];
  yogs: { yog: number; people: number }[];
  recentImports: ScoreImportRun[];
  /** The Google Sheets tabs that can be refetched without a CSV. */
  sheets: { id: string; label: string; sheetUrl: string; tab: string }[];
}
