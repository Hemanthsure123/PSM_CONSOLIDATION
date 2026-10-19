"use client";

import * as React from "react";
import {
  BarChart3,
  Briefcase,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  FileX,
  GitCommitHorizontal,
  Github,
  LayoutTemplate,
  ListOrdered,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  Square,
  Table2,
  Target,
  Trophy,
  Users,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Panel } from "@/components/ui/panel";
import { Field } from "@/components/ui/field";
import { SettingList, SettingRow } from "@/components/ui/setting-row";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Segmented } from "@/components/ui/segmented";
import { InfoHint } from "@/components/ui/info-hint";
import { Notice } from "@/components/ui/notice";
import { Progress } from "@/components/ui/progress";
import { Stat, StatGrid } from "@/components/ui/stat";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionBar } from "@/components/ui/action-bar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useReportBusy } from "@/components/busy-context";
import { cn, toCsv, slugify, formatDay } from "@/lib/utils";
import { MIN_DOMAIN_SCORE, GITHUB_INSPECT_CAP, DEFAULT_MIN_PRESENTATION } from "@/lib/domain-scoring";
import { NO_DSA_GATES, bestRating, dsaGatesActive, ratingsLine, type DsaGates } from "@/lib/dsa-scoring";
import { DSA_PLATFORMS, type DsaPlatform, type DsaPlatformResult } from "@/lib/dsa-types";
import { listSubsheets, readSubsheet } from "@/actions/sheets";
import { checkGithubForDomain, buildDomainReport } from "@/actions/domain";
import { runQueue } from "@/lib/parallel-queue";
import type { GithubInspectResult } from "@/lib/domain-screen";
import type { DomainCandidate, DomainCandidateRow, DomainGithubGap, DomainGithubStatus, DomainReportResult } from "@/lib/types";

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
  const reused = candidates.filter((c) => c.githubFromCache).length;
  const parts = [
    `${count("checked")} checked${reused ? ` (${reused} reused from the last 24 h)` : ""}`,
    count("no-link") ? `${count("no-link")} without a GitHub link` : "",
    count("no-repos") ? `${count("no-repos")} with no public code` : "",
    count("not-found") ? `${count("not-found")} with a GitHub user that doesn't exist` : "",
    failed.length ? `${failed.length} failed` : "",
  ].filter(Boolean);
  return (
    <div className="space-y-2.5 rounded-xl border bg-card px-4 py-3 shadow-surface">
      <p className="flex items-start gap-2.5 text-[13px] leading-relaxed">
        <Github className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0">
          GitHub looked for{" "}
          {lookedFor.core.length ? <strong className="font-semibold">{lookedFor.core.join(", ")}</strong> : <strong className="font-semibold">nothing domain-specific</strong>}
          {lookedFor.languages.length ? ` (+ ${lookedFor.languages.join(", ")} as supporting languages)` : ""}
          <span className="text-muted-foreground"> — {parts.join(" · ")}.</span>
        </span>
      </p>
      {!lookedFor.core.length && !lookedFor.languages.length ? (
        <Notice tone="warning">
          The domain text names no tool or framework GitHub inspection can verify, so GitHub scores are 0. Add the
          stack (e.g. React, Node.js, Selenium, PyTorch, Spring Boot, SQL) to &ldquo;What defines it&rdquo;.
        </Notice>
      ) : null}
      {failed.length ? (
        <Notice tone="warning">
          GitHub check failed for {failed.length}: {failed[0].githubNote || "unknown error"}
        </Notice>
      ) : null}
    </div>
  );
}

/** Why a mandatory technology isn't proven, in words. */
const GAP_REASON: Record<DomainGithubGap["reason"], string> = {
  none: "no evidence in the inspected repos",
  "readme-only": "only named in a README / topics",
  weak: "weak evidence",
};

/** "PyTorch: import torch in src/train.py (chest-xray)" — one per proven technology. */
const evidenceLines = (c: DomainCandidate): string[] =>
  (c.githubEvidence ?? []).map((e) => `${e.tech}: ${e.detail}${e.repo ? ` (${e.repo})` : ""}`);

/** "Kafka — no evidence in the inspected repos" — one per mandatory technology the code doesn't prove. */
const gapLines = (c: DomainCandidate): string[] =>
  (c.githubMandatoryGaps ?? []).map((g) => `${g.tech} — ${GAP_REASON[g.reason]}${g.reason === "weak" && g.detail ? `: ${g.detail}` : ""}`);

/** "2026-10-18 14:05" (local time) of an ISO stamp, "" when there is none. */
function stamp(iso: string | undefined): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Hover detail for the GitHub cell: proven tech and its proof, gaps, claims, best repos, notes. */
function githubTooltip(c: DomainCandidate): string {
  const lines = [GITHUB_STATUS_LABEL[c.githubStatus]];
  if (c.githubTechs.length) lines.push(`Proven in code: ${c.githubTechs.join(", ")}`);
  for (const line of evidenceLines(c)) lines.push(`  • ${line}`);
  const gaps = gapLines(c);
  if (gaps.length) lines.push(`Mandatory not proven: ${gaps.join("; ")}`);
  if (c.githubClaimedNotFound?.length) lines.push(`Claimed on the resume, not found in code: ${c.githubClaimedNotFound.join(", ")}`);
  for (const r of c.githubTopRepos) lines.push(`${r.name} — ${r.matchPct}%${r.techs.length ? ` (${r.techs.join(", ")})` : ""}`);
  if (c.githubAiSummary && c.githubAiLikelihood && c.githubAiLikelihood !== "none") {
    lines.push(`AI-commit signal: ${c.githubAiLikelihood} — ${c.githubAiSummary}`);
  }
  if (c.githubNote) lines.push(c.githubNote);
  if (c.githubCheckedAt) lines.push(`Checked ${stamp(c.githubCheckedAt)}${c.githubFromCache ? " (reused from the 24 h cache)" : ""}`);
  return lines.join("\n");
}

/** A DSA stat for the CSV, worded like the DSA consolidation export ("" = no profile linked). */
function dsaStatText(p: DsaPlatformResult, field: "solved" | "contests" | "rating"): string {
  if (!p.url) return "";
  if (p.found === false) return "Profile not found";
  const value = p[field];
  if (typeof value === "number") return String(value);
  if (field === "rating" && p.found === true && p.contests !== null && p.contests !== undefined) return "Unrated";
  return "N/A";
}

/** Hover text for the DSA cell: every platform's solved / contests / rating. */
function dsaTooltip(c: DomainCandidate): string {
  const d = c.dsa;
  if (!d) return "DSA profiles not read";
  const lines = [`DSA score ${d.score}/100${d.partial ? " (a profile couldn't be read in full)" : ""}`];
  for (const { key, label } of DSA_PLATFORMS) {
    const p = d[key];
    if (!p.url) {
      lines.push(`${label}: no profile linked`);
      continue;
    }
    if (p.found === false) {
      lines.push(`${label}: profile not found`);
      continue;
    }
    const r = bestRating(p);
    const bits = [
      typeof p.solved === "number" ? `${p.solved} solved` : "solved N/A",
      typeof p.contests === "number" ? `${p.contests} contests` : "",
      r !== null ? `rating ${r}` : "",
    ].filter(Boolean);
    lines.push(`${label}: ${bits.join(" · ")}`);
  }
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

/**
 * Resumes screened at once. Each is one model call: Gemini first, OpenAI when Gemini is
 * rate-limited, Mistral when OpenAI is too — anything still failing is retried.
 */
const CONCURRENCY_OPTIONS = [4, 6, 8, 10, 12];
/** Display names for the provider part of a candidate's `scoredBy`. */
const PROVIDER_LABEL: Record<string, string> = { gemini: "Gemini", openai: "OpenAI", mistral: "Mistral", groq: "Groq" };
const DEFAULT_CONCURRENCY = 8;
/** GitHub profiles inspected at once (each reads up to 3 repos at a time — well inside GitHub's limits). */
const GITHUB_PARALLEL = 6;
/** A resume that failed for a passing reason (rate limit, overloaded model, network) is retried this often. */
const SCREEN_RETRIES = 2;
const RATE_RETRY_MS = 20_000;
const NETWORK_RETRY_MS = 4_000;
const NETWORK_PREFIX = "Network error";

/** What the browser gets back for one screened row. */
type ScreenReply =
  | { ok: true; candidate: DomainCandidate }
  | { ok: false; kind: "invalid" | "error"; error: string; retryable: boolean };

/** A row with no score: not a resume (final), or could not be evaluated (retryable from the results). */
interface FailedRow {
  row: DomainCandidateRow;
  error: string;
  kind: "invalid" | "error";
  /** A passing failure (rate limit, overloaded model, network) — worth screening again later. */
  retryable: boolean;
}

/** Everything a run needs, snapshotted at Start. */
interface RunConfig {
  domainName: string;
  scoringBrief: string;
  mandatory: string;
  fetchDsa: boolean;
  rankGithub: boolean;
  fetchGithub: boolean;
  requireExperience: boolean;
  checkPresentation: boolean;
  trackDomainCommit: boolean;
  topN: number;
  limitToTopN: boolean;
  runName: string;
  showStats: boolean;
  generateReport: boolean;
  dsaGates: DsaGates;
  minCommits: number;
  minPresentation: number;
  /** Inspect GitHub afresh instead of reusing results from the last 24 h. */
  githubRefresh: boolean;
}

/** Screen one row through /api/domain/analyze. Never throws. */
async function postScreen(row: DomainCandidateRow, cfg: RunConfig): Promise<ScreenReply> {
  try {
    const res = await fetch("/api/domain/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        row,
        opts: {
          domain: cfg.scoringBrief,
          mandatory: cfg.mandatory,
          useDsa: cfg.fetchDsa,
          useGithub: cfg.fetchGithub,
          requireExperience: cfg.requireExperience,
          checkPresentation: cfg.checkPresentation,
        },
      }),
    });
    const text = await res.text();
    let data: { result?: ScreenReply; error?: string } = {};
    try {
      data = JSON.parse(text);
    } catch {
      // A cut-off / non-JSON reply (server restarting, proxy hiccup) — transient.
      return { ok: false, kind: "error", error: `${NETWORK_PREFIX}: unreadable reply from the server (HTTP ${res.status})`, retryable: true };
    }
    if (!res.ok || !data.result) {
      return { ok: false, kind: "error", error: data.error || `Server returned HTTP ${res.status}`, retryable: res.status >= 500 };
    }
    return data.result;
  } catch (err) {
    return { ok: false, kind: "error", error: `${NETWORK_PREFIX}: ${err instanceof Error ? err.message : "request failed"}`, retryable: true };
  }
}

/** Inspect one candidate's GitHub through /api/domain/github. Never throws. */
async function postGithub(c: DomainCandidate, cfg: RunConfig): Promise<GithubInspectResult> {
  const failed = (note: string): GithubInspectResult => ({
    id: c.id,
    status: "failed",
    note,
    score: 0,
    matches: 0,
    techs: [],
    topRepos: [],
    commits2y: 0,
    lastDomainCommit: null,
    aiLikelihood: "",
    aiSummary: "",
    evidence: [],
    mandatoryGaps: [],
    claimedNotFound: [],
    checkedAt: "",
    fromCache: false,
    retryable: true,
  });
  try {
    const res = await fetch("/api/domain/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { id: c.id, githubProfile: c.githubProfile, githubRepos: c.githubRepos, claimedTechs: c.resumeTechs ?? [] },
        domain: cfg.scoringBrief,
        mandatory: cfg.mandatory,
        refresh: cfg.githubRefresh,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { result?: GithubInspectResult; error?: string };
    return data.result ?? failed(data.error || `Server returned HTTP ${res.status}`);
  } catch (err) {
    return failed(`${NETWORK_PREFIX}: ${err instanceof Error ? err.message : "request failed"}`);
  }
}

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
 *
 * `onDone` stays in the props, but the shell's sidebar now handles going back to the dashboard.
 */
export function DomainShortlist(_props: DomainShortlistProps) {
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
  // Off (default): a GitHub inspection from the last 24 h is reused. On: inspect everyone afresh.
  const [githubRefresh, setGithubRefresh] = React.useState(false);
  const [showStats, setShowStats] = React.useState(true);
  // On: build + store the PDF shortlist report. Off: table and CSV downloads only.
  const [generateReport, setGenerateReport] = React.useState(true);
  const [mandatory, setMandatory] = React.useState("");
  // DSA gates (solved / contests / rating / DSA score across LeetCode, Codeforces, CodeChef).
  const [dsaGates, setDsaGates] = React.useState<DsaGates>(NO_DSA_GATES);
  const [minCommits, setMinCommits] = React.useState(0);
  const [requireExperience, setRequireExperience] = React.useState(false);
  const [checkPresentation, setCheckPresentation] = React.useState(false);
  const [minPresentation, setMinPresentation] = React.useState(DEFAULT_MIN_PRESENTATION);

  const [running, setRunning] = React.useState(false);
  useReportBusy(running);
  const [phase, setPhase] = React.useState<"idle" | "analyze" | "github" | "build">("idle");
  const [progress, setProgress] = React.useState({ done: 0, total: 0, matched: 0 });
  const [ghProgress, setGhProgress] = React.useState({ done: 0, total: 0, reused: 0 });
  // Parallel screening: how many at once, and how many are running / waiting to retry now.
  const [concurrency, setConcurrency] = React.useState(DEFAULT_CONCURRENCY);
  const [activity, setActivity] = React.useState({ running: 0, waiting: 0 });
  const [skipped, setSkipped] = React.useState<string[]>([]);
  // Every row read from the sheet + the ones whose resume couldn't be evaluated —
  // so the complete-screening CSV accounts for every candidate, not just the scored ones.
  const [sheetRows, setSheetRows] = React.useState<DomainCandidateRow[]>([]);
  const [failedRows, setFailedRows] = React.useState<FailedRow[]>([]);
  const sheetRowsRef = React.useRef<DomainCandidateRow[]>([]);
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
  const dsaShown = useDsa || dsaGatesActive(dsaGates);
  const gateNumber = (v: string) => Math.max(0, Math.floor(Number(v) || 0));
  const setDsaGate = (key: "minSolved" | "minContests" | "minScore", v: string) =>
    setDsaGates((g) => ({ ...g, [key]: key === "minScore" ? Math.min(100, gateNumber(v)) : gateNumber(v) }));
  const setRatingGate = (key: DsaPlatform, v: string) =>
    setDsaGates((g) => ({ ...g, minRating: { ...g.minRating, [key]: gateNumber(v) } }));
  const ghShown = useGithub || minCommits > 0;

  // Everything a run needs, snapshotted at Start so "Retry" screens the rest the same way.
  const cfgRef = React.useRef<RunConfig | null>(null);
  // Screened candidates of this run, and the sheet rows that already have a final result.
  const collectedRef = React.useRef<DomainCandidate[]>([]);
  const processedRef = React.useRef<Set<DomainCandidateRow>>(new Set());
  const failedRef = React.useRef<FailedRow[]>([]);
  const matchedRef = React.useRef(0);
  const retriesRef = React.useRef(0);
  const concurrencyRef = React.useRef(concurrency);
  concurrencyRef.current = concurrency;

  const currentConfig = (): RunConfig => {
    const fetchDsa = useDsa || dsaGatesActive(dsaGates);
    const rankGithub = useGithub || minCommits > 0;
    return {
      domainName: domain,
      scoringBrief,
      mandatory,
      fetchDsa,
      rankGithub,
      fetchGithub: rankGithub || trackDomainCommit,
      requireExperience,
      checkPresentation,
      trackDomainCommit,
      topN,
      limitToTopN,
      runName: runName.trim() || sheetTitle,
      showStats,
      generateReport,
      dsaGates,
      minCommits,
      githubRefresh,
      minPresentation,
    };
  };

  /**
   * Screen `rows` in parallel (a rolling window of `concurrency` requests). Each row
   * ends as a scored candidate, "not a resume", or "could not be evaluated"; a passing
   * failure (rate limit, overloaded model, network) is retried before it counts.
   */
  const screenRows = async (rows: DomainCandidateRow[], cfg: RunConfig) => {
    await runQueue<DomainCandidateRow, ScreenReply>({
      items: rows,
      concurrency: () => concurrencyRef.current,
      stopped: () => abortRef.current,
      run: (row) => postScreen(row, cfg),
      retryAfter: (res, attempt) => {
        if (res.ok || !res.retryable || attempt > SCREEN_RETRIES) return null;
        retriesRef.current++;
        return res.error.startsWith(NETWORK_PREFIX) ? NETWORK_RETRY_MS : RATE_RETRY_MS * attempt;
      },
      onDone: (row, res) => {
        processedRef.current.add(row);
        if (res.ok) {
          collectedRef.current.push(res.candidate);
          if (res.candidate.domainScore >= MIN_DOMAIN_SCORE) matchedRef.current += 1;
        } else {
          failedRef.current.push({ row, error: res.error, kind: res.kind, retryable: res.retryable });
          setFailedRows([...failedRef.current]);
          setSkipped(failedRef.current.map((f) => `${f.row.name || f.row.id}: ${f.error}`));
        }
        setProgress({ done: processedRef.current.size, total: sheetRowsRef.current.length, matched: matchedRef.current });
      },
      onActivity: (running, waiting) => setActivity({ running, waiting }),
    });
  };

  /**
   * Deep GitHub inspection — ONLY for domain-fit candidates not yet inspected, capped
   * to protect the API budget, several candidates at a time. The 0-100 GitHub score
   * folds into the final rank; commits feed the gate.
   */
  const inspectGithub = async (cfg: RunConfig) => {
    const all = collectedRef.current;
    const inspected = all.filter((c) => c.githubStatus !== "not-inspected" && c.githubStatus !== "off" && c.githubStatus !== "no-link").length;
    const eligible = all
      .filter((c) => c.githubStatus === "not-inspected" && c.domainScore >= MIN_DOMAIN_SCORE && (c.githubProfile || c.githubRepos.length))
      .sort((a, b) => b.domainScore - a.domainScore);
    const room = Math.max(0, GITHUB_INSPECT_CAP - inspected);
    const pool = eligible.slice(0, room);
    for (const c of eligible.slice(room)) c.githubNote = `Beyond the top-${GITHUB_INSPECT_CAP} GitHub inspection cap.`;
    if (!pool.length) return;
    setPhase("github");
    let done = 0;
    let reused = 0;
    setGhProgress({ done, total: pool.length, reused });
    await runQueue<DomainCandidate, GithubInspectResult>({
      items: pool,
      concurrency: () => GITHUB_PARALLEL,
      stopped: () => abortRef.current,
      run: (c) => postGithub(c, cfg),
      // One more try for a passing failure (network); a rate limit / missing user is final.
      retryAfter: (gh, attempt) => (gh.retryable && attempt <= 1 ? NETWORK_RETRY_MS : null),
      onDone: (c, gh) => {
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
        c.githubEvidence = gh.evidence ?? [];
        c.githubMandatoryGaps = gh.mandatoryGaps ?? [];
        c.githubClaimedNotFound = gh.claimedNotFound ?? [];
        c.githubCheckedAt = gh.checkedAt ?? "";
        c.githubFromCache = Boolean(gh.fromCache);
        done += 1;
        if (gh.fromCache) reused += 1;
        setGhProgress({ done, total: pool.length, reused });
      },
      onActivity: (running, waiting) => setActivity({ running, waiting }),
    });
  };

  /** Rank every screened candidate and build the report (and the CSV outcomes). */
  const finish = async (cfg: RunConfig) => {
    setPhase("build");
    const built = await buildDomainReport(collectedRef.current, {
      domain: cfg.domainName,
      topN: cfg.topN,
      limitToTopN: cfg.limitToTopN,
      runName: cfg.runName,
      resumesScanned: processedRef.current.size,
      useDsa: cfg.fetchDsa,
      useGithub: cfg.rankGithub,
      showDomainCommit: cfg.trackDomainCommit,
      showStats: cfg.showStats,
      generateReport: cfg.generateReport,
      dsaGates: cfg.dsaGates,
      minCommits: cfg.minCommits,
      mandatoryActive: cfg.mandatory.trim().length > 0,
      requireExperience: cfg.requireExperience,
      checkPresentation: cfg.checkPresentation,
      minPresentation: cfg.minPresentation,
    });
    if (built.ok) setResult(built.data);
    else setError(built.error);
  };

  const run = async () => {
    setError(null);
    setRunning(true);
    setPhase("analyze");
    setResult(null);
    setSkipped([]);
    setSheetRows([]);
    setFailedRows([]);
    setShowAll(false);
    setGhProgress({ done: 0, total: 0, reused: 0 });
    setGithubLookedFor(null);
    abortRef.current = false;
    collectedRef.current = [];
    processedRef.current = new Set();
    failedRef.current = [];
    matchedRef.current = 0;
    retriesRef.current = 0;

    // A DSA gate needs the coding profiles; a min-commits gate needs GitHub —
    // so those gates force the relevant fetch on regardless of the toggles. The
    // latest-domain-commit lookup also needs GitHub inspection, but only shows a
    // date: it doesn't switch GitHub into the rank.
    const cfg = currentConfig();
    cfgRef.current = cfg;

    try {
      // 0. GitHub token check BEFORE any resume is scored: a rejected or exhausted
      //    token would otherwise score every candidate's GitHub as 0 (and a commits
      //    gate would then drop all of them) without a word.
      if (cfg.fetchGithub) {
        const gh = await checkGithubForDomain(cfg.scoringBrief, cfg.mandatory);
        if (!gh.ok) {
          setError(`GitHub inspection can't run: ${gh.error} Or turn off the GitHub options (and the commits gate) to shortlist without it.`);
          return;
        }
        setGithubLookedFor({ core: gh.data.core, languages: gh.data.languages });
      }

      // 1. Read the selected tabs into candidate rows.
      const rows: DomainCandidateRow[] = [];
      for (const sub of selected) {
        const res = await readSubsheet(url, sub.name);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        const c = sub.cols;
        res.data.rows.forEach((row, i) => {
          const resumeUrl = (row[c.resumeColumn] ?? "").trim();
          if (!/^https?:\/\//i.test(resumeUrl)) return;
          rows.push({
            id: (row[c.idColumn] ?? "").trim() || `${sub.name}-${i}`,
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
        return;
      }

      sheetRowsRef.current = rows;
      setSheetRows(rows);
      setProgress({ done: 0, total: rows.length, matched: 0 });

      // 2. Score every candidate for the domain — several in parallel.
      await screenRows(rows, cfg);
      // 3. Deep GitHub inspection of the domain-fit candidates — several in parallel.
      if (cfg.fetchGithub && !abortRef.current) await inspectGithub(cfg);
      // 4. Rank + build the report; return the top-N (or every candidate) for the CSV/preview.
      await finish(cfg);
    } finally {
      setRunning(false);
      setPhase("idle");
      setActivity({ running: 0, waiting: 0 });
    }
  };

  /**
   * Screen the rows that have no score yet — failed even after the automatic retries,
   * or never reached because of a Stop — with the run's own settings, then inspect any
   * new domain matches on GitHub and rebuild the report over the whole run.
   */
  const retryRemaining = async () => {
    const cfg = cfgRef.current;
    if (!cfg) return;
    const retryable = failedRef.current.filter((f) => f.kind === "error" && f.retryable).map((f) => f.row);
    const unreached = sheetRowsRef.current.filter((r) => !processedRef.current.has(r));
    const targets = [...retryable, ...unreached];
    if (!targets.length) return;
    setError(null);
    setRunning(true);
    setPhase("analyze");
    abortRef.current = false;
    failedRef.current = failedRef.current.filter((f) => !(f.kind === "error" && f.retryable));
    for (const r of retryable) processedRef.current.delete(r);
    setFailedRows([...failedRef.current]);
    setSkipped(failedRef.current.map((f) => `${f.row.name || f.row.id}: ${f.error}`));
    setProgress({ done: processedRef.current.size, total: sheetRowsRef.current.length, matched: matchedRef.current });
    try {
      await screenRows(targets, cfg);
      if (cfg.fetchGithub && !abortRef.current) await inspectGithub(cfg);
      await finish(cfg);
    } finally {
      setRunning(false);
      setPhase("idle");
      setActivity({ running: 0, waiting: 0 });
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
    const dsaOn = useDsa || dsaGatesActive(dsaGates);
    const ghOn = useGithub || minCommits > 0;
    // Any GitHub inspection ran (rank, commits gate, or the latest-commit lookup).
    const ghChecked = ghOn || trackDomainCommit;
    // A real measurement: inspected, or a profile that exists with nothing to show.
    const ghMeasured = (c: DomainCandidate) => c.githubStatus === "checked" || c.githubStatus === "no-repos";
    const headers = [
      "Rank", "Name", "Status", "Not Shortlisted Because", "Domain", "Domain Score",
      // DSA — the same columns as the DSA consolidation export, plus the DSA score.
      "DSA Score",
      ...DSA_PLATFORMS.flatMap(({ label }) => [`${label} Solved`, `${label} Contests Participated`, `${label} Rating`]),
      "Total Solved", "Total Contests", "Codeforces Max Rating", "CodeChef Highest Rating",
      ...DSA_PLATFORMS.map(({ label }) => `${label} URL`), "DSA Notes",
      "GitHub Check", "GitHub Fit Score", "GitHub Domain Repos", "GitHub Proven Tech", "GitHub Evidence",
      "Mandatory Not Proven on GitHub", "Claimed but Not Found on GitHub", "GitHub Top Repos", "GitHub Commits (2y)",
      "Last Domain Commit", "Last Domain Commit Repo", "Commit Email Linked To Profile",
      "GitHub AI-Commit Signal", "GitHub AI-Commit Detail", "GitHub Notes", "GitHub Checked At",
      "GitHub Profile", "Meets Mandatory", "Has Domain Experience", "Domain Experience",
      "Resume Presentation Score", "Resume Presentation Notes", "Core Skills",
      "Placed Company", "Package (LPA)", "Resume", "Assessment Report", "TR-1 Panelist",
      "TR-1 Panelist LinkedIn", "TR-1 Recording", "TR-2 Panelist", "TR-2 Panelist LinkedIn", "TR-2 Recording",
    ];
    // Which model judged each resume — for auditing a run; kept out of the client-facing shortlist.
    if (kind === "complete") headers.push("Scored By");
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
    // DSA cells: blank when DSA was off or (older runs) never read — blank is "unknown", not 0.
    const dsaCells = (c: DomainCandidate): Record<string, string> => {
      const d = c.dsa;
      if (!dsaOn || !d) return {};
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
      if (d.partial) notes.push("A linked profile couldn't be read in full");
      cells["DSA Notes"] = notes.join(" | ");
      return cells;
    };
    const rows: Record<string, string>[] = outcomes.map((c) => {
      const commit = c.githubLastDomainCommit;
      return {
        ...dsaCells(c),
        "Rank": c.rank ? String(c.rank) : "",
        "Name": c.name,
        "Status": c.shortlisted ? "Shortlisted" : "Not shortlisted",
        "Not Shortlisted Because": c.outcomeReason,
        "Domain": domain.trim(),
        "Domain Score": String(c.domainScore),
        "GitHub Check": ghChecked ? GITHUB_STATUS_LABEL[c.githubStatus] : "",
        // Numbers only where they were actually measured — blank is "unknown", not 0.
        "GitHub Fit Score": ghOn && ghMeasured(c) ? String(c.githubScore) : "",
        "GitHub Domain Repos": ghOn && ghMeasured(c) ? String(c.githubMatches) : "",
        "GitHub Proven Tech": ghChecked ? c.githubTechs.join(", ") : "",
        "GitHub Evidence": ghChecked && c.githubStatus === "checked" ? evidenceLines(c).join(" ; ") : "",
        "Mandatory Not Proven on GitHub": ghChecked && c.githubStatus === "checked" ? gapLines(c).join(" ; ") : "",
        "Claimed but Not Found on GitHub": ghChecked && c.githubStatus === "checked" ? (c.githubClaimedNotFound ?? []).join(", ") : "",
        "GitHub Top Repos": ghChecked ? c.githubTopRepos.map((r) => `${r.url} (${r.matchPct}%)`).join(" ; ") : "",
        "GitHub Commits (2y)": ghOn && ghMeasured(c) ? String(c.githubCommits2y) : "",
        "Last Domain Commit": trackDomainCommit && commit ? formatDay(commit.date, "iso") : "",
        "Last Domain Commit Repo": trackDomainCommit && commit ? commit.repoUrl : "",
        "Commit Email Linked To Profile": trackDomainCommit && commit ? (commit.linked ? "Yes" : "No") : "",
        "GitHub AI-Commit Signal": ghChecked && c.githubStatus === "checked" ? c.githubAiLikelihood : "",
        "GitHub AI-Commit Detail": ghChecked && c.githubStatus === "checked" ? c.githubAiSummary : "",
        "GitHub Notes": ghChecked ? c.githubNote : "",
        "GitHub Checked At":
          ghChecked && c.githubCheckedAt && c.githubStatus !== "failed"
            ? `${stamp(c.githubCheckedAt)}${c.githubFromCache ? " (reused, 24 h cache)" : ""}`
            : "",
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
        "Scored By": c.scoredBy ?? "",
      };
    });
    if (kind === "complete") {
      for (const { row, error, kind: k } of failedRows) {
        rows.push({ ...sheetCells(row), "Status": k === "invalid" ? "Not a resume" : "Could not be evaluated", "Not Shortlisted Because": error });
      }
      // Rows a Stop left unscanned (screening runs in parallel, so they can be anywhere in
      // the sheet) — listed so the sheet still accounts for every candidate.
      for (const row of unreached) {
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

  // Every row read from the sheet ends as scored, not a resume, could not be evaluated,
  // or (after a Stop) not reached — the completeness check below counts all four.
  const unreached = sheetRows.filter((r) => !processedRef.current.has(r));
  const notResumes = failedRows.filter((f) => f.kind === "invalid").length;
  const unevaluated = failedRows.filter((f) => f.kind === "error").length;
  // Of those, the ones a retry can fix (rate limit / overload / network) — not a file that isn't shared.
  const retryableCount = failedRows.filter((f) => f.kind === "error" && f.retryable).length;
  const scored = result ? result.candidates.length : 0;
  // Which providers judged the scored resumes, e.g. "Gemini 120 · OpenAI 30 · Mistral 2".
  const judgedBy = result
    ? Object.entries(
        result.candidates.reduce<Record<string, number>>((acc, c) => {
          const provider = c.scoredBy?.split("/")[0];
          if (provider) acc[provider] = (acc[provider] ?? 0) + 1;
          return acc;
        }, {}),
      )
        .map(([p, n]) => `${PROVIDER_LABEL[p] ?? p} ${n}`)
        .join(" · ")
    : "";
  const completeCount = result ? scored + failedRows.length + unreached.length : 0;
  const accountedFor = scored + notResumes + unevaluated + unreached.length === sheetRows.length;
  // With a top-N limit the preview shows the shortlist unless "show all" is on.
  const visible = result ? (result.limitedToTopN && !showAll ? result.candidates.filter((c) => c.shortlisted) : result.candidates) : [];
  const outcomeColumn = Boolean(result && (!result.limitedToTopN || showAll));

  // Display only: what the action bar says while idle, how many DSA minimums are set, and how
  // many rows ended without a score.
  const selectedRows = selected.reduce((n, s) => n + s.rowCount, 0);
  const idleStatus = !subs.some((s) => s.selected)
    ? "Turn on at least one tab to screen."
    : !selected.length
      ? "Map the name and resume columns of the selected tabs."
      : !domain.trim()
        ? "Enter the domain first."
        : `${selected.length} tab${selected.length === 1 ? "" : "s"} selected · ${selectedRows} rows`;
  const dsaGateCount = [dsaGates.minSolved, dsaGates.minContests, dsaGates.minScore, ...Object.values(dsaGates.minRating)].filter(
    (v) => v > 0,
  ).length;
  const notScored = notResumes + unevaluated + unreached.length;

  /** One sheet-column picker for a tab. Name and resume are required. */
  const columnSelect = (s: SubConfig, i: number, { key, label, required }: (typeof COL_FIELDS)[number]) => (
    <Field key={key} label={label} htmlFor={`dom-col-${i}-${key}`} error={required && !s.cols[key] ? "Required" : undefined}>
      <NativeSelect id={`dom-col-${i}-${key}`} value={s.cols[key]} onChange={(e) => setCol(s.name, key, e.target.value)} className="h-9 text-[13px]">
        <option value="">None</option>
        {s.headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );

  return (
    <div className="space-y-6">
      <div className="max-w-3xl space-y-6">
        {/* Source: the sheet, its tabs and the column mapping */}
        <Panel title="Candidate sheet" description="A Google Sheet of candidates whose interviews are done." icon={<FileSpreadsheet />}>
          <div className="space-y-4">
            <Field label="Report name" htmlFor="dom-run-name" optional hint="Defaults to the sheet's title.">
              <Input id="dom-run-name" value={runName} onChange={(e) => setRunName(e.target.value)} placeholder="e.g. GenAI shortlist — Batch 12" />
            </Field>
            <Field
              label="Google Sheet URL"
              htmlFor="dom-url"
              info="Each tab needs a candidate name and a resume link column. Assessment report, TR-1 / TR-2 panelist, LinkedIn and recording, placed company and package columns are optional and carried into the report."
            >
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input id="dom-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
                <Button onClick={fetchTabs} disabled={!url.trim() || fetching} variant={subs.length ? "outline" : "default"} className="shrink-0">
                  {fetching ? <Loader2 className="animate-spin" /> : <Table2 />}
                  {fetching ? "Reading…" : "Load tabs"}
                </Button>
              </div>
            </Field>
            {error && !subs.length ? <Notice tone="danger">{error}</Notice> : null}

            {subs.length ? (
              <div className="space-y-3 border-t pt-4">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <div className="flex items-center gap-1">
                    <h3 className="font-sans text-sm font-semibold tracking-normal">Tabs and columns</h3>
                    <InfoHint align="start">
                      Turn on the tabs to screen. Name and resume are required; map the optional columns your sheet has.
                      Columns are matched from the headers where possible, and anything unmapped is left blank in the
                      report.
                    </InfoHint>
                  </div>
                  <p className="text-[13px] text-muted-foreground">
                    Loaded <strong className="font-medium text-foreground">{sheetTitle}</strong> ·{" "}
                    <span className="tabular-nums">
                      {subs.length} tab{subs.length === 1 ? "" : "s"}
                    </span>
                  </p>
                </div>
                <SettingList>
                  {subs.map((s, i) => {
                    const optionalCols = COL_FIELDS.filter((f) => !f.required);
                    const mappedCols = optionalCols.filter((f) => s.cols[f.key]).length;
                    return (
                      <SettingRow
                        key={s.name}
                        id={`dom-tab-${i}`}
                        icon={<Table2 />}
                        title={s.name}
                        description={<span className="tabular-nums">{s.rowCount} rows</span>}
                        checked={s.selected}
                        onCheckedChange={(v) => update(s.name, { selected: v })}
                      >
                        <div className="space-y-3">
                          <div className="grid gap-3 sm:grid-cols-2">{COL_FIELDS.filter((f) => f.required).map((f) => columnSelect(s, i, f))}</div>
                          <details className="group">
                            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md text-[13px] font-medium text-primary hover:underline [&::-webkit-details-marker]:hidden">
                              Optional columns
                              <span className="font-normal tabular-nums text-muted-foreground">
                                · {mappedCols} of {optionalCols.length} mapped
                              </span>
                              <ChevronDown className="h-4 w-4 transition-transform duration-150 group-open:rotate-180" />
                            </summary>
                            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{optionalCols.map((f) => columnSelect(s, i, f))}</div>
                          </details>
                        </div>
                      </SettingRow>
                    );
                  })}
                </SettingList>
              </div>
            ) : null}
          </div>
        </Panel>

        {subs.length ? (
          <>
            {/* Requirements: the domain */}
            <Panel title="Domain" description="What to shortlist for." icon={<Target />}>
              <div className="space-y-4">
                <Field label="Domain name" htmlFor="dom-name" hint="Shown as the report title.">
                  <Input id="dom-name" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="e.g. AI / ML" />
                </Field>
                <Field
                  label="What defines it"
                  htmlFor="dom-details"
                  optional
                  hint="Topics, tools and what makes a strong fit."
                  info={
                    <>
                      This only guides scoring: candidates are judged on real evidence (projects, experience and
                      internships, GitHub). Name the tools and frameworks here so GitHub inspection has something to look
                      for.
                    </>
                  }
                >
                  <Textarea
                    id="dom-details"
                    rows={3}
                    value={domainDetails}
                    onChange={(e) => setDomainDetails(e.target.value)}
                    placeholder="e.g. Supervised/unsupervised learning, deep learning (CNNs, Transformers), NLP, CV, model training & fine-tuning, PyTorch/TensorFlow, Hugging Face. Strong if trained real models with measurable results or interned on an AI/ML team."
                  />
                </Field>
                <Field
                  label="Mandatory skills"
                  htmlFor="dom-mandatory"
                  optional
                  hint="Each needs real evidence. A candidate missing one is not shortlisted."
                  info="A strict requirement, checked before ranking together with the ones under Strict requirements."
                >
                  <Input id="dom-mandatory" value={mandatory} onChange={(e) => setMandatory(e.target.value)} placeholder="e.g. React.js, Node.js, DSA" />
                </Field>
              </div>
            </Panel>

            {/* Shortlist size */}
            <Panel title="Shortlist size" icon={<ListOrdered />}>
              <SettingList>
                <SettingRow
                  id="dom-topn"
                  title="Limit to the top N"
                  description="When off, everyone who clears every requirement is shortlisted."
                  info={
                    <>
                      On: only the best N candidates go into the report and the shortlist CSV. Off: everyone who clears the
                      domain-fit bar and the strict requirements is shortlisted, and the table and CSV list every scanned
                      candidate with their scores and, for those not shortlisted, the reason.
                    </>
                  }
                  checked={limitToTopN}
                  onCheckedChange={setLimitToTopN}
                >
                  <Segmented
                    ariaLabel="Shortlist size"
                    value={topN}
                    onChange={(n) => setTopN(n)}
                    options={TOP_N_CHOICES.map((n) => ({ value: n, label: `Top ${n}` }))}
                  />
                </SettingRow>
              </SettingList>
            </Panel>

            {/* Strict requirements: hard gates, checked before ranking */}
            <Panel
              title={
                <span className="inline-flex items-center gap-1">
                  Strict requirements
                  <InfoHint align="start" className="font-sans tracking-normal">
                    Hard gates, checked first, before ranking. A DSA minimum reads the LeetCode, Codeforces and CodeChef
                    profiles automatically, and a commits minimum runs GitHub inspection, so those numbers appear in the
                    report and CSV. Candidates whose links aren&apos;t found count as 0 and are excluded; a profile or
                    GitHub check that fails says so in the reason instead of passing silently as 0.
                  </InfoHint>
                </span>
              }
              description="Only candidates who clear every requirement here are shortlisted."
              icon={<ShieldCheck />}
            >
              <SettingList>
                <SettingRow
                  id="dom-exp"
                  icon={<Briefcase />}
                  title="Require domain internship or experience"
                  description="A real internship or job in this domain. Projects and courses don't count."
                  info="Strictly requires a real internship or job with work matching this domain and the mandatory skills. The matched experience shows in the report and CSV."
                  checked={requireExperience}
                  onCheckedChange={setRequireExperience}
                />
                <SettingRow
                  id="dom-presentation"
                  icon={<LayoutTemplate />}
                  title="Require a well-presented resume"
                  description="Grades the resume document's layout and polish, separately from skills."
                  info={
                    <>
                      Checks standard sections in the right order, aligned dates and margins, one consistent bullet, date
                      and heading style, a scannable hierarchy, a clean single-column ATS-safe layout and no typos, plus
                      how good it looks at a glance. Judged separately from skills, so a messy resume can&apos;t ride on a
                      strong profile. The score, its one-line reason and a colour-coded badge appear in the report and CSV,
                      and polish breaks ties in the final rank.
                    </>
                  }
                  checked={checkPresentation}
                  onCheckedChange={setCheckPresentation}
                >
                  <Field
                    label="Minimum presentation score"
                    htmlFor="dom-min-pres"
                    hint="0 grades and ranks only, and excludes nobody."
                    info="85+ recruiter-ready · 70–84 solid and professional · 50–69 visibly rough · below 50 messy. Layout is read from the resume PDF itself; a text-only resume is graded on structure alone."
                    className="sm:max-w-xs"
                  >
                    <Input
                      id="dom-min-pres"
                      type="number"
                      min={0}
                      max={100}
                      value={minPresentation || ""}
                      onChange={(e) => setMinPresentation(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                      placeholder={`e.g. ${DEFAULT_MIN_PRESENTATION}`}
                      className="tabular-nums"
                    />
                  </Field>
                </SettingRow>

                {/* A number gate, laid out like a SettingRow with an input in place of the switch. */}
                <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">
                      <GitCommitHorizontal />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1">
                        <label htmlFor="dom-min-commits" className="text-sm font-medium leading-5">
                          Minimum GitHub commits
                        </label>
                        <InfoHint align="start">
                          Commits in the last 2 years. Setting a minimum runs GitHub inspection automatically, even when
                          deep GitHub inspection is off.
                        </InfoHint>
                      </div>
                      <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">Last 2 years. 0 means no gate.</p>
                    </div>
                  </div>
                  <Input
                    id="dom-min-commits"
                    type="number"
                    min={0}
                    value={minCommits || ""}
                    onChange={(e) => setMinCommits(Math.max(0, Number(e.target.value) || 0))}
                    placeholder="e.g. 100"
                    className="h-9 w-28 shrink-0 tabular-nums"
                  />
                </div>

                {/* DSA minimums: collapsed, but kept in the page so the inputs always exist. */}
                <details className="group py-3 first:pt-0 last:pb-0">
                  <summary className="flex cursor-pointer list-none items-start justify-between gap-4 rounded-md [&::-webkit-details-marker]:hidden">
                    <span className="flex min-w-0 items-start gap-2.5">
                      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">
                        <Trophy />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium leading-5">DSA minimums</span>
                        <span className="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground">
                          LeetCode, Codeforces and CodeChef. 0 means no gate.
                        </span>
                      </span>
                    </span>
                    <span className="mt-0.5 flex shrink-0 items-center gap-1.5 text-[13px] tabular-nums text-muted-foreground">
                      {dsaGateCount ? `${dsaGateCount} set` : "None set"}
                      <ChevronDown className="h-4 w-4 transition-transform duration-150 group-open:rotate-180" />
                    </span>
                  </summary>
                  <div className="mt-3 space-y-3 sm:pl-[26px]">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      <Field label="Total problems solved" htmlFor="dom-min-solved">
                        <Input
                          id="dom-min-solved"
                          type="number"
                          min={0}
                          value={dsaGates.minSolved || ""}
                          onChange={(e) => setDsaGate("minSolved", e.target.value)}
                          placeholder="e.g. 300"
                          className="tabular-nums"
                        />
                      </Field>
                      <Field label="Total rated contests" htmlFor="dom-min-contests">
                        <Input
                          id="dom-min-contests"
                          type="number"
                          min={0}
                          value={dsaGates.minContests || ""}
                          onChange={(e) => setDsaGate("minContests", e.target.value)}
                          placeholder="e.g. 10"
                          className="tabular-nums"
                        />
                      </Field>
                      <Field label="DSA score (0–100)" htmlFor="dom-min-dsa">
                        <Input
                          id="dom-min-dsa"
                          type="number"
                          min={0}
                          max={100}
                          value={dsaGates.minScore || ""}
                          onChange={(e) => setDsaGate("minScore", e.target.value)}
                          placeholder="e.g. 50"
                          className="tabular-nums"
                        />
                      </Field>
                      {(
                        [
                          { key: "codeforces", label: "Codeforces rating", hint: "e.g. 1400" },
                          { key: "codechef", label: "CodeChef rating", hint: "e.g. 1600" },
                          { key: "leetcode", label: "LeetCode contest rating", hint: "e.g. 1700" },
                        ] as { key: DsaPlatform; label: string; hint: string }[]
                      ).map(({ key, label, hint }) => (
                        <Field key={key} label={label} htmlFor={`dom-min-rating-${key}`}>
                          <Input
                            id={`dom-min-rating-${key}`}
                            type="number"
                            min={0}
                            value={dsaGates.minRating[key] || ""}
                            onChange={(e) => setRatingGate(key, e.target.value)}
                            placeholder={hint}
                            className="tabular-nums"
                          />
                        </Field>
                      ))}
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Ratings use the highest rating reached. With more than one rating bar set, a candidate passes if any
                      of those platforms reaches its bar (e.g. Codeforces 1400 or CodeChef 1600).
                    </p>
                  </div>
                </details>
              </SettingList>
            </Panel>

            {/* Evidence sources beyond the resume */}
            <Panel title="Evidence sources" description="What to read beyond the resume." icon={<ScanSearch />}>
              <SettingList>
                <SettingRow
                  id="dom-github"
                  icon={<Github />}
                  title="Deep GitHub inspection"
                  description="Reads the code in domain-fit candidates' public repos. Adds up to +20 to the rank."
                  info={
                    <>
                      After the resume pass, each domain-fit candidate&apos;s public repos are opened and read: dependency
                      files, imports and calls in the code, Docker, CI and Terraform config, and tests. That shows which of
                      the domain&apos;s technologies they actually use, not what the repo is named. The result is a 0–100
                      GitHub score, the proven tech with the line that proves it, mandatory tech the code doesn&apos;t
                      show, resume claims the code doesn&apos;t prove, and an AI-commit signal for the CSV. Plain languages
                      alone don&apos;t count as domain proof when the domain names frameworks. Uses your GITHUB_TOKEN
                      (checked before the run); about 5 s per candidate.
                    </>
                  }
                  checked={useGithub}
                  onCheckedChange={setUseGithub}
                />
                <SettingRow
                  id="dom-gh-refresh"
                  icon={<RefreshCw />}
                  title="Re-inspect GitHub now"
                  description="When off, inspections from the last 24 hours are reused."
                  info={
                    <>
                      Off (default): a candidate whose GitHub was fully inspected for the same technologies in the last 24
                      hours is reused, which is instant and uses no GitHub quota. The CSV&apos;s &ldquo;GitHub Checked
                      At&rdquo; column says when each one ran. On: inspect everyone afresh, for example after candidates
                      pushed new code.
                    </>
                  }
                  checked={githubRefresh}
                  onCheckedChange={setGithubRefresh}
                  disabled={!(ghShown || trackDomainCommit)}
                />
                <SettingRow
                  id="dom-last-commit"
                  icon={<CalendarClock />}
                  title="Latest domain commit date"
                  description="When each candidate last committed domain code. Doesn't change the rank."
                  info={
                    <>
                      Shows when each domain-fit candidate last committed to one of their own GitHub repos whose code
                      proves this domain, in the table, report and CSV. It runs GitHub inspection even when deep
                      inspection is off, and uses your GITHUB_TOKEN.
                    </>
                  }
                  checked={trackDomainCommit}
                  onCheckedChange={setTrackDomainCommit}
                />
                <SettingRow
                  id="dom-dsa"
                  icon={<Trophy />}
                  title="Also weigh DSA"
                  description="LeetCode, Codeforces and CodeChef. Adds up to +15 to the rank; slower."
                  info={
                    <>
                      Reads each resume&apos;s LeetCode, Codeforces and CodeChef profiles the same way as DSA consolidation
                      (problems solved, rated contests and rating) into a 0–100 DSA score that lifts the rank by up to +15
                      (Codeforces &gt; CodeChef &gt; LeetCode). Set DSA minimums under Strict requirements to screen on
                      them.
                    </>
                  }
                  checked={useDsa}
                  onCheckedChange={setUseDsa}
                />
              </SettingList>
            </Panel>

            {/* Report */}
            <Panel title="Report" icon={<FileText />}>
              <SettingList>
                <SettingRow
                  id="dom-report"
                  icon={<FileText />}
                  title="Generate PDF report"
                  description="A ranked shortlist PDF on Drive, alongside the CSVs."
                  info="Off: skip the report. The results table and both CSV downloads work the same, and the run finishes faster."
                  checked={generateReport}
                  onCheckedChange={setGenerateReport}
                />
                <SettingRow
                  id="dom-stats"
                  icon={<BarChart3 />}
                  title="Show scan summary in the report"
                  description="The scanned, domain matches and shortlisted counts at the top."
                  info="Turn it off for a cleaner, shortlist-only document."
                  checked={showStats}
                  onCheckedChange={setShowStats}
                  disabled={!generateReport}
                />
              </SettingList>
            </Panel>

            {/* Advanced: rarely changed. A native <details> keeps the control in the page while closed. */}
            <details className="group rounded-xl border bg-card shadow-surface">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-5 py-3.5 transition-colors hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
                <span className="font-display text-[15px] font-semibold tracking-[-0.01em]">Advanced options</span>
                <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <span className="hidden tabular-nums sm:inline sm:group-open:hidden">{concurrency} in parallel</span>
                  <ChevronDown className="h-4 w-4 transition-transform duration-150 group-open:rotate-180" />
                </span>
              </summary>
              <div className="border-t px-5 py-4">
                <Field
                  label="Resumes screened in parallel"
                  htmlFor="dom-parallel"
                  hint="More is faster but reaches rate limits sooner."
                  info="Each resume is one model call: Gemini first, OpenAI when Gemini is rate-limited, Mistral when OpenAI is too. Anything still failing is retried."
                >
                  <NativeSelect
                    id="dom-parallel"
                    aria-label="Resumes screened in parallel"
                    value={concurrency}
                    disabled={running}
                    onChange={(e) => setConcurrency(Number(e.target.value))}
                    wrapperClassName="sm:max-w-[260px]"
                  >
                    {CONCURRENCY_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n} in parallel{n === DEFAULT_CONCURRENCY ? " (recommended)" : ""}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
            </details>

            {error ? <Notice tone="danger">{error}</Notice> : null}

            <ActionBar
              status={
                running ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="font-medium text-foreground">
                        {phase === "github"
                          ? "Inspecting GitHub"
                          : phase === "build"
                            ? generateReport
                              ? "Building report…"
                              : "Ranking candidates…"
                            : "Scanning resumes"}
                      </span>
                      {phase === "github" ? (
                        <span className="tabular-nums">
                          {ghProgress.done} of {ghProgress.total}
                          {ghProgress.reused ? ` · ${ghProgress.reused} reused` : ""} · {activity.running} running
                        </span>
                      ) : phase === "build" ? null : (
                        <span className="tabular-nums">
                          {progress.done} of {progress.total} · {progress.matched} domain match{progress.matched === 1 ? "" : "es"} so far ·{" "}
                          {activity.running} running
                          {activity.waiting ? ` · ${activity.waiting} waiting to retry (rate limit)` : ""}
                        </span>
                      )}
                    </div>
                    <Progress
                      label="Screening progress"
                      value={phase === "build" ? undefined : phase === "github" ? ghProgress.done : progress.done}
                      max={phase === "github" ? ghProgress.total : progress.total}
                    />
                  </div>
                ) : (
                  idleStatus
                )
              }
            >
              {running ? (
                <Button variant="outline" onClick={() => (abortRef.current = true)}>
                  <Square /> Stop
                </Button>
              ) : null}
              <Button
                size="lg"
                onClick={run}
                disabled={!canRun}
                className="h-auto min-h-11 whitespace-normal py-2 text-left sm:whitespace-nowrap"
              >
                {running ? <Loader2 className="animate-spin" /> : <Play />}
                {limitToTopN ? `Shortlist top ${topN} for the domain` : "Shortlist all candidates for the domain"}
              </Button>
            </ActionBar>
          </>
        ) : null}
      </div>

      {/* Results: numbers first, then the table with its downloads */}
      {subs.length && result ? (
        <div className="space-y-4">
          <StatGrid cols={4}>
            <Stat label="Candidates read" value={sheetRows.length} hint={`${scored} scored`} icon={<Users />} />
            <Stat label="Domain matches" value={result.considered} hint="Cleared the domain-fit bar" icon={<Target />} />
            <Stat
              label="Shortlisted"
              value={result.shortlisted}
              tone="highlight"
              hint={`Of ${result.considered} domain match${result.considered === 1 ? "" : "es"}`}
              icon={<CheckCircle2 />}
            />
            <Stat
              label="Not scored"
              value={notScored}
              tone={unevaluated || unreached.length ? "warning" : "default"}
              hint={notScored ? "Not a resume, or couldn't be evaluated" : "Every resume was scored"}
              icon={<FileX />}
            />
          </StatGrid>

          {result.excluded.mandatory + result.excluded.leetcode + (result.excluded.dsa ?? 0) + result.excluded.commits + result.excluded.experience + result.excluded.presentation > 0 ? (
            <p className="text-[13px] text-muted-foreground">
              Strict gates removed{" "}
              {[
                result.excluded.mandatory ? `${result.excluded.mandatory} missing a mandatory skill` : "",
                result.excluded.experience ? `${result.excluded.experience} without domain experience` : "",
                result.excluded.leetcode ? `${result.excluded.leetcode} below the LeetCode minimum` : "",
                result.excluded.dsa ? `${result.excluded.dsa} below a DSA minimum` : "",
                result.excluded.commits ? `${result.excluded.commits} below the GitHub-commits minimum` : "",
                result.excluded.presentation ? `${result.excluded.presentation} with a poorly presented resume` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
              .
            </p>
          ) : null}

          {/* Completeness: every row read from the sheet ends somewhere; retry what a retry can fix. */}
          <Notice
            tone={accountedFor && !unevaluated && !unreached.length ? "success" : "warning"}
            action={
              retryableCount || unreached.length ? (
                <Button size="sm" variant="outline" disabled={running} onClick={() => void retryRemaining()}>
                  <RotateCcw /> Screen the {retryableCount + unreached.length} remaining
                </Button>
              ) : null
            }
          >
            <span className="font-medium">
              {accountedFor ? "Every row accounted for:" : "Check:"} {sheetRows.length} read from the sheet
            </span>
            <span>
              {" "}
              · {scored} scored{judgedBy ? ` (${judgedBy})` : ""}
            </span>
            {notResumes ? <span> · {notResumes} not a resume (photo / certificate / blank)</span> : null}
            {unevaluated ? (
              <span>
                {" "}
                · {unevaluated} could not be evaluated
                {unevaluated - retryableCount ? ` (${unevaluated - retryableCount} file not shared / unreadable — see the CSV)` : ""}
              </span>
            ) : null}
            {unreached.length ? <span> · {unreached.length} not reached (stopped)</span> : null}
          </Notice>

          {result.pdfError ? (
            <Notice tone="warning">
              The PDF report couldn&apos;t be generated ({result.pdfError}). The shortlist is complete, so use the CSV
              downloads. This is usually low memory: close other apps and re-run to also get the PDF.
            </Notice>
          ) : result.link && result.storage === "local" ? (
            <Notice tone="info">The PDF was saved locally (Drive storage quota unavailable) and is served by this app.</Notice>
          ) : null}
          {result.shortlisted === 0 ? (
            <Notice tone="warning">No candidate cleared every requirement. Try broadening the domain or relaxing the strict gates.</Notice>
          ) : null}

          {githubLookedFor ? <GithubRunSummary lookedFor={githubLookedFor} candidates={result.candidates} /> : null}

          <Panel
            flush
            title={result.limitedToTopN && !showAll ? "Shortlist" : "Every evaluated candidate"}
            description={
              <>
                Shortlisted {result.shortlisted} of {result.considered} domain match{result.considered === 1 ? "" : "es"} across{" "}
                {progress.total} candidate{progress.total === 1 ? "" : "s"}
              </>
            }
            actions={
              <>
                {result.reportSkipped ? <span className="text-xs text-muted-foreground">PDF report was off</span> : null}
                {result.link ? (
                  <a href={result.link} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
                    <ExternalLink /> Open PDF report
                  </a>
                ) : null}
                <Button size="sm" variant="outline" onClick={() => downloadCsv("complete")} disabled={completeCount === 0}>
                  <Download /> Complete screening CSV ({completeCount})
                </Button>
                <Button size="sm" variant="soft" onClick={() => downloadCsv("shortlisted")} disabled={result.shortlisted === 0}>
                  <Download /> Shortlisted CSV ({result.shortlisted})
                </Button>
              </>
            }
          >
            {result.limitedToTopN ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2.5">
                <label className="flex cursor-pointer items-center gap-2 text-[13px] text-muted-foreground">
                  <Switch checked={showAll} onCheckedChange={setShowAll} /> Show every evaluated candidate
                </label>
                <span className="text-xs tabular-nums text-muted-foreground">{visible.length} shown</span>
              </div>
            ) : null}

            {visible.length ? (
              <div className="border-t">
                <Table containerClassName="max-h-[560px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12 text-right">#</TableHead>
                      <TableHead>Name</TableHead>
                      {outcomeColumn ? <TableHead>Outcome</TableHead> : null}
                      <TableHead className="text-right">Fit</TableHead>
                      {dsaShown ? <TableHead>DSA</TableHead> : null}
                      {ghShown ? <TableHead>GitHub</TableHead> : null}
                      {ghShown ? <TableHead className="text-right">Commits</TableHead> : null}
                      {trackDomainCommit ? <TableHead>Last domain commit</TableHead> : null}
                      {requireExperience ? <TableHead>Experience</TableHead> : null}
                      {checkPresentation ? <TableHead className="text-right">Presentation</TableHead> : null}
                      <TableHead>Core skills</TableHead>
                      <TableHead>Placed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((c, i) => (
                      <TableRow key={`${c.id}-${i}`}>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{c.rank || "—"}</TableCell>
                        <TableCell className="font-medium">
                          <div className="max-w-[220px] truncate" title={c.name}>
                            {c.name || "—"}
                          </div>
                        </TableCell>
                        {!outcomeColumn ? null : (
                          <TableCell>
                            {c.shortlisted ? (
                              <Badge variant="highlight">Shortlisted</Badge>
                            ) : (
                              <div className="line-clamp-2 min-w-[200px] max-w-[360px] text-muted-foreground" title={c.outcomeReason}>
                                {c.outcomeReason}
                              </div>
                            )}
                          </TableCell>
                        )}
                        <TableCell className="text-right tabular-nums">{c.domainScore}</TableCell>
                        {dsaShown ? (
                          <TableCell title={dsaTooltip(c)}>
                            {c.dsa && (c.dsa.score > 0 || (c.dsa.totalSolved ?? 0) > 0) ? (
                              <span className="whitespace-nowrap tabular-nums">
                                <span
                                  className={cn(
                                    "font-medium",
                                    c.dsa.score >= 70 ? "text-success" : c.dsa.score >= 40 ? "text-primary" : "text-muted-foreground",
                                  )}
                                >
                                  {c.dsa.score}
                                </span>
                                <span className="text-muted-foreground"> · {c.dsa.totalSolved ?? 0} solved</span>
                                {ratingsLine(c.dsa) ? <span className="block text-xs text-muted-foreground">{ratingsLine(c.dsa)}</span> : null}
                              </span>
                            ) : (
                              <span className="whitespace-nowrap text-muted-foreground">{c.dsa ? "No DSA profile" : "—"}</span>
                            )}
                          </TableCell>
                        ) : null}
                        {ghShown ? (
                          <TableCell title={githubTooltip(c)}>
                            {c.githubStatus === "checked" ? (
                              <span className="whitespace-nowrap tabular-nums">
                                <span
                                  className={cn(
                                    "font-medium",
                                    c.githubScore >= 70 ? "text-success" : c.githubScore >= 40 ? "text-primary" : "text-muted-foreground",
                                  )}
                                >
                                  {c.githubScore}
                                </span>
                                <span className="text-muted-foreground">
                                  {" "}
                                  · {c.githubMatches} repo{c.githubMatches === 1 ? "" : "s"}
                                </span>
                              </span>
                            ) : (
                              <span
                                className={cn(
                                  "whitespace-nowrap",
                                  c.githubStatus === "failed" || c.githubStatus === "not-found" ? "text-warning" : "text-muted-foreground",
                                )}
                              >
                                {GITHUB_STATUS_SHORT[c.githubStatus]}
                              </span>
                            )}
                          </TableCell>
                        ) : null}
                        {ghShown ? (
                          <TableCell className="text-right tabular-nums">{c.githubStatus === "checked" ? c.githubCommits2y : "—"}</TableCell>
                        ) : null}
                        {trackDomainCommit ? (
                          <TableCell className="whitespace-nowrap">
                            {c.githubLastDomainCommit ? (
                              <a
                                href={c.githubLastDomainCommit.repoUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="tabular-nums text-primary hover:underline"
                                title={`${c.githubLastDomainCommit.repo}${
                                  c.githubLastDomainCommit.linked ? "" : " · commit email isn't linked to their GitHub profile"
                                }`}
                              >
                                {formatDay(c.githubLastDomainCommit.date)}
                              </a>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        ) : null}
                        {requireExperience ? (
                          <TableCell>
                            <Badge variant={c.hasDomainExperience ? "success" : "secondary"}>{c.hasDomainExperience ? "Yes" : "No"}</Badge>
                          </TableCell>
                        ) : null}
                        {checkPresentation ? (
                          <TableCell
                            className={cn(
                              "text-right font-medium tabular-nums",
                              c.presentationScore >= 85 ? "text-success" : c.presentationScore >= 70 ? "text-primary" : "text-warning",
                            )}
                            title={c.presentationNotes}
                          >
                            {c.presentationScore || "—"}
                          </TableCell>
                        ) : null}
                        <TableCell>
                          <div className="max-w-[280px] truncate" title={c.coreSkills.join(", ")}>
                            {c.coreSkills.join(", ") || "—"}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          <div
                            className="max-w-[200px] truncate"
                            title={c.placedCompany ? `${c.placedCompany}${c.ctc ? ` · ${c.ctc}` : ""}` : undefined}
                          >
                            {c.placedCompany ? `${c.placedCompany}${c.ctc ? ` · ${c.ctc}` : ""}` : "—"}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="border-t p-4">
                <EmptyState
                  icon={<ListOrdered />}
                  title={result.limitedToTopN && !showAll ? "No candidate shortlisted" : "No candidates to show"}
                  description={
                    result.limitedToTopN && !showAll
                      ? "Turn on “Show every evaluated candidate” to see why each one was left out."
                      : "No resume could be scored in this run. The complete screening CSV lists every row and its status."
                  }
                />
              </div>
            )}
          </Panel>
        </div>
      ) : null}

      {subs.length && skipped.length ? (
        <details className="group rounded-xl border bg-card px-4 py-3 text-[13px] shadow-surface">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-medium [&::-webkit-details-marker]:hidden">
            <span className="tabular-nums">
              {skipped.length} candidate{skipped.length === 1 ? "" : "s"} skipped
            </span>
            <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-150 group-open:rotate-180" />
          </summary>
          <ul className="mt-2 space-y-1 pl-4 text-muted-foreground">
            {skipped.slice(0, 15).map((s) => (
              <li key={s} className="list-disc break-words">
                {s}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
