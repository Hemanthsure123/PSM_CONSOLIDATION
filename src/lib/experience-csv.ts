import { parseDate } from "@/lib/experience-duration";
import type { ExperienceCandidateInput, ExperienceEntry, ExperienceResult } from "@/lib/experience-types";

/** Most recent entry: a current role first, then the latest end (or start) month; else the first listed. */
function latest(entries: ExperienceEntry[]): ExperienceEntry | undefined {
  const key = (e: ExperienceEntry) => {
    if (e.ongoing) return Number.MAX_SAFE_INTEGER;
    const d = parseDate(e.endDate) ?? parseDate(e.startDate);
    return d ? d.y * 12 + d.m : -1;
  };
  let best: ExperienceEntry | undefined;
  for (const e of entries) if (!best || key(e) > key(best)) best = e;
  return best;
}

/**
 * Two fixed-format exports for Google Sheets filtering:
 *  - one row per internship / job (filter on company, duration, tech stack…);
 *  - one row per candidate (filter on total months, counts…).
 * Candidates with no experience or an error still get a row, so nobody silently
 * disappears from the sheet.
 */

const num = (n: number | null | undefined) => (typeof n === "number" ? String(n) : "");
const yesNo = (b: boolean) => (b ? "Yes" : "No");

const STATUS: Record<ExperienceResult["status"] | "pending", string> = {
  ok: "Experience found",
  "no-experience": "No experience in resume",
  error: "Error",
  pending: "Not analysed yet",
};

export const EXPERIENCE_HEADERS = [
  "Mobile Number",
  "Candidate Name",
  "Resume",
  "Experience #",
  "Company Name",
  "Role",
  "Duration",
  "Duration (Months)",
  "Tech Stack",
  "Context",
  "Tech Stack Mentioned",
  "Experience Type",
  "Start Date",
  "End Date",
  "Currently Working",
  "Duration As Written",
  "Duration Basis",
  "Location",
  "Candidate Total Experience (Months)",
  "Candidate Internship Months",
  "Candidate Experience Count",
  "Status",
  "Notes",
] as const;

function entryRow(r: ExperienceResult, e: ExperienceEntry, i: number): Record<string, string> {
  return {
    "Mobile Number": r.mobile,
    "Candidate Name": r.name,
    Resume: r.resumeUrl,
    "Experience #": String(i + 1),
    "Company Name": e.company,
    Role: e.role,
    Duration: e.durationLabel || (e.durationText ? "Unclear" : "Not mentioned"),
    "Duration (Months)": num(e.months),
    "Tech Stack": e.techStack.join(", "),
    Context: e.context,
    "Tech Stack Mentioned": yesNo(e.techMentioned),
    "Experience Type": e.type,
    "Start Date": e.startDate,
    "End Date": e.endDate,
    "Currently Working": yesNo(e.ongoing),
    "Duration As Written": e.durationText,
    "Duration Basis": e.durationSource === "dates" ? "From dates" : e.durationSource === "stated" ? "Stated in resume" : "Unknown",
    Location: e.location,
    "Candidate Total Experience (Months)": num(r.totalMonths),
    "Candidate Internship Months": num(r.internshipMonths),
    "Candidate Experience Count": String(r.entries.length),
    Status: STATUS[r.status],
    Notes: "",
  };
}

export function buildExperienceCsvRows(
  candidates: ExperienceCandidateInput[],
  results: Record<string, ExperienceResult>,
): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  for (const c of candidates) {
    const r = results[c.id];
    if (!r) {
      rows.push({ "Mobile Number": c.mobile, "Candidate Name": c.name, Resume: c.resumeUrl, Status: STATUS.pending });
      continue;
    }
    if (r.entries.length) {
      r.entries.forEach((e, i) => rows.push(entryRow(r, e, i)));
      continue;
    }
    rows.push({
      "Mobile Number": r.mobile,
      "Candidate Name": r.name,
      Resume: r.resumeUrl,
      "Experience #": r.status === "error" ? "" : "0",
      Context: r.status === "error" ? "" : "No internship or work experience found in the resume.",
      "Tech Stack Mentioned": r.status === "error" ? "" : "No",
      "Candidate Experience Count": r.status === "error" ? "" : "0",
      Status: STATUS[r.status],
      Notes: r.error,
    });
  }
  return rows;
}

export const SUMMARY_HEADERS = [
  "Mobile Number",
  "Candidate Name",
  "Resume",
  "Status",
  "Experience Count",
  "Internship Count",
  "Full-time Count",
  "Total Experience (Months)",
  "Internship Months",
  "Longest Stint (Months)",
  "Latest Company",
  "Latest Role",
  "Companies",
  "All Tech Stack",
  "Notes",
] as const;

export function buildSummaryCsvRows(
  candidates: ExperienceCandidateInput[],
  results: Record<string, ExperienceResult>,
): Record<string, string>[] {
  return candidates.map((c): Record<string, string> => {
    const r = results[c.id];
    if (!r) return { "Mobile Number": c.mobile, "Candidate Name": c.name, Resume: c.resumeUrl, Status: STATUS.pending };
    const e = r.entries;
    const longest = e.reduce<number | null>((m, x) => (x.months !== null && (m === null || x.months > m) ? x.months : m), null);
    const tech = Array.from(new Set(e.flatMap((x) => x.techStack)));
    return {
      "Mobile Number": r.mobile,
      "Candidate Name": r.name,
      Resume: r.resumeUrl,
      Status: STATUS[r.status],
      "Experience Count": r.status === "error" ? "" : String(e.length),
      "Internship Count": r.status === "error" ? "" : String(e.filter((x) => x.type === "Internship" || x.type === "Virtual Internship").length),
      "Full-time Count": r.status === "error" ? "" : String(e.filter((x) => x.type === "Full-time").length),
      "Total Experience (Months)": num(r.totalMonths),
      "Internship Months": num(r.internshipMonths),
      "Longest Stint (Months)": num(longest),
      "Latest Company": latest(e)?.company ?? "",
      "Latest Role": latest(e)?.role ?? "",
      Companies: e.map((x) => x.company).filter(Boolean).join(" | "),
      "All Tech Stack": tech.join(", "),
      Notes: r.error,
    };
  });
}
