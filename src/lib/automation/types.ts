import type { DomainColumnKey } from "@/lib/domain-columns";
import type { DsaGates } from "@/lib/dsa-scoring";

/**
 * Sheet-triggered shortlisting automation — shared shapes (client-safe).
 * See docs/automation.md for the whole flow.
 */

/** What the sheet shows in "Automation Status" (the database stores them lower-case). */
export const JOB_STATUSES = ["pending", "processing", "completed", "failed", "awaiting_review"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const STATUS_LABEL: Record<JobStatus, string> = {
  pending: "PENDING",
  processing: "PROCESSING",
  completed: "COMPLETED",
  failed: "FAILED",
  awaiting_review: "AWAITING_REVIEW",
};
export const isTerminal = (s: JobStatus) => s === "completed" || s === "failed" || s === "awaiting_review";

/** The orchestrator's steps, in order — the job's checkpoint. */
export const JOB_STEPS = ["queued", "planning", "screening", "evaluating", "validating", "delivering", "done"] as const;
export type JobStep = (typeof JOB_STEPS)[number];

export type GithubScopeChoice = "fit" | "all" | "off";

/** The instructions cell, read without any model (instructions.ts). */
export interface ParsedInstructions {
  /** Tab names as written (resolved against the real tabs by the planner). */
  tabs: string[];
  /** Lines that carry no label — tab names or focus text, decided against the real tabs. */
  unlabeled: string[];
  /** What to screen for, in the user's words. */
  focus: string;
  github: GithubScopeChoice;
  githubExplicit: boolean;
  /** null = the default (on when GitHub ranks). */
  review: boolean | null;
  dsa: { use: boolean; explicit: boolean; gates: DsaGates };
  /** "Top 10" in the instructions (null = not given). */
  topN: number | null;
  /** A spreadsheet link in the instructions (overrides the row's Internal Sheets link). */
  sheetUrl: string | null;
}

export interface PlanTab {
  name: string;
  /** 1-based row holding the headers. */
  headerRow: number;
  columns: Record<DomainColumnKey, string>;
  /** Data rows under the header (before filtering for resume links). */
  rows: number;
}

/** The Planner's output — everything the later steps need, stored on the job. */
export interface AutomationPlan {
  version: 1;
  sourceSpreadsheetId: string;
  sourceTitle: string;
  tabs: PlanTab[];
  focus: string;
  domainName: string;
  /** The scoring brief Domain shortlisting judges against (domain name + what defines it). */
  brief: string;
  mandatory: string;
  /** "llm": drafted by the model from the focus text and checked; "focus": the focus text as is (the model wasn't available). */
  briefSource: "llm" | "focus";
  github: GithubScopeChoice;
  review: boolean;
  dsa: { use: boolean; gates: DsaGates };
  /** null = everyone who clears every requirement. */
  topN: number | null;
  topNSource: "instructions" | "profiles-required" | "none";
  /** Assumptions the planner made, shown in the job's details. */
  notes: string[];
}

/** One control-row request, as the server read it from the sheet. */
export interface ControlRequest {
  spreadsheetId: string;
  sheetName: string;
  row: number;
  instructions: string;
  trigger: string;
  /** The row's "Internal Sheets" link (the candidates' spreadsheet). */
  internalSheetUrl: string;
  /** The row's "No. of Profiles Required" ("" when blank). */
  profilesRequired: string;
  companyName: string;
}

export interface JobProgress {
  read?: number;
  screened?: number;
  failed?: number;
  /** Cleared the domain-fit bar. */
  matches?: number;
  /** Cleared the bar AND showed every must-have. */
  mustHaves?: number;
  /** The shortlist was delivered before the full screening finished. */
  shortlistTab?: string;
  shortlistUrl?: string;
  shortlistCount?: number;
  githubDone?: number;
  githubTotal?: number;
  reviewDone?: number;
  reviewTotal?: number;
  waitingUntil?: string;
  note?: string;
}

export interface JobResult {
  destinationTab: string;
  destinationUrl: string;
  sourceTitle: string;
  shortlisted: number;
  requested: number | null;
  read: number;
  scored: number;
  notResumes: number;
  unscored: number;
  duplicates: number;
  flagged: number;
  reviewReasons: string[];
  rowsWritten: number;
  /** Every screened candidate written below the shortlist (complete screening). */
  complete: boolean;
}
