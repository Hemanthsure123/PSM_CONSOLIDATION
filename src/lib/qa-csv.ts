import { sectionsOf, type QaRanked } from "@/lib/qa-scoring";
import { GOOD_TO_HAVE, MANDATORY, QA_SECTIONS, SECTION_LABEL, type SectionQuotes } from "@/lib/qa-types";
import { toCsv } from "@/lib/utils";

/**
 * QA Resume Screening exports — one fixed column order for both downloads, so
 * Google Sheets filters work the same on the complete ranking and the shortlist.
 * Every candidate gets a row (errors and not-yet-screened included) so nobody
 * silently disappears from the sheet.
 */

export const QA_HEADERS = [
  "Overall Rank",
  "Shortlist Rank",
  "Mobile Number",
  "Candidate Name",
  "Status",
  "Final Score (%)",
  "Mandatory Score (/100)",
  "Good-to-have Bonus",
  "All Mandatory In All Sections (100% Eligible)",
  "Mandatory Present (of 5)",
  "Missing Mandatory",
  ...MANDATORY.map((d) => d.label),
  "Mandatory Section Gaps",
  "Hands-on QA (Project / Internship)",
  "QA Projects",
  "QA Internship / Experience",
  "Good-to-have Count",
  "Good-to-have Found",
  "QA Focus",
  "Primary Profile",
  "QA Certifications",
  "Not Shortlisted Because",
  "Remarks",
  "Mandatory Evidence",
  "Good-to-have Evidence",
  "Verification Notes",
  "Evidence Verified Against Resume Text",
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

export function qaCsvRow(r: QaRanked): Record<string, string> {
  const c = r.candidate;
  const e = r.result;
  const s = r.score;
  const row: Record<string, string> = {
    "Overall Rank": r.rank ? String(r.rank) : "",
    "Shortlist Rank": r.shortlistRank ? String(r.shortlistRank) : "",
    "Mobile Number": c.mobile,
    "Candidate Name": c.name || e?.name || "",
    Status: r.status,
    Resume: c.resumeUrl || (c.resumeText ? "(resume text pasted)" : ""),
    Batch: String(c.batch),
    "Not Shortlisted Because": r.reasons.join("; "),
  };
  if (!e || !s) return row;
  const ok = e.status === "ok";
  Object.assign(row, {
    "Final Score (%)": String(s.finalScore),
    "Mandatory Score (/100)": String(s.mandatoryScore),
    "Good-to-have Bonus": String(s.bonus),
    "All Mandatory In All Sections (100% Eligible)": yesNo(s.allSectionsComplete),
    "Mandatory Present (of 5)": String(s.mandatoryPresent),
    "Missing Mandatory": s.missingMandatory.join(", "),
    "Mandatory Section Gaps": s.sectionGaps.join("; "),
    "Hands-on QA (Project / Internship)": s.qaProject && s.qaInternship ? "Project + Internship" : s.qaInternship ? "Internship / Job" : s.qaProject ? "Project" : "No",
    "QA Projects": e.qaProjects
      .map((p) => `${p.title}${p.work ? ` — ${p.work}` : ""}${p.tools.length ? ` [${p.tools.join(", ")}]` : ""}`)
      .join(" | "),
    "QA Internship / Experience": e.qaExperience
      .map((j) => `${[j.role, j.company].filter(Boolean).join(" @ ")}${j.duration ? ` (${j.duration})` : ""}${j.work ? ` — ${j.work}` : ""}`)
      .join(" | "),
    "Good-to-have Count": String(s.goodToHave.length),
    "Good-to-have Found": s.goodToHave.join(", "),
    "QA Focus": ok ? e.qaFocus : "None",
    "Primary Profile": e.primaryProfile,
    "QA Certifications": e.certifications.join(", "),
    Remarks: e.remarks,
    "Mandatory Evidence": MANDATORY.map((d) => evidence(d.label, e.mandatory[d.key])).filter(Boolean).join(" || "),
    "Good-to-have Evidence": GOOD_TO_HAVE.map((d) => evidence(d.label, e.goodToHave[d.key])).filter(Boolean).join(" || "),
    "Verification Notes": e.checks.join("; "),
    "Evidence Verified Against Resume Text": e.evidenceVerified
      ? e.transcribed
        ? "Yes (text transcribed from an image / scan)"
        : "Yes"
      : "No — re-screen",
    "Model Used": e.model || (e.status === "screened-out" ? "None (no testing terms)" : ""),
  });
  for (const d of MANDATORY) row[d.label] = sectionList(e.mandatory[d.key]);
  return row;
}

export function buildQaCsv(rows: QaRanked[]): string {
  // Leading BOM so Excel reads UTF-8 correctly; Sheets ignores it.
  return "﻿" + toCsv([...QA_HEADERS], rows.map(qaCsvRow));
}
