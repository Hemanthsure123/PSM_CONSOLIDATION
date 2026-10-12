/**
 * Shared types for Experience Analysis — internships / jobs read from resumes.
 * Plain data only: everything here travels over JSON and into localStorage.
 */

export const EXPERIENCE_TYPES = [
  "Internship",
  "Virtual Internship",
  "Full-time",
  "Part-time",
  "Freelance / Contract",
  "Research",
  "Apprenticeship",
  "Other",
] as const;
export type ExperienceType = (typeof EXPERIENCE_TYPES)[number];

/** How `months` was worked out. */
export type DurationSource = "dates" | "stated" | "unknown";

export interface ExperienceEntry {
  company: string;
  role: string;
  type: ExperienceType;
  /** Duration exactly as the resume words it ("Jun 2024 – Aug 2024", "3 months", "Summer 2023"). */
  durationText: string;
  /** "YYYY-MM", "YYYY-MM-DD" or "YYYY" — "" when unknown. */
  startDate: string;
  /** Same formats, or "Present" — "" when unknown. */
  endDate: string;
  ongoing: boolean;
  /** Normalised length in months (0.5 steps below a month); null when it can't be determined. */
  months: number | null;
  /** Human label — "3 months", "6 weeks", "1 year 2 months" — "" when unknown. */
  durationLabel: string;
  durationSource: DurationSource;
  /** City / "Remote" / "" as written. */
  location: string;
  /** Technologies the resume names for THIS role (verified against the resume text). */
  techStack: string[];
  techMentioned: boolean;
  /** What the candidate did there — always filled; the substance when no tech is named. */
  context: string;
}

/** One candidate to analyse. `id` is row-unique; `mobile` is the CSV key. */
export interface ExperienceCandidateInput {
  id: string;
  mobile: string;
  /** From the sheet, if a name column was mapped. */
  name: string;
  resumeUrl: string;
}

export interface ExperienceResult {
  id: string;
  mobile: string;
  /** Sheet name, else the name read from the resume. */
  name: string;
  resumeUrl: string;
  status: "ok" | "no-experience" | "error";
  error: string;
  entries: ExperienceEntry[];
  /** Calendar months covered by all entries (overlaps counted once); null when no duration is known. */
  totalMonths: number | null;
  /** Same, internships only (incl. virtual). */
  internshipMonths: number | null;
  /** "provider/model" that read the resume. */
  model: string;
  durationMs: number;
  analyzedAt: string;
}

export interface ExperienceRun {
  id: string;
  name: string;
  sheetTitle: string;
  subsheets: string[];
  createdAt: string;
  updatedAt: string;
  candidates: ExperienceCandidateInput[];
  results: Record<string, ExperienceResult>;
  concurrency: number;
}
