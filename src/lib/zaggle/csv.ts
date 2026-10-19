import { QA_SECTIONS, SECTION_LABEL, type SectionQuotes } from "@/lib/qa-types";
import { toCsv } from "@/lib/utils";
import { formatMonths, monthLabel, parseYm } from "@/lib/zaggle/dates";
import { sectionsOf, type JobVerdict, type ZgRanked } from "@/lib/zaggle/scoring";
import { COMPANY_TYPE_LABEL, ROLE_FOCUS_LABEL, ZG_GOOD_TO_HAVE, ZG_SKILLS } from "@/lib/zaggle/types";

/**
 * Zaggle SDE 1 exports — one column order for the complete ranking and the
 * shortlist. Every candidate gets a row (errors / pending included) so nobody
 * silently drops out of the sheet.
 */

export const ZG_HEADERS = [
  "Overall Rank",
  "Shortlist Rank",
  "Mobile Number",
  "Candidate Name",
  "Status",
  "Final Score (%)",
  "Mandatory Points (/100)",
  "Good-to-have Bonus",
  "Every Mandatory Met (100% Eligible)",
  "Relevant Full-time Experience (months)",
  "Relevant Full-time Experience",
  "Counted Jobs",
  "Product Company Experience",
  "IT Services / Consulting Background",
  ...ZG_SKILLS.map((d) => d.label),
  "Not Shortlisted / Review Because",
  "Good-to-have Count",
  "Good-to-have Found",
  "Work History",
  "Primary Profile",
  "Remarks",
  "Mandatory Evidence",
  "Good-to-have Evidence",
  "Verification Notes",
  "Resume",
  "Batch",
  "Model Used",
] as const;

const yesNo = (b: boolean) => (b ? "Yes" : "No");

function sectionList(q: SectionQuotes | undefined): string {
  const secs = sectionsOf(q);
  return secs.length ? secs.map((s) => SECTION_LABEL[s]).join(", ") : "Missing";
}

function evidence(label: string, q: SectionQuotes | undefined): string {
  if (!q) return "";
  const parts = QA_SECTIONS.filter((s) => q[s]).map((s) => `${SECTION_LABEL[s]}: "${q[s]}"`);
  return parts.length ? `${label} — ${parts.join("; ")}` : "";
}

/** "Jan 2025 – Present" from the parsed months (or the duration). */
export function jobPeriod(j: JobVerdict["job"]): string {
  const s = parseYm(j.start);
  const e = parseYm(j.end);
  if (s !== null && e !== null) return `${monthLabel(s)} – ${j.current ? "Present" : monthLabel(e)}`;
  if (j.durationOnlyMonths) return `${j.durationOnlyMonths} months (no dates)`;
  return j.datesText || "no dates";
}

const jobLine = (v: JobVerdict) =>
  `${v.job.title || "—"} @ ${v.job.company} [${v.job.employmentType}, ${ROLE_FOCUS_LABEL[v.job.roleFocus]}, ${COMPANY_TYPE_LABEL[v.job.companyType]}] ${jobPeriod(v.job)} (${v.months} mo)${v.counted ? " — counted" : ` — not counted: ${v.why}`}${v.disqualifies ? " — IT services / consulting" : ""}`;

export function zgCsvRow(r: ZgRanked): Record<string, string> {
  const c = r.candidate;
  const e = r.result;
  const s = r.score;
  const row: Record<string, string> = {
    "Overall Rank": r.rank ? String(r.rank) : "",
    "Shortlist Rank": r.shortlistRank ? String(r.shortlistRank) : "",
    "Mobile Number": c.mobile,
    "Candidate Name": c.name || e?.name || "",
    Status: r.status,
    "Not Shortlisted / Review Because": r.status === "Shortlisted" ? "" : r.reasons.join("; "),
    Resume: c.resumeUrl || (c.resumeText ? "(resume text pasted)" : ""),
    Batch: String(c.batch),
  };
  if (!e || !s) return row;
  Object.assign(row, {
    "Final Score (%)": String(s.finalScore),
    "Mandatory Points (/100)": String(s.points),
    "Good-to-have Bonus": String(s.bonus),
    "Every Mandatory Met (100% Eligible)": yesNo(s.complete),
    "Relevant Full-time Experience (months)": String(s.months),
    "Relevant Full-time Experience": `${formatMonths(s.months)}${s.monthsApproximate ? " (approximate dates)" : ""}`,
    "Counted Jobs": s.jobs
      .filter((j) => j.counted)
      .map((j) => `${j.job.company} ${jobPeriod(j.job)} (${j.months} mo)`)
      .join(" + "),
    "Product Company Experience": s.productConfirmed ? "Yes" : s.productUnclear ? "Unclear" : "No",
    "IT Services / Consulting Background": s.servicesFirms.length ? `Yes — ${s.servicesFirms.join(", ")}` : "No",
    "Good-to-have Count": String(s.goodToHave.length),
    "Good-to-have Found": s.goodToHave.join(", "),
    "Work History": s.jobs.map(jobLine).join(" | "),
    "Primary Profile": e.primaryProfile,
    Remarks: e.remarks,
    "Mandatory Evidence": ZG_SKILLS.map((d) => evidence(d.label, e.skills[d.key])).filter(Boolean).join(" || "),
    "Good-to-have Evidence": ZG_GOOD_TO_HAVE.map((d) => evidence(d.label, e.goodToHave[d.key])).filter(Boolean).join(" || "),
    "Verification Notes": e.checks.join("; "),
    "Model Used": e.model,
  });
  for (const d of ZG_SKILLS) row[d.label] = sectionList(e.skills[d.key]);
  return row;
}

export function buildZgCsv(rows: ZgRanked[]): string {
  return "﻿" + toCsv([...ZG_HEADERS], rows.map(zgCsvRow));
}
