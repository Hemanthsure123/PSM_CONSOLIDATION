import { BQ_COLUMNS, getBqColumn, AI_REPORT_COLUMN } from "@/lib/columns";
import { normalizeIdentifier } from "@/lib/utils";
import { classifySourceTrack, type SourceBucket } from "@/lib/source-track";
import type {
  BucketCount,
  CandidateDetail,
  CompanySummary,
  ConsolidatedRow,
  IdentifierType,
  ReportSections,
  ReviewLinkSource,
  ReviewValues,
  SubsheetSummary,
} from "@/lib/types";
import type { EnrichedRow } from "@/actions/bigquery";

export type ReportStatus = "idle" | "pending" | "done" | "error";

/** Sheet headers holding each interview/assessment value ("" = not mapped). */
export type ReviewColumnMap = Record<keyof ReviewValues, string>;

export const EMPTY_REVIEW_COLUMNS: ReviewColumnMap = {
  tr1Recording: "",
  tr2Recording: "",
  assessmentReport: "",
  tr1Panel: "",
  tr2Panel: "",
  tr1PanelLinkedin: "",
  tr2PanelLinkedin: "",
};

/**
 * The mappable review fields, in the order they appear in the Database step.
 * `group` drives the UI: "links" are only mapped when the run reads links from
 * the sheet; "panel" fields always come from the sheet.
 */
export const REVIEW_FIELDS: {
  key: keyof ReviewValues;
  label: string;
  hint: string;
  group: "links" | "panel";
}[] = [
  { key: "tr1Recording", label: "TR-1 Recording Link", hint: "Video link for Technical Round 1", group: "links" },
  { key: "tr2Recording", label: "TR-2 Recording Link", hint: "Video link for Technical Round 2", group: "links" },
  { key: "assessmentReport", label: "Assessment Report", hint: "Skill assessment report link", group: "links" },
  { key: "tr1Panel", label: "TR-1 Panel Name", hint: "Interviewer shown on the TR-1 card", group: "panel" },
  { key: "tr1PanelLinkedin", label: "TR-1 Panel LinkedIn", hint: "Profile link for the TR-1 interviewer", group: "panel" },
  { key: "tr2Panel", label: "TR-2 Panel Name", hint: "Interviewer shown on the TR-2 card", group: "panel" },
  { key: "tr2PanelLinkedin", label: "TR-2 Panel LinkedIn", hint: "Profile link for the TR-2 interviewer", group: "panel" },
];

/** Every header across the selected subsheets, de-duplicated in first-seen order. */
export function availableHeaders(state: WizardState): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sub of state.subsheets) {
    if (!sub.selected) continue;
    for (const h of sub.headers) {
      if (h && !seen.has(h)) {
        seen.add(h);
        out.push(h);
      }
    }
  }
  return out;
}

/**
 * Best-guess mapping of sheet headers to the review fields. Recording/report
 * patterns require a link-ish word so a bare "TR-1 Status" column is not picked
 * up; panel patterns match the interviewer-name columns.
 */
const R1 = String.raw`(tr[\s._-]*1|round[\s._-]*1|technical[\s._-]*1)`;
const R2 = String.raw`(tr[\s._-]*2|round[\s._-]*2|technical[\s._-]*2)`;
const PANEL = String.raw`(panel|interviewer|taken\s*by|conducted)`;

const REVIEW_PATTERNS: { key: keyof ReviewValues; re: RegExp; exclude?: RegExp }[] = [
  { key: "tr1Recording", re: new RegExp(`${R1}.*(recording|video|link|url)`, "i"), exclude: /linked|panel|interviewer/i },
  { key: "tr2Recording", re: new RegExp(`${R2}.*(recording|video|link|url)`, "i"), exclude: /linked|panel|interviewer/i },
  { key: "assessmentReport", re: /assess?ment.*(report|link|url|result)/i },
  // Panel NAME must not swallow the panel's LinkedIn column.
  { key: "tr1Panel", re: new RegExp(`${R1}.*${PANEL}`, "i"), exclude: /linked|profile|url|http/i },
  { key: "tr2Panel", re: new RegExp(`${R2}.*${PANEL}`, "i"), exclude: /linked|profile|url|http/i },
  { key: "tr1PanelLinkedin", re: new RegExp(`${R1}.*linked`, "i") },
  { key: "tr2PanelLinkedin", re: new RegExp(`${R2}.*linked`, "i") },
];

export function detectReviewColumns(headers: string[]): ReviewColumnMap {
  const map: ReviewColumnMap = { ...EMPTY_REVIEW_COLUMNS };
  for (const { key, re, exclude } of REVIEW_PATTERNS) {
    const hit = headers.find((h) => re.test(h) && !(exclude?.test(h) ?? false));
    if (hit) map[key] = hit;
  }
  // A lone "Panel"/"Interviewer" column (no round in the name) applies to TR-1.
  if (!map.tr1Panel) {
    const generic = headers.find((h) => /^(panel|interviewer)/i.test(h.trim()) && !/linked|profile/i.test(h));
    if (generic) map.tr1Panel = generic;
  }
  // Likewise for a lone "Panel LinkedIn". A bare "LinkedIn" header is NOT taken:
  // in these sheets that is the candidate's own profile, not the interviewer's.
  if (!map.tr1PanelLinkedin) {
    const generic = headers.find((h) => /(panel|interviewer).*linked/i.test(h));
    if (generic) map.tr1PanelLinkedin = generic;
  }
  return map;
}

export interface ReportState {
  status: ReportStatus;
  link?: string;
  error?: string;
  /** Where the PDF was stored — "drive" (shareable) or "local" (fallback). */
  storage?: "drive" | "local";
}

/** Per-candidate Skill Set & Evaluation Remarks generation state. */
export interface ScreeningState {
  status: ReportStatus;
  skillSet?: string;
  remarks?: string;
  error?: string;
}

/** Per-subsheet configuration captured in the Subsheets step. */
export interface SubsheetConfig {
  name: string;
  headers: string[];
  rowCount: number;
  /** Whether this subsheet is included in the consolidation. */
  selected: boolean;
  /** Headers to pull into the company sheet. */
  selectedColumns: string[];
  /** Formatted, company-facing label per header (e.g. "Mail Id"). */
  columnLabels: Record<string, string>;
  /** Header used as the identifier for BigQuery matching. */
  identifierColumn: string;
  identifierType: IdentifierType;
  /** Header holding the resume URL. */
  resumeColumn: string;
  /** Loaded data rows (populated when the subsheet is read). */
  rows: Record<string, string>[];
  loaded: boolean;
}

export interface WizardState {
  companyName: string;
  spreadsheetUrl: string;
  spreadsheetTitle: string;
  subsheets: SubsheetConfig[];

  /** Whether to pull any BigQuery enrichment columns. */
  useBigQuery: boolean;
  selectedBqColumnIds: string[];

  /**
   * Where the report's TR-1/TR-2 recordings and assessment report links come
   * from. When "sheet", those columns are not queried from BigQuery at all and
   * are read from `reviewColumns` on the uploaded sheet instead. Panel names
   * always come from the sheet, whichever source is chosen.
   */
  reviewLinkSource: ReviewLinkSource;
  reviewColumns: ReviewColumnMap;

  /** Screening criteria used to tailor report highlights. */
  jobDescription: string;
  mandatorySkills: string;
  optionalSkills: string;
  /** Optional "Technical Work" subsections to include in the report. */
  reportSections: ReportSections;

  /** Final consolidated pool (built when entering Preview). */
  consolidated: ConsolidatedRow[];
  bqMatchedCount: number;
  bqQueriedCount: number;
  enrichmentNote: string;

  generatePdf: boolean;
  reports: Record<string, ReportState>;

  /**
   * Skill Set & Evaluation Remarks columns — an alternative to PDF reports that
   * emits two consolidation columns instead of a document. `columnOptions`
   * controls whether LeetCode/Codeforces solved counts are mentioned (only when
   * their combined total exceeds the threshold).
   */
  generateColumns: boolean;
  columnOptions: { leetcode: boolean; codeforces: boolean };
  screening: Record<string, ScreeningState>;
}

export const INITIAL_STATE: WizardState = {
  companyName: "",
  spreadsheetUrl: "",
  spreadsheetTitle: "",
  subsheets: [],
  useBigQuery: true,
  selectedBqColumnIds: ["bachelors_college_name", "bachelors_percentage"],
  reviewLinkSource: "bigquery",
  reviewColumns: { ...EMPTY_REVIEW_COLUMNS },
  jobDescription: "",
  mandatorySkills: "",
  optionalSkills: "",
  reportSections: { skills: true, github: true, leetcode: true, portfolio: true, otherLinks: true },
  consolidated: [],
  bqMatchedCount: 0,
  bqQueriedCount: 0,
  enrichmentNote: "",
  generatePdf: true,
  reports: {},
  generateColumns: true,
  columnOptions: { leetcode: false, codeforces: false },
  screening: {},
};

export const WIZARD_STEPS = [
  { title: "Setup", description: "Company & sheet" },
  { title: "Subsheets", description: "Pick tabs & columns" },
  { title: "Database", description: "BigQuery columns" },
  { title: "Preview", description: "Consolidate & reports" },
  { title: "Export", description: "Company sheet" },
];

export { BQ_COLUMNS, getBqColumn };

/** Title-case a raw sheet header into a clean, company-facing label. */
export function prettyLabel(header: string): string {
  return header
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Canonical labels for auto-detected identity/resume columns. */
export const CANONICAL_LABELS = {
  name: "Name",
  email: "Mail Id",
  phone: "Phone Number",
  resume: "Resume",
} as const;

/** Display priority so the company sheet leads with Name, Phone, Mail Id, Resume. */
const LABEL_PRIORITY: Record<string, number> = {
  Name: 1,
  "Phone Number": 2,
  "Mail Id": 3,
  Resume: 4,
};

/** The company sheet's display name / file name: "<company> || Nxtwave". */
export function companySheetName(companyName: string): string {
  const c = companyName.trim() || "Company";
  return `${c} || Nxtwave`;
}

export interface ExportColumn {
  /** Where to read the value from on a consolidated row. */
  source: "sheet" | "bq" | "report" | "screening";
  /** Key within that source (header for sheet, logical id for bq). */
  key: string;
  label: string;
  isLink: boolean;
}

/**
 * The ordered columns of the company sheet:
 *   selected sheet columns (union across selected subsheets, first-seen order)
 *   → selected BigQuery columns → AI Screening Report Link (if PDFs on).
 */
export function exportColumns(state: WizardState): ExportColumn[] {
  const cols: ExportColumn[] = [];
  const seen = new Set<string>();

  // Gather sheet columns across selected subsheets with formatted labels, then
  // order them so the company-facing sheet leads with Name / Phone / Mail / Resume.
  const sheetCols: ExportColumn[] = [];
  for (const sub of state.subsheets) {
    if (!sub.selected) continue;
    for (const header of sub.selectedColumns) {
      const k = `sheet:${header}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const label = sub.columnLabels?.[header] || prettyLabel(header);
      const isLink = label === CANONICAL_LABELS.resume || /resume|link|url|recording|report/i.test(label);
      sheetCols.push({ source: "sheet", key: header, label, isLink });
    }
  }
  sheetCols.sort((a, b) => (LABEL_PRIORITY[a.label] ?? 99) - (LABEL_PRIORITY[b.label] ?? 99));
  cols.push(...sheetCols);

  if (state.useBigQuery) {
    for (const id of state.selectedBqColumnIds) {
      const col = getBqColumn(id);
      if (!col) continue;
      const k = `bq:${id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      cols.push({ source: "bq", key: id, label: col.label, isLink: Boolean(col.isLink) });
    }
  }

  if (state.generatePdf) {
    cols.push({ source: "report", key: AI_REPORT_COLUMN.id, label: AI_REPORT_COLUMN.label, isLink: true });
  }

  if (state.generateColumns) {
    cols.push({ source: "screening", key: "skillSet", label: "Skill Set", isLink: false });
    cols.push({ source: "screening", key: "remarks", label: "Evaluation Remarks", isLink: false });
  }

  return cols;
}

/** Read a consolidated row's value for a given export column. */
export function cellValue(row: ConsolidatedRow, col: ExportColumn, state: WizardState): string {
  if (col.source === "sheet") return row.sheetValues[col.key] ?? "";
  if (col.source === "bq") return row.bqValues[col.key] ?? "";
  if (col.source === "screening") {
    const s = state.screening[row.id];
    if (!s) return "";
    return (col.key === "skillSet" ? s.skillSet : s.remarks) ?? "";
  }
  return state.reports[row.id]?.link ?? "";
}

/**
 * Merge the loaded subsheet rows with BigQuery enrichment matches into the final
 * consolidated pool. `matchesByType` is keyed by identifier type → (normalized
 * identifier → enriched data).
 */
export function assembleConsolidated(
  state: WizardState,
  matchesByType: Partial<Record<IdentifierType, Record<string, EnrichedRow>>>,
): ConsolidatedRow[] {
  const out: ConsolidatedRow[] = [];

  for (const sub of state.subsheets) {
    if (!sub.selected || !sub.loaded) continue;
    sub.rows.forEach((raw, i) => {
      const identifier = (raw[sub.identifierColumn] ?? "").trim();
      const resumeUrl = (raw[sub.resumeColumn] ?? "").trim();

      const sheetValues: Record<string, string> = {};
      for (const h of sub.selectedColumns) sheetValues[h] = raw[h] ?? "";

      // Read the mapped review columns from the RAW row — these feed the report
      // whether or not the user exported them as sheet columns.
      const reviewValues = { ...EMPTY_REVIEW_COLUMNS } as ReviewValues;
      for (const { key: field } of REVIEW_FIELDS) {
        const header = state.reviewColumns?.[field] ?? "";
        reviewValues[field] = header ? (raw[header] ?? "").trim() : "";
      }

      const key = normalizeIdentifier(identifier, sub.identifierType);
      const match = matchesByType[sub.identifierType]?.[key];

      out.push({
        id: identifier || `${sub.name}-${i}`,
        company: state.companyName.trim(),
        subsheet: sub.name,
        sheetValues,
        bqValues: match?.values ?? {},
        identifier,
        resumeUrl,
        sourceTrack: match?.sourceTrack ?? "",
        matched: Boolean(match),
        reviewValues,
      });
    });
  }

  return out;
}

/** Group identifiers by their identifier type across all selected subsheets. */
export function identifiersByType(state: WizardState): Partial<Record<IdentifierType, string[]>> {
  const map: Partial<Record<IdentifierType, string[]>> = {};
  for (const sub of state.subsheets) {
    if (!sub.selected || !sub.loaded || !sub.identifierColumn) continue;
    const list = map[sub.identifierType] ?? [];
    for (const raw of sub.rows) {
      const v = (raw[sub.identifierColumn] ?? "").trim();
      if (v) list.push(v);
    }
    map[sub.identifierType] = list;
  }
  return map;
}

/** Dashboard aggregate: total + Edge/Academy/External split of the pool. */
export function dashboardStats(rows: ConsolidatedRow[]): {
  total: number;
  matched: number;
  buckets: BucketCount[];
} {
  const counts: Record<SourceBucket, number> = { edge: 0, academy: 0, external: 0 };
  let matched = 0;
  for (const r of rows) {
    if (r.matched) matched++;
    counts[classifySourceTrack(r.sourceTrack)]++;
  }
  return {
    total: rows.length,
    matched,
    buckets: [
      { bucket: "edge", count: counts.edge },
      { bucket: "academy", count: counts.academy },
      { bucket: "external", count: counts.external },
    ],
  };
}

/**
 * Build a compact, persistable analytics snapshot of the completed run for the
 * home dashboard. Each subsheet becomes its own company segment.
 */
export function buildCompanySummary(state: WizardState, id: string, createdAt: string): CompanySummary {
  const overall = dashboardStats(state.consolidated);

  const bySubsheet = new Map<string, ConsolidatedRow[]>();
  for (const r of state.consolidated) {
    const list = bySubsheet.get(r.subsheet) ?? [];
    list.push(r);
    bySubsheet.set(r.subsheet, list);
  }
  const subsheets: SubsheetSummary[] = [...bySubsheet.entries()].map(([name, rows]) => {
    const s = dashboardStats(rows);
    return { name, total: s.total, matched: s.matched, buckets: s.buckets };
  });

  const reportsGenerated = state.consolidated.filter(
    (r) => state.reports[r.id]?.status === "done",
  ).length;

  // Capture per-candidate detail so the dashboard drill-down can show a
  // rows-and-columns table (and export it) with the Edge/Academy/External
  // split — using the exact company-sheet columns.
  const columns = exportColumns(state);
  const candidateColumns = columns.map((c) => c.label);
  const candidates: CandidateDetail[] = state.consolidated.map((r) => {
    const fields: Record<string, string> = {};
    for (const c of columns) fields[c.label] = cellValue(r, c, state);
    return {
      id: r.id,
      subsheet: r.subsheet,
      bucket: classifySourceTrack(r.sourceTrack),
      sourceTrack: r.sourceTrack,
      matched: r.matched,
      fields,
    };
  });

  return {
    id,
    companyName: state.companyName.trim() || "Company",
    sheetName: companySheetName(state.companyName),
    createdAt,
    total: overall.total,
    matched: overall.matched,
    reportsGenerated,
    columnCount: columns.length,
    buckets: overall.buckets,
    subsheets,
    candidateColumns,
    candidates,
  };
}
