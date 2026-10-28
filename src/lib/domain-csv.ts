import { GITHUB_INSPECT_CAP, githubEvidenceScore, githubStrengthNotOnResume, githubTechsNotOnResume } from "@/lib/domain-scoring";
import { DSA_PLATFORMS, type DsaPlatformResult } from "@/lib/dsa-types";
import { internalColumns } from "@/lib/pool/lookup";
import type { InternalStanding } from "@/lib/pool/types";
import { formatDay } from "@/lib/utils";
import type { DomainCandidate, DomainCandidateOutcome, DomainCandidateRow, DomainGithubGap, DomainGithubStatus, DomainReportResult } from "@/lib/types";

/**
 * Domain Shortlisting — the two CSVs (pure, tested in scripts/domain-csv-selftest.ts).
 *
 * Only what the run actually measured gets a column: DSA columns when DSA was screened,
 * GitHub columns when GitHub was inspected (the latest-commit columns only with that lookup,
 * the code-review columns only when reviews ran), presentation when it was graded, and the
 * interview / placement columns only when the sheet's column was mapped and holds values. A
 * blank cell always means "unknown", never 0.
 *
 * Order: outcome → resume → DSA → GitHub → mandatory / experience → presentation → the
 * sheet's interview columns → resume link → internal assessment → Signals; the complete CSV
 * adds the audit columns (scored by, phone, user id) and a row for every resume that couldn't
 * be scored, so the sheet is fully accounted for.
 */

export const BELOW_BAR_NOTE = "Below the domain-fit bar";
export const STOPPED_NOTE = "Not reached";

export const GITHUB_STATUS_LABEL: Record<DomainGithubStatus, string> = {
  off: "Not run",
  "no-link": "No GitHub link in resume",
  "not-inspected": "Not inspected",
  checked: "Checked",
  "no-repos": "No public repos with code",
  "not-found": "GitHub user not found",
  failed: "Check failed",
};

const GAP_REASON: Record<DomainGithubGap["reason"], string> = {
  none: "no evidence in the inspected repos",
  "readme-only": "only named in a README / topics",
  weak: "weak evidence",
};

const PRIORITY_SHORT: Record<1 | 2 | 3, string> = {
  1: "1 — assessed, good resume",
  2: "2 — assessed, average resume",
  3: "3 — external, good resume",
};

/** "PyTorch: import torch in src/train.py (chest-xray)" — one per proven technology. */
export const evidenceLines = (c: DomainCandidate): string[] => (c.githubEvidence ?? []).map((e) => `${e.tech}: ${e.detail}${e.repo ? ` (${e.repo})` : ""}`);

/** "Kafka — no evidence in the inspected repos" — one per mandatory technology the code doesn't prove. */
export const gapLines = (c: DomainCandidate): string[] =>
  (c.githubMandatoryGaps ?? []).map((g) => `${g.tech} — ${GAP_REASON[g.reason]}${g.reason === "weak" && g.detail ? `: ${g.detail}` : ""}`);

/** "2026-10-18 14:05" (local time) of an ISO stamp, "" when there is none. */
export function stamp(iso: string | undefined): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Not inspected (below domain-fit bar)" etc. — the status with the reason when GitHub wasn't read. */
export function githubCheckLabel(c: DomainCandidate): string {
  if (c.githubStatus !== "not-inspected") return GITHUB_STATUS_LABEL[c.githubStatus];
  if (c.githubNote.startsWith(BELOW_BAR_NOTE)) return "Not inspected (below domain-fit bar)";
  if (c.githubNote.startsWith("Beyond")) return `Not inspected (beyond the top-${GITHUB_INSPECT_CAP} cap)`;
  if (c.githubNote.startsWith(STOPPED_NOTE)) return "Not inspected (run stopped)";
  return "Not inspected";
}

/** A DSA stat, worded like the DSA consolidation export ("" = no profile linked). */
export function dsaStatText(p: DsaPlatformResult, field: "solved" | "contests" | "rating"): string {
  if (!p.url) return "";
  if (p.found === false) return "Profile not found";
  const value = p[field];
  if (typeof value === "number") return String(value);
  if (field === "rating" && p.found === true && p.contests !== null && p.contests !== undefined) return "Unrated";
  return "N/A";
}

/** A row with no score: not a resume, couldn't be evaluated, or not reached before a Stop. */
export interface UnscoredRow {
  row: DomainCandidateRow;
  status: "Not a resume" | "Could not be evaluated" | "Not evaluated";
  reason: string;
  internal: InternalStanding | null | undefined;
}

export interface DomainCsvInput {
  kind: "shortlisted" | "complete";
  result: DomainReportResult;
  domain: string;
  mandatoryActive: boolean;
  /** DSA was screened (the toggle or a DSA gate). */
  dsaOn: boolean;
  /** GitHub counted in the rank (the toggle or the commits gate). */
  githubOn: boolean;
  /** The latest-domain-commit lookup ran. */
  trackDomainCommit: boolean;
  presentation: boolean;
  /** The eligible pool was looked up (a phone / user id column was mapped). */
  poolChecked: boolean;
  /** Complete CSV only: every row without a score. */
  unscored: UnscoredRow[];
}

const DSA_HEADERS = [
  "DSA Score",
  ...DSA_PLATFORMS.flatMap(({ label }) => [`${label} Solved`, `${label} Contests Participated`, `${label} Rating`]),
  "Total Solved",
  "Total Contests",
  "Codeforces Max Rating",
  "CodeChef Highest Rating",
  ...DSA_PLATFORMS.map(({ label }) => `${label} URL`),
  "DSA Notes",
];

/** The sheet's own interview / placement columns — exported only when mapped and filled. */
const SHEET_COLUMNS: [string, keyof DomainCandidateRow][] = [
  ["Placed Company", "placedCompany"],
  ["Package (LPA)", "ctc"],
  ["Assessment Report", "assessmentReport"],
  ["TR-1 Panelist", "tr1Panelist"],
  ["TR-1 Panelist LinkedIn", "tr1PanelLinkedin"],
  ["TR-1 Recording", "tr1Recording"],
  ["TR-2 Panelist", "tr2Panelist"],
  ["TR-2 Panelist LinkedIn", "tr2PanelLinkedin"],
  ["TR-2 Recording", "tr2Recording"],
];

function dsaCells(c: DomainCandidate): Record<string, string> {
  const d = c.dsa;
  if (!d) return { "DSA Notes": "DSA profiles not read" };
  const num = (n: number | null | undefined) => (typeof n === "number" ? String(n) : "");
  const cells: Record<string, string> = {
    "DSA Score": String(d.score),
    "Total Solved": num(d.totalSolved),
    "Total Contests": num(d.totalContests),
    "Codeforces Max Rating": num(d.codeforces.maxRating),
    "CodeChef Highest Rating": num(d.codechef.maxRating),
  };
  const notes: string[] = [];
  for (const { key, label } of DSA_PLATFORMS) {
    const p = d[key];
    cells[`${label} Solved`] = dsaStatText(p, "solved");
    cells[`${label} Contests Participated`] = dsaStatText(p, "contests");
    cells[`${label} Rating`] = dsaStatText(p, "rating");
    cells[`${label} URL`] = p.url;
    if (p.url && p.note && p.note !== "OK") notes.push(`${label}: ${p.note}`);
  }
  if (!DSA_PLATFORMS.some(({ key }) => d[key].url)) notes.push("No LeetCode / Codeforces / CodeChef profile linked");
  if (d.partial) notes.push("A linked profile couldn't be read in full");
  cells["DSA Notes"] = notes.join(" | ");
  return cells;
}

/** GitHub cells — numbers only where the inspection really measured them. */
function githubCells(c: DomainCandidate, input: DomainCsvInput): Record<string, string> {
  const checked = c.githubStatus === "checked";
  const measured = checked || c.githubStatus === "no-repos";
  const commit = c.githubLastDomainCommit;
  const r = c.projectReview;
  const best = r?.status === "reviewed" ? r.reviews[0] : undefined;
  return {
    "GitHub Check": githubCheckLabel(c),
    "GitHub Fit Score": input.githubOn && measured ? String(c.githubScore) : "",
    "GitHub Domain Repos": input.githubOn && measured ? String(c.githubMatches) : "",
    "GitHub Proven Tech": checked ? c.githubTechs.join(", ") : "",
    "GitHub Evidence": checked ? evidenceLines(c).join("\n") : "",
    "Mandatory Not Proven on GitHub": checked ? gapLines(c).join("\n") : "",
    "Claimed but Not Found on GitHub": checked ? (c.githubClaimedNotFound ?? []).join(", ") : "",
    "GitHub Top Repos": checked ? c.githubTopRepos.map((x) => `${x.url} (${x.matchPct}%)`).join("\n") : "",
    "GitHub Commits (2y)": input.githubOn && measured ? String(c.githubCommits2y) : "",
    "Last Domain Commit": input.trackDomainCommit && commit ? formatDay(commit.date, "iso") : "",
    "Last Domain Commit Repo": input.trackDomainCommit && commit ? commit.repoUrl : "",
    "Commit Email Linked To Profile": input.trackDomainCommit && commit ? (commit.linked ? "Yes" : "No") : "",
    "GitHub AI-Commit Signal": checked ? c.githubAiLikelihood : "",
    "GitHub AI-Commit Detail": checked ? c.githubAiSummary : "",
    "GitHub Notes": c.githubNote,
    "GitHub Checked At": c.githubCheckedAt && c.githubStatus !== "failed" ? `${stamp(c.githubCheckedAt)}${c.githubFromCache ? " (reused, 24 h cache)" : ""}` : "",
    "GitHub Profile": c.githubProfile,
    "GitHub Account Is Theirs": checked
      ? c.githubIdentity === "match"
        ? "Yes — the account's name matches"
        : c.githubIdentity === "mismatch"
          ? `No — the account belongs to “${c.githubAccountName}” (not counted in the rank)`
          : `Unclear — the account shows ${c.githubAccountName ? `the name “${c.githubAccountName}”` : "no name"}`
      : "",
    "Proven on GitHub, Not on Resume": checked ? githubTechsNotOnResume(c).join(", ") : "",
    "GitHub Strength Not On Resume": checked && githubStrengthNotOnResume(c) ? "Yes" : "",
    "Project Review Score": best ? String(r!.score) : "",
    "Project Review": r ? (best ? r.reviews.map((x) => `${x.repo} (${x.score}): ${x.summary}`).join("\n") : r.note) : "",
    "Project Features (files)": best ? best.features.map((f) => `${f.name} [${f.files.join(", ")}]`).join("\n") : "",
    "Requirements Proven in Code": best ? best.covered.map((f) => `${f.requirement} [${f.files.join(", ")}]`).join("\n") : "",
    "Requirements Not Shown": best ? best.missing.join(", ") : "",
    "Project Concerns": best ? best.concerns.join("\n") : "",
    "GitHub Score Used in Rank": input.githubOn && measured ? String(githubEvidenceScore(c)) : "",
  };
}

/** The columns and rows of one CSV. */
export function domainCsv(input: DomainCsvInput): { headers: string[]; rows: Record<string, string>[] } {
  const { result, kind } = input;
  const outcomes: DomainCandidateOutcome[] = kind === "shortlisted" ? result.candidates.filter((c) => c.shortlisted) : result.candidates;
  const unscored = kind === "complete" ? input.unscored : [];
  const githubChecked = input.githubOn || input.trackDomainCommit;
  const reviewed = outcomes.some((c) => c.projectReview);
  const allRows: DomainCandidateRow[] = [...outcomes, ...unscored.map((u) => u.row)];
  const sheetColumns = SHEET_COLUMNS.filter(([, key]) => allRows.some((r) => String(r[key] ?? "").trim()));

  const headers = [
    "Rank",
    "Name",
    "Status",
    "Not Shortlisted Because",
    "Priority",
    "Rank Score",
    "Domain",
    "Domain Score",
    "Resume Core Skills",
    ...(input.dsaOn ? DSA_HEADERS : []),
    ...(githubChecked
      ? [
          "GitHub Check",
          ...(input.githubOn ? ["GitHub Fit Score", "GitHub Domain Repos"] : []),
          "GitHub Proven Tech",
          "GitHub Evidence",
          "Mandatory Not Proven on GitHub",
          "Claimed but Not Found on GitHub",
          "GitHub Top Repos",
          ...(input.githubOn ? ["GitHub Commits (2y)"] : []),
          ...(input.trackDomainCommit ? ["Last Domain Commit", "Last Domain Commit Repo", "Commit Email Linked To Profile"] : []),
          "GitHub AI-Commit Signal",
          "GitHub AI-Commit Detail",
          "GitHub Notes",
          "GitHub Checked At",
          "GitHub Profile",
          "GitHub Account Is Theirs",
          "Proven on GitHub, Not on Resume",
          "GitHub Strength Not On Resume",
          ...(reviewed ? ["Project Review Score", "Project Review", "Project Features (files)", "Requirements Proven in Code", "Requirements Not Shown", "Project Concerns"] : []),
          ...(input.githubOn ? ["GitHub Score Used in Rank"] : []),
        ]
      : []),
    ...(input.mandatoryActive ? ["Meets Mandatory"] : []),
    "Has Domain Experience",
    "Domain Experience",
    ...(input.presentation ? ["Resume Presentation Score", "Resume Presentation Notes"] : []),
    ...sheetColumns.map(([h]) => h),
    "Resume",
    "Matched In Pool By",
    "Internal Standing",
    "Internal Stage",
    "Internal Product",
    "Signals",
    ...(kind === "complete" ? ["Scored By", "Phone", "User ID"] : []),
  ];

  const sheetCells = (r: DomainCandidateRow): Record<string, string> => ({
    Name: r.name,
    Domain: input.domain.trim(),
    Resume: r.resumeUrl,
    Phone: r.phone ?? "",
    "User ID": r.userId ?? "",
    ...Object.fromEntries(sheetColumns.map(([h, key]) => [h, String(r[key] ?? "")])),
  });

  const rows: Record<string, string>[] = outcomes.map((c) => ({
    ...sheetCells(c),
    ...(input.dsaOn ? dsaCells(c) : {}),
    ...(githubChecked ? githubCells(c, input) : {}),
    ...internalColumns(c.internal, input.poolChecked),
    Rank: c.rank ? String(c.rank) : "",
    Status: c.shortlisted ? "Shortlisted" : "Not shortlisted",
    "Not Shortlisted Because": c.outcomeReason,
    Priority: c.priority ? PRIORITY_SHORT[c.priority as 1 | 2 | 3] : "",
    "Rank Score": c.rank && typeof c.rankScore === "number" ? String(c.rankScore) : "",
    "Domain Score": String(c.domainScore),
    "Resume Core Skills": c.coreSkills.join(", "),
    "Meets Mandatory": c.meetsMandatory ? "Yes" : "No",
    "Has Domain Experience": c.hasDomainExperience ? "Yes" : "No",
    "Domain Experience": c.experience,
    "Resume Presentation Score": String(c.presentationScore),
    "Resume Presentation Notes": c.presentationNotes,
    Signals: (c.signals ?? []).map((s) => `• ${s}`).join("\n"),
    "Scored By": c.scoredBy ?? "",
  }));
  for (const u of unscored) {
    rows.push({
      ...sheetCells(u.row),
      ...internalColumns(u.internal, input.poolChecked),
      Status: u.status,
      "Not Shortlisted Because": u.reason,
      Signals: `• ${u.status}: ${u.reason}`,
    });
  }
  return { headers, rows };
}
