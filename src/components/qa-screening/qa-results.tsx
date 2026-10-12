"use client";

import * as React from "react";
import {
  ArrowLeft,
  Award,
  Ban,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileWarning,
  FilePlus2,
  Loader2,
  Play,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  TriangleAlert,
  Users,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatTile } from "@/components/charts";
import { QaPaste } from "@/components/qa-screening/qa-paste";
import { buildQaCsv } from "@/lib/qa-csv";
import { SECTION_POINTS, rankCandidates, summarize, type QaRanked, type QaStatus } from "@/lib/qa-scoring";
import {
  GOOD_TO_HAVE,
  MANDATORY,
  QA_CHECKS_VERSION,
  QA_SECTIONS,
  SECTION_LABEL,
  type QaBatch,
  type QaCandidateInput,
  type QaEvaluation,
  type QaRules,
  type QaSection,
} from "@/lib/qa-types";
import { cn, slugify } from "@/lib/utils";

export const CONCURRENCY_OPTIONS = [4, 6, 8, 10, 12, 16];

interface QaResultsProps {
  title: string;
  candidates: QaCandidateInput[];
  results: Record<string, QaEvaluation>;
  rules: QaRules;
  onRulesChange: (rules: QaRules) => void;
  batches: QaBatch[];
  running: boolean;
  /** Resumes being read right now / waiting to retry after a rate limit. */
  active: number;
  retrying: number;
  concurrency: number;
  onConcurrencyChange: (n: number) => void;
  onRun: (targets: QaCandidateInput[]) => void;
  onStop: () => void;
  onBack: () => void;
  onAddBatch: (candidates: QaCandidateInput[]) => void;
  storageError: string;
}

const STATUS_STYLE: Record<QaStatus, string> = {
  Shortlisted: "bg-emerald-100 text-emerald-800",
  "Qualified – Outside Top N": "bg-sky-100 text-sky-800",
  "Borderline – Review": "bg-amber-100 text-amber-800",
  "Unverified – Re-screen": "bg-orange-100 text-orange-800",
  "Not Shortlisted": "bg-slate-100 text-slate-700",
  "Not QA – No Testing Terms": "bg-zinc-100 text-zinc-500",
  "Invalid – Not a Resume": "bg-rose-100 text-rose-800",
  Error: "bg-red-100 text-red-700",
  Pending: "bg-muted text-muted-foreground",
};

const SECTION_COLOR: Record<QaSection, string> = {
  skills: "bg-sky-400",
  projects: "bg-violet-500",
  experience: "bg-emerald-500",
};

const SHORT: Record<string, string> = {
  qa: "QA",
  software_testing: "ST",
  manual_testing: "MT",
  automated_testing: "AT",
  selenium: "Sel",
};

type Filter = QaStatus | "all";

const PAGE = 50;

function download(name: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Five mandatory items × Skills / Projects / Experience, one square each. */
function Matrix({ r }: { r: QaEvaluation }) {
  return (
    <div className="flex gap-2">
      {MANDATORY.map((d) => {
        const q = r.mandatory[d.key];
        const tip = QA_SECTIONS.map((s) => `${SECTION_LABEL[s]}: ${q?.[s] ? `"${q[s]}"` : "—"}`).join("\n");
        return (
          <div key={d.key} className="flex flex-col items-center gap-0.5" title={`${d.label}\n${tip}`}>
            <span className="text-[10px] font-medium text-muted-foreground">{SHORT[d.key]}</span>
            <div className="flex gap-0.5">
              {QA_SECTIONS.map((s) => (
                <span key={s} className={cn("h-2.5 w-2.5 rounded-sm", q?.[s] ? SECTION_COLOR[s] : "bg-muted")} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Details({ row }: { row: QaRanked }) {
  const r = row.result;
  if (!r) return null;
  if (r.status === "error") return <p className="text-sm text-destructive">{r.error}</p>;
  const gth = GOOD_TO_HAVE.filter((d) => r.goodToHave[d.key]);
  return (
    <div className="grid gap-4 text-xs lg:grid-cols-2">
      <div className="space-y-2">
        <p className="font-semibold">Mandatory evidence (exact resume words)</p>
        <table className="w-full border text-left">
          <thead className="bg-muted/60">
            <tr>
              <th className="px-2 py-1">Item</th>
              {QA_SECTIONS.map((s) => (
                <th key={s} className="px-2 py-1">
                  {SECTION_LABEL[s]} <span className="font-normal text-muted-foreground">({SECTION_POINTS[s]})</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MANDATORY.map((d) => (
              <tr key={d.key} className="border-t align-top">
                <td className="whitespace-nowrap px-2 py-1 font-medium">{d.label}</td>
                {QA_SECTIONS.map((s) => (
                  <td key={s} className="px-2 py-1">
                    {r.mandatory[d.key]?.[s] ? (
                      <span className="text-foreground">&ldquo;{r.mandatory[d.key][s]}&rdquo;</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {row.score?.sectionGaps.length ? (
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">Section gaps:</span> {row.score.sectionGaps.join(" · ")}
          </p>
        ) : null}
        {r.remarks ? (
          <p>
            <span className="font-medium">Remarks:</span> {r.remarks}
          </p>
        ) : null}
      </div>
      <div className="space-y-2">
        <p className="font-semibold">Good-to-have ({gth.length})</p>
        <div className="flex flex-wrap gap-1">
          {gth.length ? (
            gth.map((d) => {
              const q = r.goodToHave[d.key];
              const secs = QA_SECTIONS.filter((s) => q[s]);
              return (
                <span
                  key={d.key}
                  title={secs.map((s) => `${SECTION_LABEL[s]}: "${q[s]}"`).join("\n")}
                  className={cn(
                    "rounded px-1.5 py-0.5",
                    secs.some((s) => s !== "skills") ? "bg-violet-100 text-violet-800" : "bg-sky-50 text-sky-800",
                  )}
                >
                  {d.label}
                </span>
              );
            })
          ) : (
            <span className="text-muted-foreground">None found.</span>
          )}
        </div>
        {r.qaProjects.length ? (
          <div>
            <p className="font-semibold">QA / testing projects</p>
            <ul className="list-disc space-y-0.5 pl-4">
              {r.qaProjects.map((p, i) => (
                <li key={i}>
                  <span className="font-medium">{p.title}</span>
                  {p.work ? ` — ${p.work}` : ""}
                  {p.tools.length ? <span className="text-muted-foreground"> [{p.tools.join(", ")}]</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {r.qaExperience.length ? (
          <div>
            <p className="font-semibold">QA / testing internships &amp; jobs</p>
            <ul className="list-disc space-y-0.5 pl-4">
              {r.qaExperience.map((j, i) => (
                <li key={i}>
                  <span className="font-medium">{[j.role, j.company].filter(Boolean).join(" @ ")}</span>
                  {j.duration ? ` (${j.duration})` : ""}
                  {j.work ? ` — ${j.work}` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {r.certifications.length ? (
          <p>
            <span className="font-semibold">Certifications:</span> {r.certifications.join(", ")}
          </p>
        ) : null}
        {r.checks.length ? (
          <div>
            <p className="font-semibold">Verification notes</p>
            <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
              {r.checks.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="text-muted-foreground">
          {r.model ? `Read by ${r.model}` : "No model needed"} · {r.source || "—"} ·{" "}
          {r.evidenceVerified ? "quotes checked against the resume text" : "scanned resume — quotes not text-verified"} ·{" "}
          {(r.durationMs / 1000).toFixed(1)}s
        </p>
      </div>
    </div>
  );
}

export function RulesCard({ rules, onChange, disabled }: { rules: QaRules; onChange: (r: QaRules) => void; disabled?: boolean }) {
  const set = (patch: Partial<QaRules>) => onChange({ ...rules, ...patch });
  const num = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <SlidersHorizontal className="h-4 w-4" /> Shortlist rules
        </CardTitle>
        <CardDescription>
          Changing a rule re-ranks instantly — no resume is read again. Score: each mandatory item is worth 20 —{" "}
          Skills {SECTION_POINTS.skills}, Projects {SECTION_POINTS.projects}, Experience {SECTION_POINTS.experience}. 100% only
          when all five are in all three sections (otherwise capped at 99%). Good-to-have adds +2 per item shown in a
          project / job, +1 if only in the skills list, +2 for a QA / automation project or internship.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="qa-min">Minimum final score (%)</Label>
          <Input
            id="qa-min"
            type="number"
            min={0}
            max={200}
            value={rules.minScore}
            disabled={disabled}
            onChange={(e) => set({ minScore: num(e.target.value, 0, 200) })}
          />
          <p className="text-xs text-muted-foreground">60 ≈ every mandatory item in Skills + a testing project.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="qa-top">Keep only the top N (0 = no cap)</Label>
          <Input
            id="qa-top"
            type="number"
            min={0}
            value={rules.topN}
            disabled={disabled}
            onChange={(e) => set({ topN: num(e.target.value, 0, 100_000) })}
          />
        </div>
        <div className="space-y-3">
          {(
            [
              ["requireAllMandatory", "All 5 mandatory present", "QA, Software Testing, Manual, Automated, Selenium — each in at least one section."],
              ["requireHandsOn", "Hands-on QA required", "A testing project or a QA / testing internship — not just a skills list."],
              ["requireQaExperience", "QA internship / job required", "Only candidates with QA / testing work experience."],
            ] as const
          ).map(([key, label, hint]) => (
            <div key={key} className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
              <Switch checked={rules[key]} disabled={disabled} onCheckedChange={(v) => set({ [key]: v } as Partial<QaRules>)} />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function QaResults({
  title,
  candidates,
  results,
  rules,
  onRulesChange,
  batches,
  running,
  active,
  retrying,
  concurrency,
  onConcurrencyChange,
  onRun,
  onStop,
  onBack,
  onAddBatch,
  storageError,
}: QaResultsProps) {
  const ranking = React.useMemo(() => rankCandidates(candidates, results, rules), [candidates, results, rules]);
  const sum = React.useMemo(() => summarize(ranking), [ranking]);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(0);
  const [open, setOpen] = React.useState<string | null>(null);
  const [scope, setScope] = React.useState<"all" | number>("all");
  const [newRows, setNewRows] = React.useState<QaCandidateInput[]>([]);
  const [pasteKey, setPasteKey] = React.useState(0);

  const pending = candidates.filter((c) => !results[c.id]);
  const failed = candidates.filter((c) => results[c.id]?.status === "error");
  // Screened before the latest evidence checks (or never verified) — offered for a re-screen.
  const stale = candidates.filter((c) => {
    const r = results[c.id];
    if (!r || r.status === "error") return false;
    return (r.checksVersion ?? 1) < QA_CHECKS_VERSION || (r.status === "ok" && !r.evidenceVerified);
  });
  // Image / scanned results never checked against any text — the ones that may hold invented evidence.
  const unverified = stale.filter((c) => results[c.id]?.status === "ok" && !results[c.id]?.evidenceVerified);
  const done = candidates.length - pending.length;
  const pct = candidates.length ? Math.round((done / candidates.length) * 100) : 0;

  const avgSecs = React.useMemo(() => {
    const t = Object.values(results)
      .map((r) => r.durationMs)
      .filter((ms) => ms > 0);
    return t.length ? t.reduce((a, b) => a + b, 0) / t.length / 1000 : 0;
  }, [results]);
  const eta =
    running && pending.length && avgSecs
      ? ` · about ${Math.max(1, Math.ceil((avgSecs * pending.length) / Math.max(1, concurrency) / 60))} min left`
      : "";

  const existing = React.useMemo(() => new Map(candidates.map((c) => [c.id, c.batch])), [candidates]);
  const nextBatch = (batches.length ? batches[batches.length - 1].n : 0) + 1;

  const inScope = (r: QaRanked) => scope === "all" || r.candidate.batch === scope;
  const scoped = ranking.filter(inScope);
  const shortlisted = scoped.filter((r) => r.status === "Shortlisted");
  const suffix = scope === "all" ? "" : `-batch-${scope}`;

  const q = query.trim().toLowerCase();
  const visible = ranking.filter(
    (r) =>
      (filter === "all" || r.status === filter) &&
      (!q || r.candidate.mobile.includes(q) || (r.candidate.name || r.result?.name || "").toLowerCase().includes(q)),
  );
  const pages = Math.max(1, Math.ceil(visible.length / PAGE));
  const pageRows = visible.slice(page * PAGE, page * PAGE + PAGE);
  React.useEffect(() => setPage(0), [filter, query]);

  const tabs: [Filter, string, number][] = [
    ["all", "All", candidates.length],
    ["Shortlisted", "Shortlisted", sum.shortlisted],
    ...(rules.topN > 0 ? ([["Qualified – Outside Top N", "Outside top N", sum.outsideTopN]] as [Filter, string, number][]) : []),
    ["Borderline – Review", "Borderline", sum.borderline],
    ["Not Shortlisted", "Not shortlisted", sum.notShortlisted],
    ...(sum.unverified ? ([["Unverified – Re-screen", "Unverified", sum.unverified]] as [Filter, string, number][]) : []),
    ["Not QA – No Testing Terms", "Not QA", sum.notQa],
    ["Invalid – Not a Resume", "Not a resume", sum.invalid],
    ["Error", "Errors", sum.errors],
    ["Pending", "Pending", sum.pending],
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" /> Dashboard
          </Button>
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" /> {title}
            </h2>
            <p className="text-sm text-muted-foreground">
              QA resume screening · {candidates.length} candidates in {batches.length} batch{batches.length === 1 ? "" : "es"}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={String(scope)}
            onChange={(e) => setScope(e.target.value === "all" ? "all" : Number(e.target.value))}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            aria-label="Download scope"
          >
            <option value="all">All batches</option>
            {batches.map((b) => (
              <option key={b.n} value={b.n}>
                Batch {b.n} ({b.count})
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            disabled={!done}
            onClick={() => download(`${slugify(title)}-complete-ranking${suffix}-${scoped.length}.csv`, buildQaCsv(scoped))}
          >
            <Download className="h-4 w-4" /> Complete ranking ({scoped.length})
          </Button>
          <Button
            disabled={!shortlisted.length}
            onClick={() => download(`${slugify(title)}-shortlisted${suffix}-${shortlisted.length}.csv`, buildQaCsv(shortlisted))}
          >
            <Download className="h-4 w-4" /> Shortlisted ({shortlisted.length})
          </Button>
        </div>
      </div>

      {storageError ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{storageError}</p>
      ) : null}

      {stale.length ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-orange-300 bg-orange-50 px-4 py-3 text-sm text-orange-900">
          <p className="max-w-3xl">
            <span className="font-semibold">{stale.length} result{stale.length === 1 ? " was" : "s were"} screened before the latest accuracy checks.</span>{" "}
            Those checks identify the uploaded file first (photos, ID cards and certificates are no longer read as resumes), verify
            image / scanned resumes against their transcription, and count one mention for one section only. Unverified results
            can&apos;t be shortlisted until re-screened.
          </p>
          <div className="flex flex-wrap gap-2">
            {unverified.length && unverified.length < stale.length ? (
              <Button variant="outline" disabled={running} onClick={() => onRun(unverified)}>
                <RotateCcw className="h-4 w-4" /> Re-screen {unverified.length} unverified first
              </Button>
            ) : null}
            <Button variant="outline" disabled={running} onClick={() => onRun(stale)}>
              <RotateCcw className="h-4 w-4" /> Re-screen {stale.length === unverified.length ? "" : "all "}
              {stale.length}
            </Button>
          </div>
        </div>
      ) : null}

      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex justify-between text-sm">
            <span className="inline-flex items-center gap-2 font-medium">
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {done} of {candidates.length} resumes screened{eta}
            </span>
            <span className="tabular-nums text-muted-foreground">{pct}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {running ? (
              <Button variant="outline" onClick={onStop}>
                <Square className="h-4 w-4" /> Stop (finish in-flight)
              </Button>
            ) : pending.length ? (
              <Button onClick={() => onRun(pending)}>
                <Play className="h-4 w-4" /> {done ? `Resume — ${pending.length} left` : `Screen ${pending.length} resumes`}
              </Button>
            ) : (
              <Badge variant="success" className="px-3 py-1.5 text-sm">
                All {candidates.length} resumes screened
              </Badge>
            )}
            {!running && failed.length ? (
              <Button variant="outline" onClick={() => onRun(failed)}>
                <RotateCcw className="h-4 w-4" /> Re-run {failed.length} failed
              </Button>
            ) : null}
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Parallel
              <select
                value={concurrency}
                disabled={running}
                onChange={(e) => onConcurrencyChange(Number(e.target.value))}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              >
                {CONCURRENCY_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n} at a time
                  </option>
                ))}
              </select>
            </label>
            {running ? (
              <span className="text-sm text-muted-foreground">
                Reading {active} resume{active === 1 ? "" : "s"}
                {retrying ? ` · ${retrying} waiting to retry after a rate limit` : ""}…
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-4 lg:grid-cols-7">
        <StatTile icon={<Users className="h-5 w-5" />} label="Screened" value={sum.evaluated} accent="#4f46e5" />
        <StatTile icon={<Award className="h-5 w-5" />} label="Shortlisted" value={sum.shortlisted} accent="#10b981" />
        <StatTile icon={<TriangleAlert className="h-5 w-5" />} label="Borderline" value={sum.borderline} accent="#f59e0b" />
        <StatTile icon={<XCircle className="h-5 w-5" />} label="Not shortlisted" value={sum.notShortlisted + sum.outsideTopN} accent="#64748b" />
        <StatTile icon={<Ban className="h-5 w-5" />} label="Not QA" value={sum.notQa} accent="#a1a1aa" />
        <StatTile icon={<FileWarning className="h-5 w-5" />} label="Not a resume" value={sum.invalid} accent="#e11d48" />
        <StatTile icon={<TriangleAlert className="h-5 w-5" />} label="Errors" value={sum.errors} accent="#ef4444" />
      </div>

      <RulesCard rules={rules} onChange={onRulesChange} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FilePlus2 className="h-4 w-4" /> Add batch {nextBatch}
          </CardTitle>
          <CardDescription>
            Paste the next set of candidates. Mobile numbers already in this run are skipped, and the ranking and
            downloads cover every batch together (or pick one batch above).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <QaPaste key={pasteKey} batch={nextBatch} existing={existing} onParsed={setNewRows} />
          <Button
            disabled={!newRows.length}
            onClick={() => {
              onAddBatch(newRows);
              setNewRows([]);
              setPasteKey((k) => k + 1);
            }}
          >
            <Play className="h-4 w-4" /> Add {newRows.length || ""} &amp; screen
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base">Ranking</CardTitle>
            <div className="relative w-64">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="h-9 pl-8" placeholder="Search mobile or name" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {tabs.map(([key, label, n]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  filter === key ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
                )}
              >
                {label} <span className="tabular-nums opacity-80">{n}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            Mandatory per section:
            {QA_SECTIONS.map((s) => (
              <span key={s} className="inline-flex items-center gap-1">
                <span className={cn("h-2.5 w-2.5 rounded-sm", SECTION_COLOR[s])} /> {SECTION_LABEL[s]}
              </span>
            ))}
            <span>· QA · ST Software Testing · MT Manual · AT Automated · Sel Selenium — hover for the quotes, click a row for full evidence.</span>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead className="w-14 text-right">Rank</TableHead>
                  <TableHead>Candidate</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead>Mandatory</TableHead>
                  <TableHead>Good-to-have</TableHead>
                  <TableHead>QA profile</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((row) => {
                  const r = row.result;
                  const s = row.score;
                  // Only model-read resumes have evidence to expand.
                  const expandable = r?.status === "ok";
                  const isOpen = expandable && open === row.id;
                  return (
                    <React.Fragment key={row.id}>
                      <TableRow
                        className={cn(expandable && "cursor-pointer")}
                        onClick={() => expandable && setOpen(isOpen ? null : row.id)}
                      >
                        <TableCell className="text-muted-foreground">
                          {expandable ? isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" /> : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.rank || "—"}
                          {row.shortlistRank ? <div className="text-[11px] text-emerald-700">#{row.shortlistRank} SL</div> : null}
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">{row.candidate.name || r?.name || <span className="text-muted-foreground">—</span>}</div>
                          <div className="font-mono text-xs text-muted-foreground">
                            {row.candidate.mobile} · B{row.candidate.batch}
                          </div>
                          {/^https?:\/\//i.test(row.candidate.resumeUrl) ? (
                            <a
                              href={row.candidate.resumeUrl}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                            >
                              Resume <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : null}
                        </TableCell>
                        <TableCell className="max-w-[240px]">
                          <span className={cn("inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold", STATUS_STYLE[row.status])}>
                            {row.status}
                          </span>
                          {row.reasons.length && row.status !== "Shortlisted" ? (
                            <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground" title={row.reasons.join("\n")}>
                              {row.reasons.join(" · ")}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right">
                          {s && r?.status === "ok" ? (
                            <>
                              <div className="text-base font-bold tabular-nums">{s.finalScore}%</div>
                              <div className="whitespace-nowrap text-[11px] text-muted-foreground">
                                {s.mandatoryScore} + {s.bonus}
                              </div>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>{r && r.status === "ok" ? <Matrix r={r} /> : null}</TableCell>
                        <TableCell className="max-w-[200px] text-xs">
                          {s && r?.status === "ok" ? (
                            <span title={s.goodToHave.join(", ")}>
                              <span className="font-semibold">{s.goodToHave.length}</span>
                              <span className="text-muted-foreground"> — {s.goodToHave.slice(0, 4).join(", ")}{s.goodToHave.length > 4 ? "…" : ""}</span>
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="max-w-[260px] text-xs">
                          {r?.status === "ok" ? (
                            <>
                              <div>
                                <Badge variant="secondary" className="mr-1 px-1.5 py-0 text-[10px]">
                                  {r.qaFocus}
                                </Badge>
                                {r.primaryProfile}
                              </div>
                              <p className="mt-0.5 line-clamp-2 text-muted-foreground" title={r.remarks}>
                                {r.remarks}
                              </p>
                            </>
                          ) : r?.status === "error" ? (
                            <span className="text-muted-foreground">{r.retryable ? "Re-run later (rate limit / timeout)" : "Fix the link, then re-run"}</span>
                          ) : r?.status === "invalid" ? (
                            <span className="text-muted-foreground">Ask the candidate for their actual resume</span>
                          ) : r ? (
                            <span className="text-muted-foreground">{r.remarks}</span>
                          ) : null}
                        </TableCell>
                      </TableRow>
                      {isOpen ? (
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          <TableCell colSpan={8}>
                            <Details row={row} />
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </React.Fragment>
                  );
                })}
                {!pageRows.length ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                      {running && !done ? "Reading the first resumes…" : "No candidates in this view."}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
          {pages > 1 ? (
            <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {page * PAGE + 1}–{Math.min(visible.length, (page + 1) * PAGE)} of {visible.length}
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button size="sm" variant="outline" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
