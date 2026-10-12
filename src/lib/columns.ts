/**
 * Central BigQuery column registry — the single source of truth that maps the
 * application's logical field ids to the physical column names in the
 * `student_profiles` master table.
 *
 * In the new flow the company sheet is driven primarily by the uploaded
 * **internal Google Sheet** (subsheet columns chosen at runtime). BigQuery is an
 * OPTIONAL enrichment source: the user can tick any of the columns below to pull
 * them in, matched by identifier. The `source_track` column is always read
 * (regardless of the user's tick choices) to power the Edge / Academy / External
 * dashboard split.
 *
 * `bq` values are the EXACT physical column names from the BigQuery schema —
 * spaces, casing and the trailing space in "Phone Number " are all significant
 * and are backtick-quoted everywhere they're used in SQL.
 */

export type ColumnCategory = "identity" | "academic" | "assessment" | "interview";

export interface BqColumnDef {
  /** Stable logical id used throughout the app and as the export key. */
  id: string;
  /** Human-readable header shown in the UI and exported sheet. */
  label: string;
  /** EXACT physical BigQuery column name in `student_profiles`. */
  bq: string;
  category: ColumnCategory;
  /** Link columns render as clickable buttons inside the PDF / as links in the grid. */
  isLink?: boolean;
}

/**
 * Every BigQuery column the user may pull into the company sheet. The order here
 * is the order they appear in the picker and the exported sheet.
 */
export const BQ_COLUMNS: BqColumnDef[] = [
  { id: "user_id", label: "User ID", bq: "User ID", category: "identity" },
  { id: "name", label: "Name", bq: "Name", category: "identity" },
  { id: "phone_number", label: "Phone Number", bq: "Phone Number ", category: "identity" },
  { id: "email_id", label: "Email Id", bq: "email id", category: "identity" },
  { id: "source_track", label: "Source Track", bq: "source_track", category: "identity" },
  { id: "gender", label: "Gender", bq: "Gender", category: "identity" },

  { id: "bachelors_college_name", label: "Bachelors College Name", bq: "Bachelors College Name", category: "academic" },
  { id: "bachelors_course_name", label: "Bachelors Course Name", bq: "Bachelors Course Name", category: "academic" },
  { id: "bachelors_department_name", label: "Bachelors Department Name", bq: "Bachelors Department Name", category: "academic" },
  { id: "bachelors_year_of_grad", label: "Bachelors Year of Grad", bq: "Bachelors Year of Grad", category: "academic" },
  { id: "bachelors_percentage", label: "Bachelors %", bq: "Bachelors %", category: "academic" },

  { id: "masters_college_name", label: "Masters College Name", bq: "Masters College Name", category: "academic" },
  { id: "masters_course_name", label: "Masters Course Name", bq: "Masters Course Name", category: "academic" },
  { id: "masters_department_name", label: "Masters Department Name", bq: "Masters Department Name", category: "academic" },
  { id: "masters_year_of_grad", label: "Masters Year of Grad", bq: "Masters Year of Grad", category: "academic" },
  { id: "masters_percentage", label: "Masters %", bq: "Masters %", category: "academic" },

  { id: "assessment_report", label: "Assessment Report", bq: "Assesment report", category: "assessment", isLink: true },
  { id: "assessment_selection_status", label: "Assessment Selection Status", bq: "Assesment Selection Status", category: "assessment" },

  { id: "tr1_selection_status", label: "TR-1 Selection Status", bq: "TR-1 Selection Status", category: "interview" },
  { id: "tr1_recording_link", label: "TR-1 Recording Link", bq: "TR-1 Recording Link if yes", category: "interview", isLink: true },
  { id: "tr2_selection_status", label: "TR-2 Selection Status", bq: "Tr-2 Selection Status", category: "interview" },
  { id: "tr2_recording_link", label: "TR-2 Recording Link", bq: "TR-2 Recording Link if yes", category: "interview", isLink: true },
];

/** The logical id of the column that drives the dashboard split. */
export const SOURCE_TRACK_ID = "source_track";

/**
 * BigQuery columns that feed the report's "Review Links" cards. Always fetched
 * during consolidation so the report has them even if they aren't exported.
 */
export const REPORT_LINK_IDS = ["assessment_report", "tr1_recording_link", "tr2_recording_link"];

/**
 * Columns always read from BigQuery regardless of the user's tick choices.
 * `source_track` is unconditional (it drives the dashboard split); the
 * report-link columns are skipped when the run takes those links from the
 * uploaded sheet instead — see `alwaysFetchIds`.
 */
export const ALWAYS_FETCH_IDS = [SOURCE_TRACK_ID, ...REPORT_LINK_IDS];

/** Always-fetch ids for a run, dropping the report links when sheet-sourced. */
export function alwaysFetchIds(includeReportLinks = true): string[] {
  return includeReportLinks ? ALWAYS_FETCH_IDS : [SOURCE_TRACK_ID];
}

/** Computed column produced by the PDF/Drive pipeline (not from BigQuery). */
export const AI_REPORT_COLUMN = {
  id: "screening_report_link",
  label: "Screening Report",
} as const;

/** Search identifier columns, keyed by identifier type. */
export const SEARCH_COLUMNS: Record<"uuid" | "phone" | "name" | "email", string> = {
  uuid: "User ID",
  phone: "Phone Number ",
  name: "Name",
  email: "email id",
};

/** The internal candidate identifier column (used for keys, dedupe, matching). */
export const CANDIDATE_ID_COLUMN = "User ID";

export function getBqColumn(id: string): BqColumnDef | undefined {
  return BQ_COLUMNS.find((c) => c.id === id);
}
