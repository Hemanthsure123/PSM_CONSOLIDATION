"use server";

import { htmlToPdf } from "@/lib/pdf";
import { storePdf } from "@/lib/report-storage";
import { buildReportHtml, type ReviewLink } from "@/lib/report-template";
import { slugify } from "@/lib/utils";
import { analyzeResumeFromUrl, analyzeResumeBytes } from "@/actions/llm";
import { fetchResumeBytes } from "@/lib/resume";
import { extractProfileLinksFromResume } from "@/lib/resume-links";
import {
  getLeetCodeSolved,
  getCodeforcesSolved,
  getGithubStats,
  jdNeedsDsa,
  buildJdTerms,
} from "@/lib/coding-stats";
import type {
  ActionResult,
  ConsolidatedRow,
  GithubProjectStats,
  ProblemStat,
  ReportCriteria,
  ReportResult,
  ReportSections,
  ResumeAnalysis,
  ResumeLink,
  ReviewLinkSource,
  ReviewValues,
} from "@/lib/types";

/** Combined LeetCode+Codeforces solved must exceed this to appear in the report. */
const SOLVED_THRESHOLD = 250;

/** Default: include every technical subsection. */
const ALL_SECTIONS: ReportSections = {
  skills: true,
  github: true,
  leetcode: true,
  portfolio: true,
  otherLinks: true,
};

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test((value ?? "").trim());
}

/** Resolve a display name for the candidate from sheet/BigQuery values. */
function resolveName(row: ConsolidatedRow): string {
  if (row.bqValues.name) return row.bqValues.name;
  for (const [header, value] of Object.entries(row.sheetValues)) {
    if (/name/i.test(header) && value) return value;
  }
  return row.identifier || "Candidate";
}

/** Build the candidate's identity subtitle (college · course · year). */
function resolveSubtitle(row: ConsolidatedRow): string {
  const parts = [
    row.bqValues.bachelors_college_name,
    row.bqValues.bachelors_course_name,
    row.bqValues.bachelors_year_of_grad,
  ].filter((v) => v && v.trim());
  return parts.join(" · ");
}

/**
 * Review-link cards: TR-1, TR-2, Assessment (resume now lives top-right).
 *
 * The link source is the user's choice from the Database step — when the
 * uploaded sheet already carries these links there is no reason to depend on
 * BigQuery. Whichever source leads, the other is used as a fallback for a blank
 * value so a report never drops a record it could have shown. Panel names always
 * come from the sheet and are surfaced on the recording cards.
 */
function buildReviewLinks(row: ConsolidatedRow, source: ReviewLinkSource): ReviewLink[] {
  const sheet = row.reviewValues ?? EMPTY_REVIEW_VALUES;
  const bq = row.bqValues;

  const pick = (sheetValue: string, bqValue: string): string => {
    const preferred = source === "sheet" ? sheetValue : bqValue;
    const fallback = source === "sheet" ? bqValue : sheetValue;
    return isUrl(preferred) ? preferred : (fallback ?? "");
  };

  const candidates: ReviewLink[] = [
    {
      kind: "tr1",
      label: "TR-1 Interview",
      sublabel: "Recording",
      href: pick(sheet.tr1Recording, bq.tr1_recording_link ?? ""),
      panel: sheet.tr1Panel,
      panelLinkedin: sheet.tr1PanelLinkedin,
    },
    {
      kind: "tr2",
      label: "TR-2 Interview",
      sublabel: "Recording",
      href: pick(sheet.tr2Recording, bq.tr2_recording_link ?? ""),
      panel: sheet.tr2Panel,
      panelLinkedin: sheet.tr2PanelLinkedin,
    },
    {
      kind: "assessment",
      label: "Assessment Report",
      sublabel: "Skill assessment",
      href: pick(sheet.assessmentReport, bq.assessment_report ?? ""),
    },
  ];
  return candidates.filter((l) => isUrl(l.href));
}

const EMPTY_REVIEW_VALUES: ReviewValues = {
  tr1Recording: "",
  tr2Recording: "",
  assessmentReport: "",
  tr1Panel: "",
  tr2Panel: "",
  tr1PanelLinkedin: "",
  tr2PanelLinkedin: "",
};

/**
 * Fetch the live coding-platform + GitHub stats, applying the display rules:
 *  - LeetCode/Codeforces only when the JD signals DSA, and only shown if the
 *    COMBINED solved count exceeds the threshold (real per-platform numbers).
 *  - GitHub project stats strictly restricted to the JD (skipped without a JD).
 */
async function fetchStats(
  analysis: ResumeAnalysis,
  criteria: ReportCriteria | undefined,
  sections: ReportSections,
): Promise<{ problemStats: ProblemStat[]; github: GithubProjectStats | null }> {
  const criteriaText = [criteria?.mandatorySkills, criteria?.optionalSkills, criteria?.jobDescription]
    .filter(Boolean)
    .join(" ");
  const jdTerms = buildJdTerms(criteriaText);

  const [lc, cf, gh] = await Promise.all([
    jdNeedsDsa(criteriaText) ? getLeetCodeSolved(analysis.leetcode) : Promise.resolve(null),
    jdNeedsDsa(criteriaText) ? getCodeforcesSolved(analysis.codeforces) : Promise.resolve(null),
    sections.github ? getGithubStats(analysis.githubProfile, analysis.github, jdTerms) : Promise.resolve(null),
  ]);

  const perPlatform: ProblemStat[] = [];
  if (typeof lc === "number") perPlatform.push({ platform: "LeetCode", solved: lc });
  if (typeof cf === "number") perPlatform.push({ platform: "Codeforces", solved: cf });
  const combined = perPlatform.reduce((s, p) => s + p.solved, 0);
  const problemStats = combined > SOLVED_THRESHOLD ? perPlatform.filter((p) => p.solved > 0) : [];

  return { problemStats, github: gh };
}

/** Profile links (LeetCode / portfolio) shown alongside projects. */
function buildOtherLinks(analysis: ResumeAnalysis, sections: ReportSections): ResumeLink[] {
  const links: ResumeLink[] = [];
  if (sections.leetcode && isUrl(analysis.leetcode)) links.push({ label: "LeetCode", url: analysis.leetcode });
  if (analysis.codeforces && isUrl(analysis.codeforces)) links.push({ label: "Codeforces", url: analysis.codeforces });
  if (sections.portfolio && isUrl(analysis.portfolio)) links.push({ label: "Portfolio", url: analysis.portfolio });
  if (sections.otherLinks) for (const l of analysis.otherLinks) if (isUrl(l.url)) links.push(l);
  return links.slice(0, 4);
}

/**
 * Build the screening report for one consolidated candidate: analyze the resume
 * (from the internal-sheet link) against the role criteria, render the HTML
 * report, upload to Drive and return a shareable link.
 *
 * The report is generated ONLY when Top Highlights were extracted — students are
 * shortlisted on those highlights — so the analysis is retried a few times and,
 * if highlights still can't be produced, the report fails (rather than emitting
 * an empty one).
 */
export async function generateScreeningReport(
  row: ConsolidatedRow,
  criteria?: ReportCriteria,
  sections: ReportSections = ALL_SECTIONS,
  reviewSource: ReviewLinkSource = "bigquery",
): Promise<ActionResult<ReportResult>> {
  if (!isUrl(row.resumeUrl)) {
    return { ok: false, error: "No resume link in the sheet — cannot extract highlights." };
  }

  // Retry only when it's worth it: a successful-but-empty result (the model
  // returned nothing) is retried; a hard error like an exhausted daily quota
  // fails fast (retrying it just wastes minutes).
  let analysis: ResumeAnalysis | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await analyzeResumeFromUrl(row.resumeUrl, criteria);
    if (res.ok && res.data.points.length > 0) {
      analysis = res.data;
      break;
    }
    if (!res.ok) {
      lastError = res.error;
      // Quota / billing / auth errors won't recover on retry — stop now.
      if (/quota|billing|429|api key|permission|unauthor/i.test(res.error)) break;
    } else {
      lastError = "No highlights could be extracted from the resume.";
    }
    console.warn(`[report] highlights attempt ${attempt + 1} failed for ${row.id}: ${lastError}`);
  }

  if (!analysis) {
    return { ok: false, error: lastError || "Could not extract highlights from the resume." };
  }

  const name = resolveName(row);
  const { problemStats, github } = await fetchStats(analysis, criteria, sections);

  try {
    const html = buildReportHtml({
      name,
      company: row.company,
      subtitle: resolveSubtitle(row),
      resumeUrl: row.resumeUrl,
      highlights: analysis.points,
      skills: sections.skills ? analysis.skills.slice(0, 12) : [],
      problemStats,
      github,
      projects: github?.projects ?? [],
      otherLinks: buildOtherLinks(analysis, sections),
      reviewLinks: buildReviewLinks(row, reviewSource),
    });
    const pdfBuffer = await htmlToPdf(html);
    const fileName = `Screening-${slugify(name)}-${slugify(row.id).slice(0, 8)}.pdf`;

    // Drive first (shareable link), falling back to a local file when the
    // service account has no storage quota — see lib/report-storage.
    const stored = await storePdf(pdfBuffer, fileName);
    return { ok: true, data: { candidateId: row.id, webViewLink: stored.link, storage: stored.storage } };
  } catch (err) {
    console.error("[generateScreeningReport] error:", err);
    const message = err instanceof Error ? err.message : "Unknown error.";
    return { ok: false, error: `Report generation failed: ${message}` };
  }
}

// ── Skill Set & Evaluation Remarks (columns, no PDF) ─────────────────────────

/** Combined LeetCode+Codeforces solved must exceed this to be mentioned. */
const DSA_MENTION_THRESHOLD = 500;

/** Which coding platforms to mention in the remarks (when the count qualifies). */
export interface ScreeningColumnOptions {
  leetcode: boolean;
  codeforces: boolean;
}

export interface ScreeningColumns {
  /** Core/distinctive skills first, comma-joined. */
  skillSet: string;
  /** HR-readable evaluation prose. */
  remarks: string;
}

/**
 * Produce the two consolidation columns for one candidate — a core-first Skill
 * Set and an HR-readable Evaluation Remarks paragraph — WITHOUT generating a PDF.
 * Reuses the resume analysis; when LeetCode/Codeforces are enabled and the
 * combined solved count exceeds the threshold, a DSA sentence is appended.
 */
export async function generateScreeningColumns(
  row: ConsolidatedRow,
  criteria?: ReportCriteria,
  options: ScreeningColumnOptions = { leetcode: false, codeforces: false },
): Promise<ActionResult<ScreeningColumns>> {
  if (!isUrl(row.resumeUrl)) {
    return { ok: false, error: "No resume link in the sheet — cannot evaluate." };
  }

  const resume = await fetchResumeBytes(row.resumeUrl);
  if (!resume) {
    return { ok: false, error: "Couldn't download the resume (check sharing / link)." };
  }

  // Analyze — retry a successful-but-empty result; fail fast on quota/auth.
  let analysis: ResumeAnalysis | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await analyzeResumeBytes(resume, criteria);
    if (res.ok && res.data.points.length > 0) {
      analysis = res.data;
      break;
    }
    if (!res.ok) {
      lastError = res.error;
      if (/quota|billing|429|api key|permission|unauthor/i.test(res.error)) break;
    } else {
      lastError = "No evaluation could be produced from the resume.";
    }
  }
  if (!analysis) return { ok: false, error: lastError || "Could not evaluate the resume." };

  const skillSet = analysis.skills.slice(0, 8).join(", ");

  // Evaluation remarks = generic, HR-readable KEY POINTS (min ~4). The DSA
  // solved-count (when it qualifies) leads as its own point; the rest come from
  // the analysis remarks, falling back to the top highlights.
  const basePoints = analysis.remarks.length > 0 ? analysis.remarks : analysis.points;
  const dsa = await dsaPoint(resume, analysis, options);
  const remarks = formatRemarks([...(dsa ? [dsa] : []), ...basePoints]);

  return { ok: true, data: { skillSet, remarks } };
}

/** Join key points into one cleaned, deduped, bulleted multi-line cell. */
function formatRemarks(points: string[]): string {
  const clean = points
    .map((p) => p.replace(/^[•\-*\s]+/, "").replace(/\s+/g, " ").replace(/\.+$/, "").trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const unique = clean.filter((p) => {
    const k = p.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.slice(0, 6).map((p) => `• ${p}`).join("\n");
}

/**
 * Build the generic DSA key point, e.g. "Solved 550 problems across LeetCode and
 * Codeforces". Only enabled platforms are fetched; links prefer what the
 * analysis found, then fall back to annotation/text extraction (no extra LLM
 * call) so icon-hidden links still count. Emitted only when the combined solved
 * count exceeds the threshold.
 */
async function dsaPoint(
  resume: NonNullable<Awaited<ReturnType<typeof fetchResumeBytes>>>,
  analysis: ResumeAnalysis,
  options: ScreeningColumnOptions,
): Promise<string> {
  if (!options.leetcode && !options.codeforces) return "";

  let leetUrl = options.leetcode ? analysis.leetcode : "";
  let cfUrl = options.codeforces ? analysis.codeforces : "";

  if ((options.leetcode && !isUrl(leetUrl)) || (options.codeforces && !isUrl(cfUrl))) {
    const found = await extractProfileLinksFromResume(resume, false);
    if (options.leetcode && !isUrl(leetUrl) && found.leetcode) leetUrl = found.leetcode.url;
    if (options.codeforces && !isUrl(cfUrl) && found.codeforces) cfUrl = found.codeforces.url;
  }

  const platforms: string[] = [];
  let total = 0;
  if (options.leetcode && isUrl(leetUrl)) {
    const n = await getLeetCodeSolved(leetUrl);
    if (typeof n === "number" && n > 0) {
      total += n;
      platforms.push("LeetCode");
    }
  }
  if (options.codeforces && isUrl(cfUrl)) {
    const n = await getCodeforcesSolved(cfUrl);
    if (typeof n === "number" && n > 0) {
      total += n;
      platforms.push("Codeforces");
    }
  }

  if (total > DSA_MENTION_THRESHOLD && platforms.length > 0) {
    return platforms.length === 1
      ? `Solved ${total} problems on ${platforms[0]}`
      : `Solved ${total} problems across ${platforms.join(" and ")}`;
  }
  return "";
}

