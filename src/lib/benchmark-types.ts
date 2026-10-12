/**
 * Benchmark Projects — screen pasted resumes for industry-standard projects
 * (≥15 LPA calibre) in ONE domain the user types ("Generative AI", "MERN Stack",
 * "Java Spring Boot", "DevOps" …) and export them, grouped by the domain's
 * sub-areas, as a Markdown file to paste into Notion. Shared by the browser and
 * the server: no I/O here.
 */

/**
 * What the run screens for — built once from the domain the user typed (one
 * model call) and sent with every resume, so every judgement is made against the
 * same definition of the domain.
 */
export interface BenchmarkDomainProfile {
  /** Clean display name ("Generative AI"). */
  domain: string;
  /** What the user typed, verbatim. */
  input: string;
  /** Optional focus notes the user added ("RAG and agents; no computer vision"). */
  focus: string;
  /** What counts as this domain — and what doesn't. */
  summary: string;
  /** Sub-areas the projects are grouped under (4-8). */
  categories: string[];
  /** Signs a project in this domain is production-grade (15+ LPA quality). */
  advancedSignals: string[];
  /** Project types in this domain that are basic / tutorial-level — excluded. */
  basicExamples: string[];
  /**
   * Terms of the domain (tools, libraries, concepts). A resume containing none
   * of them can't hold a project in the domain and is skipped without a model call.
   */
  keywords: string[];
}

/** Catch-all sub-area for a project that fits none of the profile's categories. */
export const OTHER_CATEGORY = "Other";

/**
 * Quality: the model scores each project 0-100 against the 15 LPA bar; the
 * browser decides the cut, so changing it never needs a re-read.
 *   85-100  exceptional — would stand out at a top product company
 *   70-84   clearly meets the ≥15 LPA bar
 *   60-69   borderline (returned, hidden at the default bar)
 */
export const MIN_RETURNED_SCORE = 60;
export const DEFAULT_MIN_SCORE = 70;
export const SCORE_BARS = [
  { value: 60, label: "60+ — include borderline" },
  { value: 70, label: "70+ — meets the 15 LPA bar (recommended)" },
  { value: 80, label: "80+ — strong only" },
  { value: 85, label: "85+ — exceptional only" },
] as const;

/**
 * Domain match: how squarely a project is work IN the entered domain.
 *   85-100  the project IS this domain's work
 *   70-84   the domain is a major part of it
 *   50-69   partial overlap (returned, hidden at the default)
 */
export const MIN_RETURNED_RELEVANCE = 50;
export const DEFAULT_MIN_RELEVANCE = 70;
export const RELEVANCE_BARS = [
  { value: 85, label: "Core domain projects only (85+)" },
  { value: 70, label: "Clearly in the domain (70+, recommended)" },
  { value: 50, label: "Include partial overlap (50+)" },
] as const;

/** One candidate to screen — pasted text or a resume link. */
export interface BenchmarkCandidateInput {
  /** Mobile number (normalised) or "b<batch>-#<serial>" from the paste. */
  id: string;
  /** How the candidate is shown — the mobile number or "Resume 12". */
  label: string;
  /** Resume link ("" when the resume text was pasted). */
  resumeUrl: string;
  /** Resume pasted as text. */
  resumeText?: string;
  /** Which paste (batch) it came in with — 1-based. */
  batch: number;
}

/** One domain project that cleared the quality filter, as extracted from one resume. */
export interface BenchmarkProject {
  title: string;
  /** The domain sub-area (one of the profile's categories, or OTHER_CATEGORY). */
  category: string;
  techStack: string[];
  /** Core features & architecture — the complex components, one per bullet. */
  architecture: string[];
  /** Why it hits the 15+ LPA benchmark for this domain. */
  whyBenchmark: string;
  /** 0-100 against the 15 LPA bar. */
  score: number;
  /** 0-100: how squarely the project is work in the entered domain. */
  relevance: number;
}

export type BenchmarkStatus = "ok" | "invalid" | "error";

/** What the server returns for one resume. */
export interface BenchmarkResult {
  id: string;
  status: BenchmarkStatus;
  /** Domain projects that cleared the filter, verified to be in the resume. */
  projects: BenchmarkProject[];
  /** Projects the model named that could not be found in the resume text — dropped. */
  unverified: number;
  /** Read, but no term of the domain anywhere in it — skipped without a model call. */
  skipped?: boolean;
  /** Why the resume could not be read / screened ("" when ok). */
  error: string;
  /** A rate limit / network problem — worth retrying. */
  retryable: boolean;
  source: string;
  model: string;
  durationMs: number;
}

export interface BenchmarkBatch {
  n: number;
  addedAt: string;
  count: number;
}

export interface BenchmarkRunMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** The domain this run screens for. */
  profile: BenchmarkDomainProfile;
  concurrency: number;
  /** Export settings, kept with the run. */
  minScore: number;
  minRelevance: number;
  /** Sub-areas included in the export ([] = all). */
  categories: string[];
  showSources: boolean;
  batches: BenchmarkBatch[];
  candidates: BenchmarkCandidateInput[];
  stats: { screened: number; withProjects: number; projects: number; errors: number };
}

export function failedBenchmark(c: { id: string }, error: string, retryable: boolean, durationMs = 0): BenchmarkResult {
  return { id: c.id, status: "error", projects: [], unverified: 0, error, retryable, source: "", model: "", durationMs };
}

/** Readable list for prompts and the export ("A, B and C"). */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
