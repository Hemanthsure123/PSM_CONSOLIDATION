/**
 * The eligible pool — candidates assessed internally in Edge 1.0, Edge 2.0 and Academy.
 * Shapes shared by the sync (server), the database and the screens. Client-safe.
 */

export const PRODUCTS = ["edge2", "edge1", "academy"] as const;
export type Product = (typeof PRODUCTS)[number];
export const PRODUCT_LABEL: Record<Product, string> = { edge1: "Edge 1.0", edge2: "Edge 2.0", academy: "Academy" };

export type Verdict = "strong_hire" | "medium_hire" | "low_hire" | "rejected";
export const VERDICT_LABEL: Record<Verdict, string> = {
  strong_hire: "Strong hire",
  medium_hire: "Medium hire",
  low_hire: "Low hire",
  rejected: "Rejected",
};
/** Best first. */
export const VERDICT_ORDER: Verdict[] = ["strong_hire", "medium_hire", "low_hire", "rejected"];

export const TR2_TRACKS = ["mern_fullstack", "python_fullstack", "java_fullstack", "genai", "dsml", "data_analytics", "product"] as const;
export type Tr2Track = (typeof TR2_TRACKS)[number];
export const TR2_TRACK_LABEL: Record<Tr2Track, string> = {
  mern_fullstack: "MERN",
  python_fullstack: "Python Full Stack",
  java_fullstack: "Java Full Stack",
  genai: "GenAI",
  dsml: "DS/ML",
  data_analytics: "Data Analytics",
  product: "Product",
};

export type AcademyBucket = "A" | "B" | "C" | "D";
export const COMPETENCY_SUBJECTS = ["dsa", "frontend", "backend", "software"] as const;
export type CompetencySubject = (typeof COMPETENCY_SUBJECTS)[number];
export const COMPETENCY_LABEL: Record<CompetencySubject, string> = {
  dsa: "DSA",
  frontend: "Frontend",
  backend: "Backend",
  software: "Software Engineering",
};

/**
 * Internal standing tiers (lower = stronger):
 *  1 — Edge TR-2 cleared · Academy Bucket A TR-2 cleared or a competency interview at L3+
 *  2 — Edge TR-1 cleared · Academy TR-1 cleared in Bucket A / B / C (or Bucket B TR-2)
 *  3 — assessment cleared (Edge DSA offline · Academy old DSA offline or competency exam)
 *  4 — assessed but not eligible
 * Anyone not in the pool is external.
 */
export type Tier = 1 | 2 | 3 | 4;
export const TIER_LABEL: Record<Tier, string> = {
  1: "TR-2 cleared / top level",
  2: "TR-1 cleared",
  3: "Assessment cleared",
  4: "Assessed, not eligible",
};
/** Short stage names for tables and the "Internal Stage" column of every export. */
export const STAGE_SHORT: Record<Tier, string> = { 1: "TR-2 / top", 2: "TR-1", 3: "Assessment", 4: "Not eligible" };

export interface Standing {
  tier: Tier;
  /** "Edge 2.0 · MERN TR-2 · Strong hire", "Academy · Bucket A TR-2 cleared · Frontend L4" … */
  label: string;
  /** 0-100 within-tier strength from the internal scores (tie-break only; the tier ranks first). */
  internalScore: number;
  /** Gets job opportunities. */
  eligible: boolean;
}

interface Identity {
  /** 10-digit phone, or null when the sheet has none. */
  phone: string | null;
  /** The platform user id (uuid), or null. */
  userId: string | null;
  name: string;
  /** Resume link in the pool sheet — reference only; applications carry their own resume. */
  referenceResumeUrl: string | null;
}

export interface Edge1Record extends Identity {
  product: "edge1";
  assessmentStatus: string;
  tr1Status: string;
  tr2Status: string;
}

export interface Edge2Record extends Identity {
  product: "edge2";
  candidateStage: string;
  offlineOverallScore: number | null;
  dsaCodingScore: number | null;
  csFundamentalsScore: number | null;
  sqlMcqScore: number | null;
  sqlCodingScore: number | null;
  tr1: {
    selfIntro: number | null;
    dsaOverall: number | null;
    problemSolving: number | null;
    coding: number | null;
    communication: number | null;
    debugging: number | null;
    overallTechnical: number | null;
  };
  tr2: { track: Tr2Track; verdict: Verdict }[];
}

export interface AcademyRound {
  bucket: "A" | "B" | "C";
  round: 1 | 2;
  score: number | null;
  status: string;
  cleared: boolean;
}

export interface AcademyCompetency {
  subject: CompetencySubject;
  overallScore: number | null;
  verdictBand: string;
  clearanceStatus: string;
  cleared: boolean;
  /** 1-5 (L5 best); 0 = "Below L1"; "Below L2" = 1. Null when no level. */
  level: number | null;
  levelLabel: string;
}

export interface AcademyRecord extends Identity {
  product: "academy";
  yog: number | null;
  oldBucket: AcademyBucket | null;
  dsaOfflineStatus: string;
  dsaOfflineCleared: boolean;
  previousPlacement: string;
  studentPreference: string;
  activePool: boolean | null;
  rounds: AcademyRound[];
  competency: AcademyCompetency[];
}

export type PoolRecord = Edge1Record | Edge2Record | AcademyRecord;

export interface ParseIssue {
  /** 1-based row in the sheet / CSV. */
  row: number;
  problem: string;
}

export interface ParsedPool<R extends PoolRecord = PoolRecord> {
  product: Product;
  records: R[];
  rowsRead: number;
  /** Required columns the source doesn't have (the sync stops when any is missing). */
  missingColumns: string[];
  issues: ParseIssue[];
}

// ── Read side ────────────────────────────────────────────────────────────────

export interface ProductStanding {
  product: Product;
  tier: Tier;
  label: string;
  score: number;
  eligible: boolean;
}

/** A person's standing across products, best first (from the candidate_standing view). */
export interface CandidateStanding {
  candidateId: number;
  phone: string | null;
  userId: string | null;
  name: string;
  bestProduct: Product;
  bestTier: Tier;
  bestScore: number;
  bestLabel: string;
  eligible: boolean;
  standings: ProductStanding[];
}

/**
 * A screened candidate's internal standing, as Domain Shortlisting carries it: the best
 * standing across products, how the person was matched, and every product's standing.
 */
export interface InternalStanding {
  tier: Tier;
  label: string;
  product: Product;
  score: number;
  eligible: boolean;
  matchedBy: "phone" | "userId";
  standings: ProductStanding[];
}

/** One person's assessment records, per product they're in (only the products asked for). */
export interface PersonRecords {
  edge1?: Edge1Record;
  edge2?: Edge2Record;
  academy?: AcademyRecord;
}

export interface SyncResult {
  product: Product;
  mode: "sheet" | "csv";
  ok: boolean;
  runId: number | null;
  rowsRead: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  issues: ParseIssue[];
  error: string;
  ms: number;
}

export interface ProductSummary {
  product: Product;
  total: number;
  eligible: number;
  byTier: Record<Tier, number>;
  /** The latest sync attempt, whatever its outcome. */
  lastSync: { at: string; mode: "sheet" | "csv"; status: string; inserted: number; updated: number; unchanged: number } | null;
  /** When the data was last refreshed successfully (null = never). */
  lastSuccessAt: string | null;
}

export interface SyncRun {
  id: number;
  product: Product;
  mode: "sheet" | "csv";
  sourceRef: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  rowsRead: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  issueCount: number;
  error: string | null;
  triggeredBy: string | null;
}

export interface PoolSourceInfo {
  product: Product;
  sheetUrl: string;
  tab: string;
}

export interface PoolSummary {
  configured: boolean;
  /** Where each product syncs from. */
  sources: PoolSourceInfo[];
  /** The latest sync runs, newest first. */
  recentRuns: SyncRun[];
  /** People (deduplicated across products) by their best tier. */
  people: { total: number; byTier: Record<Tier, number>; inMoreThanOneProduct: number };
  products: ProductSummary[];
  edge2Tracks: { track: Tr2Track; strong: number; medium: number }[];
  /** Edge 2.0 TR-2 clears with no track verdict (combined interview). */
  edge2CombinedTr2: number;
  /** Why Academy people are at the top: Bucket A TR-2 cleared, a competency interview at L3+ (overlap possible). */
  academyTop: { bucketATr2: number; competencyL3: number };
  /** Academy's old DSA offline buckets ("Old Assessment Checks"), and how many cleared the DSA competency exam. */
  academyOldBuckets: { bucket: AcademyBucket | "none"; total: number }[];
  academyDsaOfflineCleared: number;
  /** Academy interviews per bucket: taken and cleared, per round (Bucket C has no TR-2). */
  academyRounds: { bucket: "A" | "B" | "C"; tr1Taken: number; tr1Cleared: number; tr2Taken: number; tr2Cleared: number }[];
  academyCompetency: { subject: CompetencySubject; taken: number; byLevel: Record<string, number> }[];
}
