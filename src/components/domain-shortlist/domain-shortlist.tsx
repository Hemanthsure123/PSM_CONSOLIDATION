"use client";

import * as React from "react";
import {
  BarChart3,
  Briefcase,
  CheckCircle2,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  GitCommitHorizontal,
  Github,
  Home,
  LayoutTemplate,
  ListOrdered,
  Loader2,
  Play,
  ShieldCheck,
  Square,
  Table2,
  Target,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn, toCsv, slugify, formatDay } from "@/lib/utils";
import { MIN_DOMAIN_SCORE, GITHUB_INSPECT_CAP, GITHUB_BATCH_SIZE, DEFAULT_MIN_PRESENTATION } from "@/lib/domain-scoring";
import { listSubsheets, readSubsheet } from "@/actions/sheets";
import { analyzeDomainCandidate, checkGithubForDomain, inspectGithubBatch, buildDomainReport } from "@/actions/domain";
import type { DomainCandidate, DomainCandidateRow, DomainGithubStatus, DomainReportResult } from "@/lib/types";

/** CSV / tooltip wording for each GitHub inspection outcome. */
const GITHUB_STATUS_LABEL: Record<DomainGithubStatus, string> = {
  off: "Not run",
  "no-link": "No GitHub link in resume",
  "not-inspected": "Not inspected (below domain-fit bar)",
  checked: "Checked",
  "no-repos": "No public repos with code",
  "not-found": "GitHub user not found",
  failed: "Check failed",
};

/** Table-cell wording for a candidate whose GitHub wasn't scored. */
const GITHUB_STATUS_SHORT: Record<DomainGithubStatus, string> = {
  off: "—",
  "no-link": "no link",
  "not-inspected": "—",
  checked: "",
  "no-repos": "no repos",
  "not-found": "not found",
  failed: "failed",
};

/**
 * What the GitHub inspection looked for and how it went across the run — so a run
 * where GitHub failed, or found nothing to look for, says so instead of showing
 * a column of dashes.
 */
function GithubRunSummary({
  lookedFor,
  candidates,
}: {
  lookedFor: { core: string[]; languages: string[] };
  candidates: DomainCandidate[];
}) {
  const count = (s: DomainGithubStatus) => candidates.filter((c) => c.githubStatus === s).length;
  const failed = candidates.filter((c) => c.githubStatus === "failed");
  const parts = [
    `${count("checked")} checked`,
    count("no-link") ? `${count("no-link")} without a GitHub link` : "",
    count("no-repos") ? `${count("no-repos")} with no public code` : "",
    count("not-found") ? `${count("not-found")} with a GitHub user that doesn't exist` : "",
    failed.length ? `${failed.length} failed` : "",
  ].filter(Boolean);
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>
        <Github className="mr-1 inline h-3.5 w-3.5" />
        GitHub looked for{" "}
        {lookedFor.core.length ? <strong>{lookedFor.core.join(", ")}</strong> : <strong>nothing domain-specific</strong>}
        {lookedFor.languages.length ? ` (+ ${lookedFor.languages.join(", ")} as supporting languages)` : ""} — {parts.join(" · ")}.
      </p>
      {!lookedFor.core.length && !lookedFor.languages.length ? (
        <p className="text-amber-700">
          The domain text names no tool or framework GitHub inspection can verify, so GitHub scores are 0. Add the
          stack (e.g. React, Node.js, Selenium, PyTorch, Spring Boot, SQL) to &ldquo;What defines it&rdquo;.
        </p>
      ) : null}
      {failed.length ? (
        <p className="text-amber-700">GitHub check failed for {failed.length}: {failed[0].githubNote || "unknown error"}</p>
      ) : null}
    </div>
  );
}

/** Hover detail for the GitHub cell: proven tech, best repos, notes. */
function githubTooltip(c: DomainCandidate): string {
  const lines = [GITHUB_STATUS_LABEL[c.githubStatus]];
  if (c.githubTechs.length) lines.push(`Proven in code: ${c.githubTechs.join(", ")}`);
  for (const r of c.githubTopRepos) lines.push(`${r.name} — ${r.matchPct}%${r.techs.length ? ` (${r.techs.join(", ")})` : ""}`);
  if (c.githubAiSummary && c.githubAiLikelihood && c.githubAiLikelihood !== "none") {
    lines.push(`AI-commit signal: ${c.githubAiLikelihood} — ${c.githubAiSummary}`);
  }
  if (c.githubNote) lines.push(c.githubNote);
  return lines.join("\n");
}

interface DomainShortlistProps {
  onDone: () => void;
}

/** The mappable sheet columns. Only name + resume are required. */
type ColKey =
  | "idColumn"
  | "nameColumn"
  | "resumeColumn"
  | "assessmentColumn"
  | "tr1PanelColumn"
  | "tr1LinkedinColumn"
  | "tr1RecordingColumn"
  | "tr2PanelColumn"
  | "tr2LinkedinColumn"
  | "tr2RecordingColumn"
  | "placedColumn"
  | "ctcColumn";

interface SubConfig {
  name: string;
  headers: string[];
  rowCount: number;
  selected: boolean;
  cols: Record<ColKey, string>;
}

const COL_FIELDS: { key: ColKey; label: string; required?: boolean }[] = [
  { key: "nameColumn", label: "Candidate name", required: true },
  { key: "resumeColumn", label: "Resume link", required: true },
  { key: "idColumn", label: "UUID / ID" },
  { key: "assessmentColumn", label: "Assessment report" },
  { key: "tr1PanelColumn", label: "TR-1 panelist" },
  { key: "tr1LinkedinColumn", label: "TR-1 panelist LinkedIn" },
  { key: "tr1RecordingColumn", label: "TR-1 recording link" },
  { key: "tr2PanelColumn", label: "TR-2 panelist" },
  { key: "tr2LinkedinColumn", label: "TR-2 panelist LinkedIn" },
  { key: "tr2RecordingColumn", label: "TR-2 recording link" },
  { key: "placedColumn", label: "Placed company" },
  { key: "ctcColumn", label: "Package / CTC" },
];

const TOP_N_CHOICES = [5, 10, 15, 20];

const rx = (headers: string[], re: RegExp, not?: RegExp): string =>
  headers.find((h) => re.test(h) && !(not?.test(h) ?? false)) ?? "";

function detectSub(name: string, headers: string[], rowCount: number): SubConfig {
  return {
    name,
    headers,
    rowCount,
    selected: false,
    cols: {
      idColumn: rx(headers, /uuid|user\s*id|\bid\b/i),
      nameColumn: rx(headers, /name/i, /company|panel|college|project|user|panelist/i),
      resumeColumn: rx(headers, /resume|cv|biodata/i),
      assessmentColumn: rx(headers, /assess?ment/i),
      tr1PanelColumn: rx(headers, /(tr[\s._-]*1|round[\s._-]*1).*(panel|interviewer)/i, /linked|recording|link|video/i),
      tr1LinkedinColumn: rx(headers, /(tr[\s._-]*1|round[\s._-]*1).*linked/i),
      tr1RecordingColumn: rx(headers, /(tr[\s._-]*1|round[\s._-]*1).*(record|video|link)/i, /linked|panel/i),
      tr2PanelColumn: rx(headers, /(tr[\s._-]*2|round[\s._-]*2).*(panel|interviewer)/i, /linked|recording|link|video/i),
      tr2LinkedinColumn: rx(headers, /(tr[\s._-]*2|round[\s._-]*2).*linked/i),
      tr2RecordingColumn: rx(headers, /(tr[\s._-]*2|round[\s._-]*2).*(record|video|link)/i, /linked|panel/i),
      placedColumn: rx(headers, /placed|placement|offer|company/i, /ctc|package|panel/i),
      ctcColumn: rx(headers, /ctc|package|salary|lpa|\bpay\b|stipend/i),
    },
  };
}

/**
 * Domain Shortlisting — a standalone feature.
 *
 * Given candidates whose interviews are done, it reads each resume (projects,
 * experience, github/portfolio, optionally DSA), scores fit for a chosen domain,
 * and produces the top-N (or, with the limit off, everyone who clears the bar): a
 * ranked profile REPORT (Drive PDF) plus a downloadable CSV — each with core
 * domain skills and the full interview trail.
 */
export function DomainShortlist({ onDone }: DomainShortlistProps) {
  const [runName, setRunName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [sheetTitle, setSheetTitle] = React.useState("");
  const [subs, setSubs] = React.useState<SubConfig[]>([]);
  const [fetching, setFetching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [domain, setDomain] = React.useState("");
  const [domainDetails, setDomainDetails] = React.useState("");
  const [topN, setTopN] = React.useState(10);
  const [limitToTopN, setLimitToTopN] = React.useState(true);
  const [useDsa, setUseDsa] = React.useState(false);
  const [useGithub, setUseGithub] = React.useState(true);
  const [trackDomainCommit, setTrackDomainCommit] = React.useState(false);
  const [showStats, setShowStats] = React.useState(true);
  // On: build + store the PDF shortlist report. Off: table and CSV downloads only.
  const [generateReport, setGenerateReport] = React.useState(true);
  const [mandatory, setMandatory] = React.useState("");
  const [minLeetcode, setMinLeetcode] = React.useState(0);
  const [minCommits, setMinCommits] = React.useState(0);
  const [requireExperience, setRequireExperience] = React.useState(false);
  const [checkPresentation, setCheckPresentation] = React.useState(false);
  const [minPresentation, setMinPresentation] = React.useState(DEFAULT_MIN_PRESENTATION);

  const [running, setRunning] = React.useState(false);
  const [phase, setPhase] = React.useState<"idle" | "analyze" | "github" | "build">("idle");
  const [progress, setProgress] = React.useState({ done: 0, total: 0, matched: 0 });
  const [ghProgress, setGhProgress] = React.useState({ done: 0, total: 0 });
  const [skipped, setSkipped] = React.useState<string[]>([]);
  // Every row read from the sheet + the ones whose resume couldn't be evaluated —
  // so the complete-screening CSV accounts for every candidate, not just the scored ones.
  const [sheetRows, setSheetRows] = React.useState<DomainCandidateRow[]>([]);
  const [failedRows, setFailedRows] = React.useState<{ row: DomainCandidateRow; error: string }[]>([]);
  const [showAll, setShowAll] = React.useState(false);
  const [result, setResult] = React.useState<DomainReportResult | null>(null);
  // What the GitHub inspection looked for this run (from the pre-run token check).
  const [githubLookedFor, setGithubLookedFor] = React.useState<{ core: string[]; languages: string[] } | null>(null);
  const abortRef = React.useRef(false);

  const update = (name: string, partial: Partial<SubConfig>) =>
    setSubs((prev) => prev.map((s) => (s.name === name ? { ...s, ...partial } : s)));
  const setCol = (name: string, key: ColKey, value: string) =>
    setSubs((prev) => prev.map((s) => (s.name === name ? { ...s, cols: { ...s.cols, [key]: value } } : s)));

  const fetchTabs = async () => {
    setError(null);
    setFetching(true);
    const res = await listSubsheets(url);
    setFetching(false);
    if (!res.ok) {
      setError(res.error);
      setSubs([]);
      setSheetTitle("");
      return;
    }
    setSheetTitle(res.data.title);
    const detected = res.data.subsheets.map((s) => detectSub(s.name, s.headers, s.rowCount));
    if (detected.length === 1) detected[0].selected = true;
    setSubs(detected);
    if (!runName.trim()) setRunName(res.data.title);
  };

  const selected = subs.filter((s) => s.selected && s.cols.resumeColumn && s.cols.nameColumn);
  const canRun = domain.trim().length > 0 && selected.length > 0 && !running;

  // Short name → report title/skills label. Full brief (name + details) → scoring.
  const scoringBrief = domainDetails.trim() ? `${domain.trim()} — ${domainDetails.trim()}` : domain.trim();
  // A gate implies its fetch, so coding stats are shown whenever the toggle OR gate is on.
  const dsaShown = useDsa || minLeetcode > 0;
  const ghShown = useGithub || minCommits > 0;

  const run = async () => {
    setError(null);
    setRunning(true);
    setPhase("analyze");
    setResult(null);
    setSkipped([]);
    setSheetRows([]);
    setFailedRows([]);
    setShowAll(false);
    setGhProgress({ done: 0, total: 0 });
    setGithubLookedFor(null);
    abortRef.current = false;

    // A min-LeetCode gate needs the counts; a min-commits gate needs GitHub —
    // so those gates force the relevant fetch on regardless of the toggles. The
    // latest-domain-commit lookup also needs GitHub inspection, but only shows a
    // date: it doesn't switch GitHub into the rank.
    const fetchDsa = useDsa || minLeetcode > 0;
    const rankGithub = useGithub || minCommits > 0;
    const fetchGithub = rankGithub || trackDomainCommit;

    try {
      // 0. GitHub token check BEFORE any resume is scored: a rejected or exhausted
      //    token would otherwise score every candidate's GitHub as 0 (and a commits
      //    gate would then drop all of them) without a word.
      if (fetchGithub) {
        const gh = await checkGithubForDomain(scoringBrief, mandatory);
        if (!gh.ok) {
          setError(`GitHub inspection can't run: ${gh.error} Or turn off the GitHub options (and the commits gate) to shortlist without it.`);
          return;
        }
        setGithubLookedFor({ core: gh.data.core, languages: gh.data.languages });
      }

      // 1. Read the selected tabs into candidate rows.
      const rows: DomainCandidateRow[] = [];
      for (const cfg of selected) {
        const res = await readSubsheet(url, cfg.name);
        if (!res.ok) {
          setError(res.error);
          setRunning(false);
          return;
        }
        const c = cfg.cols;
        res.data.rows.forEach((row, i) => {
          const resumeUrl = (row[c.resumeColumn] ?? "").trim();
          if (!/^https?:\/\//i.test(resumeUrl)) return;
          rows.push({
            id: (row[c.idColumn] ?? "").trim() || `${cfg.name}-${i}`,
            name: (row[c.nameColumn] ?? "").trim(),
            resumeUrl,
            assessmentReport: (row[c.assessmentColumn] ?? "").trim(),
            tr1Panelist: (row[c.tr1PanelColumn] ?? "").trim(),
            tr1PanelLinkedin: (row[c.tr1LinkedinColumn] ?? "").trim(),
            tr1Recording: (row[c.tr1RecordingColumn] ?? "").trim(),
            tr2Panelist: (row[c.tr2PanelColumn] ?? "").trim(),
            tr2PanelLinkedin: (row[c.tr2LinkedinColumn] ?? "").trim(),
            tr2Recording: (row[c.tr2RecordingColumn] ?? "").trim(),
            placedCompany: (row[c.placedColumn] ?? "").trim(),
            ctc: (row[c.ctcColumn] ?? "").trim(),
          });
        });
      }

      if (rows.length === 0) {
        setError("No rows with a usable resume link were found in the selected tabs.");
        setRunning(false);
        return;
      }

      setProgress({ done: 0, total: rows.length, matched: 0 });
      setSheetRows(rows);

      // 2. Score each candidate for the domain (one LLM call each).
      const collected: DomainCandidate[] = [];
      const failures: string[] = [];
      const failedList: { row: DomainCandidateRow; error: string }[] = [];
      let matched = 0;
      let scanned = 0;
      for (let i = 0; i < rows.length; i++) {
        if (abortRef.current) break;
        const res = await analyzeDomainCandidate(rows[i], {
          domain: scoringBrief,
          useDsa: fetchDsa,
          useGithub: fetchGithub,
          mandatory,
          requireExperience,
          checkPresentation,
        });
        if (res.ok) {
          collected.push(res.data);
          if (res.data.domainScore >= MIN_DOMAIN_SCORE) matched += 1;
        } else {
          failures.push(`${rows[i].name || rows[i].id}: ${res.error}`);
          failedList.push({ row: rows[i], error: res.error });
          setFailedRows([...failedList]);
        }
        scanned = i + 1;
        setProgress({ done: scanned, total: rows.length, matched });
        setSkipped([...failures]);
      }

      // 3. Deep GitHub inspection — ONLY for the domain-fit candidates, capped to
      //    protect the API budget. Reads what each candidate's repos' code actually
      //    uses; the 0-100 GitHub score folds into the final rank, commits feed the gate.
      if (fetchGithub && !abortRef.current) {
        const eligible = collected
          .filter((c) => c.domainScore >= MIN_DOMAIN_SCORE && (c.githubProfile || c.githubRepos.length))
          .sort((a, b) => b.domainScore - a.domainScore);
        const pool = eligible.slice(0, GITHUB_INSPECT_CAP);
        for (const c of eligible.slice(GITHUB_INSPECT_CAP)) {
          c.githubNote = `Beyond the top-${GITHUB_INSPECT_CAP} GitHub inspection cap.`;
        }
        if (pool.length) {
          setPhase("github");
          setGhProgress({ done: 0, total: pool.length });
          for (let i = 0; i < pool.length; i += GITHUB_BATCH_SIZE) {
            if (abortRef.current) break;
            const batch = pool.slice(i, i + GITHUB_BATCH_SIZE);
            const res = await inspectGithubBatch(
              batch.map((c, j) => ({ id: `${i + j}`, githubProfile: c.githubProfile, githubRepos: c.githubRepos })),
              scoringBrief,
              mandatory,
            );
            batch.forEach((c, j) => {
              const gh = res.ok ? res.data[j] : null;
              if (!gh) {
                c.githubStatus = "failed";
                c.githubNote = res.ok ? "No result returned." : res.error;
                return;
              }
              c.githubStatus = gh.status;
              c.githubNote = gh.note;
              c.githubScore = gh.score;
              c.githubMatches = gh.matches;
              c.githubTechs = gh.techs;
              c.githubTopRepos = gh.topRepos;
              c.githubCommits2y = gh.commits2y;
              c.githubLastDomainCommit = gh.lastDomainCommit;
              c.githubAiLikelihood = gh.aiLikelihood;
              c.githubAiSummary = gh.aiSummary;
            });
            setGhProgress({ done: Math.min(i + batch.length, pool.length), total: pool.length });
          }
        }
      }

      // 4. Rank + build the report; return the top-N (or every candidate) for the CSV/preview.
      setPhase("build");
      const built = await buildDomainReport(collected, {
        domain,
        topN,
        limitToTopN,
        runName: runName.trim() || sheetTitle,
        resumesScanned: scanned,
        useDsa: fetchDsa,
        useGithub: rankGithub,
        showDomainCommit: trackDomainCommit,
        showStats,
        generateReport,
        minLeetcode,
        minCommits,
        mandatoryActive: mandatory.trim().length > 0,
        requireExperience,
        checkPresentation,
        minPresentation,
      });
      if (built.ok) setResult(built.data);
      else setError(built.error);
    } finally {
      setRunning(false);
      setPhase("idle");
    }
  };

  /**
   * Two exports cut from the same outcomes:
   *  - "shortlisted": only the shortlist (top-N, or everyone who cleared every gate);
   *  - "complete": every candidate read from the sheet — shortlisted, not
   *    shortlisted (with the reason), resumes that couldn't be evaluated, and any
   *    rows a Stop left unscanned.
   */
  const downloadCsv = (kind: "shortlisted" | "complete") => {
    if (!result) return;
    const dsaOn = useDsa || minLeetcode > 0;
    const ghOn = useGithub || minCommits > 0;
    // Any GitHub inspection ran (rank, commits gate, or the latest-commit lookup).
    const ghChecked = ghOn || trackDomainCommit;
    // A real measurement: inspected, or a profile that exists with nothing to show.
    const ghMeasured = (c: DomainCandidate) => c.githubStatus === "checked" || c.githubStatus === "no-repos";
    const headers = [
      "Rank", "Name", "Status", "Not Shortlisted Because", "Domain", "Domain Score", "LeetCode Solved", "Codeforces Solved",
      "GitHub Check", "GitHub Fit Score", "GitHub Domain Repos", "GitHub Proven Tech", "GitHub Top Repos", "GitHub Commits (2y)",
      "Last Domain Commit", "Last Domain Commit Repo", "Commit Email Linked To Profile",
      "GitHub AI-Commit Signal", "GitHub AI-Commit Detail", "GitHub Notes",
      "GitHub Profile", "Meets Mandatory", "Has Domain Experience", "Domain Experience",
      "Resume Presentation Score", "Resume Presentation Notes", "Core Skills",
      "Placed Company", "Package (LPA)", "Resume", "Assessment Report", "TR-1 Panelist",
      "TR-1 Panelist LinkedIn", "TR-1 Recording", "TR-2 Panelist", "TR-2 Panelist LinkedIn", "TR-2 Recording",
    ];
    // Sheet columns carried for every row, evaluated or not.
    const sheetCells = (r: DomainCandidateRow): Record<string, string> => ({
      "Name": r.name,
      "Domain": domain.trim(),
      "Placed Company": r.placedCompany,
      "Package (LPA)": r.ctc,
      "Resume": r.resumeUrl,
      "Assessment Report": r.assessmentReport,
      "TR-1 Panelist": r.tr1Panelist,
      "TR-1 Panelist LinkedIn": r.tr1PanelLinkedin,
      "TR-1 Recording": r.tr1Recording,
      "TR-2 Panelist": r.tr2Panelist,
      "TR-2 Panelist LinkedIn": r.tr2PanelLinkedin,
      "TR-2 Recording": r.tr2Recording,
    });
    const outcomes = kind === "shortlisted" ? result.candidates.filter((c) => c.shortlisted) : result.candidates;
    const rows: Record<string, string>[] = outcomes.map((c) => {
      const commit = c.githubLastDomainCommit;
      return {
        "Rank": c.rank ? String(c.rank) : "",
        "Name": c.name,
        "Status": c.shortlisted ? "Shortlisted" : "Not shortlisted",
        "Not Shortlisted Because": c.outcomeReason,
        "Domain": domain.trim(),
        "Domain Score": String(c.domainScore),
        "LeetCode Solved": dsaOn ? String(c.leetcodeSolved) : "",
        "Codeforces Solved": dsaOn ? String(c.codeforcesSolved) : "",
        "GitHub Check": ghChecked ? GITHUB_STATUS_LABEL[c.githubStatus] : "",
        // Numbers only where they were actually measured — blank is "unknown", not 0.
        "GitHub Fit Score": ghOn && ghMeasured(c) ? String(c.githubScore) : "",
        "GitHub Domain Repos": ghOn && ghMeasured(c) ? String(c.githubMatches) : "",
        "GitHub Proven Tech": ghChecked ? c.githubTechs.join(", ") : "",
        "GitHub Top Repos": ghChecked ? c.githubTopRepos.map((r) => `${r.url} (${r.matchPct}%)`).join(" ; ") : "",
        "GitHub Commits (2y)": ghOn && ghMeasured(c) ? String(c.githubCommits2y) : "",
        "Last Domain Commit": trackDomainCommit && commit ? formatDay(commit.date, "iso") : "",
        "Last Domain Commit Repo": trackDomainCommit && commit ? commit.repoUrl : "",
        "Commit Email Linked To Profile": trackDomainCommit && commit ? (commit.linked ? "Yes" : "No") : "",
        "GitHub AI-Commit Signal": ghChecked && c.githubStatus === "checked" ? c.githubAiLikelihood : "",
        "GitHub AI-Commit Detail": ghChecked && c.githubStatus === "checked" ? c.githubAiSummary : "",
        "GitHub Notes": ghChecked ? c.githubNote : "",
        "GitHub Profile": c.githubProfile,
        "Meets Mandatory": mandatory.trim() ? (c.meetsMandatory ? "Yes" : "No") : "",
        "Has Domain Experience": c.hasDomainExperience ? "Yes" : "No",
        "Domain Experience": c.experience,
        "Resume Presentation Score": checkPresentation ? String(c.presentationScore) : "",
        "Resume Presentation Notes": checkPresentation ? c.presentationNotes : "",
        "Core Skills": c.coreSkills.join(", "),
        "Placed Company": c.placedCompany,
        "Package (LPA)": c.ctc,
        "Resume": c.resumeUrl,
        "Assessment Report": c.assessmentReport,
        "TR-1 Panelist": c.tr1Panelist,
        "TR-1 Panelist LinkedIn": c.tr1PanelLinkedin,
        "TR-1 Recording": c.tr1Recording,
        "TR-2 Panelist": c.tr2Panelist,
        "TR-2 Panelist LinkedIn": c.tr2PanelLinkedin,
        "TR-2 Recording": c.tr2Recording,
      };
    });
    if (kind === "complete") {
      for (const { row, error } of failedRows) {
        rows.push({ ...sheetCells(row), "Status": "Could not be evaluated", "Not Shortlisted Because": error });
      }
      // Rows a Stop left unscanned (rows are scanned in order, so it's the tail) —
      // listed so the sheet still accounts for every candidate.
      for (const row of sheetRows.slice(progress.done)) {
        rows.push({ ...sheetCells(row), "Status": "Not evaluated", "Not Shortlisted Because": "The run was stopped before this candidate" });
      }
    }
    // Leading BOM so Excel reads UTF-8 (₹, names) correctly.
    const blob = new Blob(["\uFEFF" + toCsv(headers, rows)], { type: "text/csv;charset=utf-8;" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download =
      kind === "shortlisted"
        ? `${slugify(domain || "domain")}-${result.limitedToTopN ? `top${result.shortlisted}` : `shortlisted-${result.shortlisted}`}.csv`
        : `${slugify(domain || "domain")}-complete-screening-${rows.length}.csv`;
    a.click();
    URL.revokeObjectURL(href);
  };

  // Every scanned row is either evaluated or failed; the rest were never reached.
  const completeCount = result
    ? result.candidates.length + failedRows.length + Math.max(0, sheetRows.length - progress.done)
    : 0;
  // With a top-N limit the preview shows the shortlist unless "show all" is on.
  const visible = result ? (result.limitedToTopN && !showAll ? result.candidates.filter((c) => c.shortlisted) : result.candidates) : [];
  const outcomeColumn = Boolean(result && (!result.limitedToTopN || showAll));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Domain Shortlisting</h2>
          <p className="text-sm text-muted-foreground">
            Read every resume for a domain — projects, experience, github{useDsa ? ", DSA" : ""}
            {checkPresentation ? ", resume presentation" : ""} — and shortlist the strongest candidates into a ranked
            report + CSV.
          </p>
        </div>
        <Button variant="outline" onClick={onDone}>
          <Home className="h-4 w-4" /> Dashboard
        </Button>
      </div>

      {/* 1 — source sheet */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileSpreadsheet className="h-4 w-4" /> Candidate sheet
          </CardTitle>
          <CardDescription>
            A Google Sheet of candidates whose interviews are done — with resume, assessment, and TR-1 / TR-2
            panel &amp; recording columns.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="dom-run-name">Report name</Label>
            <Input id="dom-run-name" value={runName} onChange={(e) => setRunName(e.target.value)} placeholder="e.g. GenAI shortlist — Batch 12" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dom-url">Google Sheet URL</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input id="dom-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
              <Button onClick={fetchTabs} disabled={!url.trim() || fetching} variant="secondary">
                {fetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Table2 className="h-4 w-4" />}
                {fetching ? "Reading…" : "Load tabs"}
              </Button>
            </div>
          </div>
          {sheetTitle ? (
            <p className="text-sm text-muted-foreground">
              Loaded <strong>{sheetTitle}</strong> — {subs.length} tab{subs.length === 1 ? "" : "s"}
            </p>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>

      {/* 2 — tabs + column mapping */}
      {subs.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tabs &amp; columns</CardTitle>
            <CardDescription>
              Name and Resume are required. The rest are optional — map what your sheet has; anything unmapped
              is simply left blank in the report.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {subs.map((s) => (
              <div key={s.name} className={cn("rounded-lg border p-3 transition-colors", s.selected ? "border-primary bg-primary/5" : "")}>
                <label className="flex cursor-pointer items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {s.name}
                    <Badge variant="secondary">{s.rowCount} rows</Badge>
                    {s.selected && (!s.cols.resumeColumn || !s.cols.nameColumn) ? (
                      <span className="text-xs font-normal text-destructive">map name + resume</span>
                    ) : null}
                  </span>
                  <Switch checked={s.selected} onCheckedChange={(v) => update(s.name, { selected: v })} />
                </label>

                {s.selected ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {COL_FIELDS.map(({ key, label, required }) => (
                      <div key={key} className="grid gap-1.5">
                        <Label className="text-xs text-muted-foreground">
                          {label}
                          {required ? " *" : ""}
                        </Label>
                        <select
                          value={s.cols[key]}
                          onChange={(e) => setCol(s.name, key, e.target.value)}
                          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                        >
                          <option value="">— none —</option>
                          {s.headers.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {/* 3 — domain */}
      {subs.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Target className="h-4 w-4" /> Domain to shortlist for
            </CardTitle>
            <CardDescription>
              A short domain <strong>name</strong> becomes the report title. The optional details only guide
              scoring — candidates are judged on real evidence (projects, experience/internships, github).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="dom-name" className="text-sm">Domain name <span className="text-muted-foreground">(shown on the report)</span></Label>
              <Input
                id="dom-name"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="e.g. AI / ML"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="dom-details" className="text-sm">
                What defines it <span className="text-muted-foreground">(optional — topics, tools, what makes a strong fit)</span>
              </Label>
              <textarea
                id="dom-details"
                rows={3}
                value={domainDetails}
                onChange={(e) => setDomainDetails(e.target.value)}
                placeholder="e.g. Supervised/unsupervised learning, deep learning (CNNs, Transformers), NLP, CV, model training & fine-tuning, PyTorch/TensorFlow, Hugging Face. Strong if trained real models with measurable results or interned on an AI/ML team."
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            <div className="space-y-3 rounded-lg border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <Label htmlFor="dom-topn" className="flex items-center gap-2 text-sm">
                    <ListOrdered className="h-4 w-4" /> Limit to top N profiles
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    On: only the best N candidates are shortlisted into the report and CSV. Off: everyone who clears the
                    domain-fit bar and the strict gates is shortlisted, and the table + CSV list <strong>every</strong>{" "}
                    scanned candidate with their scores — and, for those not shortlisted, the reason.
                  </p>
                </div>
                <Switch id="dom-topn" checked={limitToTopN} onCheckedChange={setLimitToTopN} />
              </div>
              {limitToTopN ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Shortlist size</span>
                  {TOP_N_CHOICES.map((n) => (
                    <Button key={n} type="button" size="sm" variant={topN === n ? "default" : "outline"} onClick={() => setTopN(n)}>
                      Top {n}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>

            {/* Strict requirements — hard gates; only candidates clearing ALL are shortlisted. */}
            <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/40 p-3">
              <div className="space-y-0.5">
                <Label className="flex items-center gap-2 text-sm font-medium text-amber-900">
                  <ShieldCheck className="h-4 w-4" /> Strict requirements (hard gates)
                </Label>
                <p className="text-xs text-amber-900/80">
                  Only candidates who clear <strong>every</strong> requirement below are shortlisted — checked as the
                  main priority, before ranking.
                </p>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="dom-mandatory" className="text-xs text-muted-foreground">
                  Mandatory skills / requirements (each must have real evidence)
                </Label>
                <Input
                  id="dom-mandatory"
                  value={mandatory}
                  onChange={(e) => setMandatory(e.target.value)}
                  placeholder="e.g. React.js, Node.js, DSA"
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="dom-min-lc" className="text-xs text-muted-foreground">
                    Minimum LeetCode solved (0 = no gate)
                  </Label>
                  <Input
                    id="dom-min-lc"
                    type="number"
                    min={0}
                    value={minLeetcode || ""}
                    onChange={(e) => setMinLeetcode(Math.max(0, Number(e.target.value) || 0))}
                    placeholder="e.g. 250"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="dom-min-commits" className="text-xs text-muted-foreground">
                    Minimum GitHub commits, last 2y (0 = no gate)
                  </Label>
                  <Input
                    id="dom-min-commits"
                    type="number"
                    min={0}
                    value={minCommits || ""}
                    onChange={(e) => setMinCommits(Math.max(0, Number(e.target.value) || 0))}
                    placeholder="e.g. 100"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                A LeetCode gate auto-reads solved counts; a commits gate auto-runs GitHub inspection — so those counts
                appear in the report and CSV. Candidates whose links aren&apos;t found count as 0 and are excluded; a
                GitHub check that fails says so in the reason instead of passing as 0.
              </p>

              <div className="flex items-start justify-between gap-3 rounded-md border border-amber-200 bg-white/60 p-3">
                <div className="space-y-0.5">
                  <Label htmlFor="dom-exp" className="flex items-center gap-2 text-sm">
                    <Briefcase className="h-4 w-4" /> Require domain internship / experience
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Strictly require a real internship or job with work matching this domain (and the mandatory skills)
                    — a personal project or course does not count. The matched experience shows in the report and CSV.
                  </p>
                </div>
                <Switch id="dom-exp" checked={requireExperience} onCheckedChange={setRequireExperience} />
              </div>

              {/* Resume presentation — structure, alignment, visual polish of the document itself. */}
              <div className="space-y-3 rounded-md border border-amber-200 bg-white/60 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-0.5">
                    <Label htmlFor="dom-presentation" className="flex items-center gap-2 text-sm">
                      <LayoutTemplate className="h-4 w-4" /> Require a well-presented resume
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Grades the resume <strong>document</strong> — standard sections in the right order, aligned dates
                      and margins, one consistent bullet/date/heading style, scannable hierarchy, clean single-column
                      ATS-safe layout, no typos — and how good it looks at a glance. Judged separately from skills, so a
                      messy resume can&apos;t ride on a strong profile. The score, its one-line reason, and a
                      colour-coded badge appear in the report and CSV, and polish breaks ties in the final rank.
                    </p>
                  </div>
                  <Switch id="dom-presentation" checked={checkPresentation} onCheckedChange={setCheckPresentation} />
                </div>

                {checkPresentation ? (
                  <div className="grid gap-1.5 sm:max-w-xs">
                    <Label htmlFor="dom-min-pres" className="text-xs text-muted-foreground">
                      Minimum presentation score (0 = grade &amp; rank only, exclude nobody)
                    </Label>
                    <Input
                      id="dom-min-pres"
                      type="number"
                      min={0}
                      max={100}
                      value={minPresentation || ""}
                      onChange={(e) => setMinPresentation(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                      placeholder={`e.g. ${DEFAULT_MIN_PRESENTATION}`}
                    />
                    <p className="text-xs text-muted-foreground">
                      85+ recruiter-ready · 70–84 solid &amp; professional · 50–69 visibly rough · below 50 messy.
                      Layout is read from the resume PDF itself; a text-only resume is graded on structure alone.
                    </p>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="dom-github" className="flex items-center gap-2 text-sm">
                  <Github className="h-4 w-4" /> Deep GitHub inspection (domain-fit candidates only)
                </Label>
                <p className="text-xs text-muted-foreground">
                  After the resume pass, each domain-fit candidate&apos;s public repos are opened and read — dependency
                  files (requirements, package.json, pom.xml, gradle), imports and calls in the code, Docker/CI config
                  and test files — to see which of the domain&apos;s technologies they <strong>actually use</strong>,
                  not what the repo is named. That gives a 0-100 GitHub score (worth up to +20 in the final rank),
                  the domain repos, the proven tech, and an AI-commit signal for the CSV. Plain languages (Python,
                  JavaScript, Java) alone don&apos;t count as domain proof when the domain names frameworks. Name
                  the tools in &ldquo;What defines it&rdquo; so there is something to look for. Uses your{" "}
                  <code>GITHUB_TOKEN</code> (checked before the run); about 5 s per candidate.
                </p>
              </div>
              <Switch id="dom-github" checked={useGithub} onCheckedChange={setUseGithub} />
            </div>

            <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="dom-last-commit" className="flex items-center gap-2 text-sm">
                  <GitCommitHorizontal className="h-4 w-4" /> Latest domain commit date
                </Label>
                <p className="text-xs text-muted-foreground">
                  Shows when each domain-fit candidate last committed to one of <strong>their own</strong> GitHub repos
                  whose code proves this domain — in the table, report and CSV. Informational only: it doesn&apos;t
                  change the rank. Runs the GitHub inspection even if the toggle above is off; uses your{" "}
                  <code>GITHUB_TOKEN</code>.
                </p>
              </div>
              <Switch id="dom-last-commit" checked={trackDomainCommit} onCheckedChange={setTrackDomainCommit} />
            </div>

            <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="dom-dsa" className="flex items-center gap-2 text-sm">
                  <ShieldCheck className="h-4 w-4" /> Also weigh DSA (LeetCode / Codeforces)
                </Label>
                <p className="text-xs text-muted-foreground">
                  When on, each resume&apos;s LeetCode / Codeforces profiles are read and their solved counts fold in as
                  a secondary strength signal. Slower (extra fetches per candidate).
                </p>
              </div>
              <Switch id="dom-dsa" checked={useDsa} onCheckedChange={setUseDsa} />
            </div>

            <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="dom-report" className="flex items-center gap-2 text-sm">
                  <FileText className="h-4 w-4" /> Generate PDF report
                </Label>
                <p className="text-xs text-muted-foreground">
                  On: build the ranked shortlist report (PDF on Drive) along with the CSVs. Off: skip the report —
                  the results table and both CSV downloads work exactly the same, and the run finishes faster.
                </p>
              </div>
              <Switch id="dom-report" checked={generateReport} onCheckedChange={setGenerateReport} />
            </div>

            <div className={cn("flex items-start justify-between gap-3 rounded-lg border p-3", !generateReport && "opacity-50")}>
              <div className="space-y-0.5">
                <Label htmlFor="dom-stats" className="flex items-center gap-2 text-sm">
                  <BarChart3 className="h-4 w-4" /> Show scan summary in the report
                </Label>
                <p className="text-xs text-muted-foreground">
                  The &ldquo;candidates scanned / domain matches / shortlisted&rdquo; stat strip at the top of the
                  report. Turn off for a cleaner, shortlist-only document.
                </p>
              </div>
              <Switch id="dom-stats" checked={showStats} onCheckedChange={setShowStats} disabled={!generateReport} />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* 4 — run + outputs */}
      {subs.length ? (
        <Card>
          <CardContent className="space-y-3 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={run} disabled={!canRun}>
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {!running
                  ? limitToTopN
                    ? `Shortlist top ${topN} for the domain`
                    : "Shortlist all candidates for the domain"
                  : phase === "github"
                    ? `Inspecting GitHub ${ghProgress.done}/${ghProgress.total}…`
                    : phase === "build"
                      ? generateReport
                        ? "Building report…"
                        : "Ranking candidates…"
                      : `Scanning ${progress.done}/${progress.total}…`}
              </Button>
              {running ? (
                <>
                  <Button variant="outline" onClick={() => (abortRef.current = true)}>
                    <Square className="h-4 w-4" /> Stop
                  </Button>
                  <span className="text-sm text-muted-foreground">{progress.matched} domain match{progress.matched === 1 ? "" : "es"} so far</span>
                </>
              ) : null}
            </div>

            {!canRun && !running && subs.some((s) => s.selected) && !domain.trim() ? (
              <p className="text-xs text-muted-foreground">Enter the domain first.</p>
            ) : null}

            {result ? (
              <div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
                <p className="flex items-center gap-2 text-sm font-medium text-emerald-900">
                  <CheckCircle2 className="h-4 w-4" />
                  Shortlisted {result.shortlisted} of {result.considered} domain match
                  {result.considered === 1 ? "" : "es"} across {progress.total} candidate{progress.total === 1 ? "" : "s"}
                  {result.limitedToTopN ? "" : " — every candidate's outcome is listed below"}
                </p>
                <div className="flex flex-wrap items-center gap-4">
                  {result.link ? (
                    <a href={result.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                      <ExternalLink className="h-4 w-4" /> Open the shortlist report
                    </a>
                  ) : null}
                  <Button size="sm" variant="outline" onClick={() => downloadCsv("shortlisted")} disabled={result.shortlisted === 0}>
                    <Download className="h-4 w-4" /> Shortlisted CSV ({result.shortlisted})
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => downloadCsv("complete")} disabled={completeCount === 0}>
                    <Download className="h-4 w-4" /> Complete screening CSV ({completeCount})
                  </Button>
                  {result.limitedToTopN ? (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Switch checked={showAll} onCheckedChange={setShowAll} /> Show every evaluated candidate below
                    </label>
                  ) : null}
                </div>
                {result.reportSkipped ? (
                  <p className="text-xs text-muted-foreground">
                    PDF report not generated (&ldquo;Generate PDF report&rdquo; was off) — use the CSV downloads above.
                  </p>
                ) : result.pdfError ? (
                  <p className="text-xs text-amber-700">
                    The PDF report couldn&apos;t be generated ({result.pdfError}). The shortlist is complete — use
                    <strong> the CSV downloads</strong> above. This is usually low memory; close other apps and re-run to
                    also get the PDF.
                  </p>
                ) : result.link && result.storage === "local" ? (
                  <p className="text-xs text-amber-700">Saved locally (Drive storage quota unavailable) — served by this app.</p>
                ) : null}
                {result.shortlisted === 0 ? (
                  <p className="text-xs text-amber-700">
                    No candidate cleared every requirement. Try broadening the domain or relaxing the strict gates.
                  </p>
                ) : null}
                {result.excluded.mandatory + result.excluded.leetcode + result.excluded.commits + result.excluded.experience + result.excluded.presentation > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Strict gates removed{" "}
                    {[
                      result.excluded.mandatory ? `${result.excluded.mandatory} missing a mandatory skill` : "",
                      result.excluded.experience ? `${result.excluded.experience} without domain experience` : "",
                      result.excluded.leetcode ? `${result.excluded.leetcode} below the LeetCode minimum` : "",
                      result.excluded.commits ? `${result.excluded.commits} below the GitHub-commits minimum` : "",
                      result.excluded.presentation ? `${result.excluded.presentation} with a poorly presented resume` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    .
                  </p>
                ) : null}
                {githubLookedFor ? <GithubRunSummary lookedFor={githubLookedFor} candidates={result.candidates} /> : null}
              </div>
            ) : null}

            {result && visible.length ? (
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">#</TableHead>
                      <TableHead>Name</TableHead>
                      {outcomeColumn ? <TableHead>Outcome</TableHead> : null}
                      <TableHead className="w-16">Fit</TableHead>
                      {dsaShown ? <TableHead className="w-20">LeetCode</TableHead> : null}
                      {ghShown ? <TableHead className="w-24">GitHub</TableHead> : null}
                      {ghShown ? <TableHead className="w-16">Commits</TableHead> : null}
                      {trackDomainCommit ? <TableHead className="w-28">Last domain commit</TableHead> : null}
                      {requireExperience ? <TableHead className="w-14">Exp</TableHead> : null}
                      {checkPresentation ? <TableHead className="w-20">Resume</TableHead> : null}
                      <TableHead>Core skills</TableHead>
                      <TableHead>Placed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((c, i) => (
                      <TableRow key={`${c.id}-${i}`}>
                        <TableCell className="font-mono text-xs text-muted-foreground">{c.rank || "—"}</TableCell>
                        <TableCell className="font-medium">{c.name || "—"}</TableCell>
                        {!outcomeColumn ? null : (
                          <TableCell className="text-xs">
                            {c.shortlisted ? (
                              <span className="font-medium text-emerald-700">Shortlisted</span>
                            ) : (
                              <span className="text-amber-700">{c.outcomeReason}</span>
                            )}
                          </TableCell>
                        )}
                        <TableCell className="font-mono text-xs">{c.domainScore}</TableCell>
                        {dsaShown ? (
                          <TableCell className="font-mono text-xs">{c.leetcodeSolved || "—"}</TableCell>
                        ) : null}
                        {ghShown ? (
                          <TableCell className="text-xs" title={githubTooltip(c)}>
                            {c.githubStatus === "checked" ? (
                              <span className="font-mono">
                                <span className={cn(c.githubScore >= 70 ? "text-emerald-700" : c.githubScore >= 40 ? "text-primary" : "text-muted-foreground")}>
                                  {c.githubScore}
                                </span>
                                <span className="text-muted-foreground"> · {c.githubMatches} repo{c.githubMatches === 1 ? "" : "s"}</span>
                              </span>
                            ) : (
                              <span className={cn(c.githubStatus === "failed" || c.githubStatus === "not-found" ? "text-amber-700" : "text-muted-foreground")}>
                                {GITHUB_STATUS_SHORT[c.githubStatus]}
                              </span>
                            )}
                          </TableCell>
                        ) : null}
                        {ghShown ? (
                          <TableCell className="font-mono text-xs">{c.githubStatus === "checked" ? c.githubCommits2y : "—"}</TableCell>
                        ) : null}
                        {trackDomainCommit ? (
                          <TableCell className="text-xs">
                            {c.githubLastDomainCommit ? (
                              <a
                                href={c.githubLastDomainCommit.repoUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="font-mono text-primary hover:underline"
                                title={`${c.githubLastDomainCommit.repo}${
                                  c.githubLastDomainCommit.linked ? "" : " · commit email isn't linked to their GitHub profile"
                                }`}
                              >
                                {formatDay(c.githubLastDomainCommit.date)}
                              </a>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                        ) : null}
                        {requireExperience ? (
                          <TableCell className="text-xs">{c.hasDomainExperience ? "Yes" : "No"}</TableCell>
                        ) : null}
                        {checkPresentation ? (
                          <TableCell
                            className={cn(
                              "font-mono text-xs",
                              c.presentationScore >= 85
                                ? "text-emerald-700"
                                : c.presentationScore >= 70
                                  ? "text-primary"
                                  : "text-amber-700",
                            )}
                            title={c.presentationNotes}
                          >
                            {c.presentationScore || "—"}
                          </TableCell>
                        ) : null}
                        <TableCell className="text-xs">{c.coreSkills.join(", ") || "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {c.placedCompany ? `${c.placedCompany}${c.ctc ? ` · ${c.ctc}` : ""}` : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}

            {skipped.length ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">
                  {skipped.length} candidate{skipped.length === 1 ? "" : "s"} skipped
                </summary>
                <ul className="mt-1 space-y-0.5 pl-4">
                  {skipped.slice(0, 15).map((s) => (
                    <li key={s} className="list-disc">
                      {s}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
