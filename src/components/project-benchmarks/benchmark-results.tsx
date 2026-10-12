"use client";

import * as React from "react";
import {
  ArrowLeft,
  Copy,
  Download,
  FileText,
  FilePlus2,
  Loader2,
  Play,
  Repeat,
  RotateCcw,
  SearchX,
  Square,
  Target,
  Trophy,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { StatTile } from "@/components/charts";
import { BenchmarkPaste } from "@/components/project-benchmarks/benchmark-paste";
import { benchmarkFileName, buildBenchmarkMarkdown, consolidateBenchmarks, type BenchmarkEntry } from "@/lib/benchmark-report";
import {
  OTHER_CATEGORY,
  RELEVANCE_BARS,
  SCORE_BARS,
  type BenchmarkBatch,
  type BenchmarkCandidateInput,
  type BenchmarkDomainProfile,
  type BenchmarkResult,
} from "@/lib/benchmark-types";
import { cn } from "@/lib/utils";

export const CONCURRENCY_OPTIONS = [4, 6, 8, 10, 12, 16];

export interface ExportSettings {
  minScore: number;
  minRelevance: number;
  /** Sub-areas included in the export ([] = all). */
  categories: string[];
  showSources: boolean;
}

interface BenchmarkResultsProps {
  title: string;
  profile: BenchmarkDomainProfile;
  candidates: BenchmarkCandidateInput[];
  results: Record<string, BenchmarkResult>;
  batches: BenchmarkBatch[];
  settings: ExportSettings;
  onSettingsChange: (s: ExportSettings) => void;
  running: boolean;
  active: number;
  retrying: number;
  concurrency: number;
  onConcurrencyChange: (n: number) => void;
  onRun: (targets: BenchmarkCandidateInput[]) => void;
  onStop: () => void;
  onBack: () => void;
  onAddBatch: (candidates: BenchmarkCandidateInput[]) => void;
  /** Start a new run on these same resumes for another domain; resolves to an error message, or "" on success. */
  onScreenForDomain: (domain: string, focus: string) => Promise<string>;
  storageError: string;
  /** A note about this run (e.g. it was repaired on opening). */
  notice?: string;
}

const fieldClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
const textareaClass =
  "min-h-[64px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
/** Entries shown per sub-area before "show all". */
const PREVIEW_PER_GROUP = 8;

function download(name: string, text: string) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function scoreClass(score: number): string {
  if (score >= 85) return "bg-emerald-100 text-emerald-800";
  if (score >= 70) return "bg-sky-100 text-sky-800";
  return "bg-amber-100 text-amber-800";
}

function ProjectCard({ entry, rank, showSources }: { entry: BenchmarkEntry; rank: number; showSources: boolean }) {
  const p = entry.project;
  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-medium">
          <span className="mr-1.5 text-muted-foreground">{rank}.</span>
          {p.title}
        </p>
        <div className="flex items-center gap-1.5">
          {entry.sources.length > 1 ? <Badge variant="secondary">in {entry.sources.length} resumes</Badge> : null}
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground" title="Domain match">
            match {p.relevance}
          </span>
          <span className={cn("rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums", scoreClass(p.score))} title="15+ LPA benchmark score">
            {p.score}
          </span>
        </div>
      </div>
      {p.techStack.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {p.techStack.map((t) => (
            <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-xs">
              {t}
            </span>
          ))}
        </div>
      ) : null}
      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">
        {p.architecture.map((a, i) => (
          <li key={i}>{a}</li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Why 15+ LPA:</span> {p.whyBenchmark}
      </p>
      {showSources ? (
        <p className="mt-1 text-xs text-muted-foreground">From: {entry.sources.map((s) => s.label).join(", ")}</p>
      ) : null}
    </div>
  );
}

export function BenchmarkResults({
  title,
  profile,
  candidates,
  results,
  batches,
  settings,
  onSettingsChange,
  running,
  active,
  retrying,
  concurrency,
  onConcurrencyChange,
  onRun,
  onStop,
  onBack,
  onAddBatch,
  onScreenForDomain,
  storageError,
  notice,
}: BenchmarkResultsProps) {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [nextRows, setNextRows] = React.useState<BenchmarkCandidateInput[]>([]);
  const [showAdd, setShowAdd] = React.useState(false);
  const [showErrors, setShowErrors] = React.useState(false);
  const [showProfile, setShowProfile] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [otherDomain, setOtherDomain] = React.useState("");
  const [otherFocus, setOtherFocus] = React.useState("");
  const [otherBusy, setOtherBusy] = React.useState(false);
  const [otherError, setOtherError] = React.useState("");
  const d = profile.domain;

  const filters = { minScore: settings.minScore, minRelevance: settings.minRelevance, categories: settings.categories };
  const { groups, totals } = React.useMemo(
    () => consolidateBenchmarks(candidates, results, profile, filters),
    // filters is rebuilt each render from these three values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidates, results, profile, settings.minScore, settings.minRelevance, settings.categories],
  );
  // Project count per sub-area at the current bars (ignoring the sub-area filter) — shown on the filter chips.
  const perCategory = React.useMemo(() => {
    const all = consolidateBenchmarks(candidates, results, profile, { ...filters, categories: [] }).groups;
    return new Map(all.map((g) => [g.category, g.entries.length]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, results, profile, settings.minScore, settings.minRelevance]);
  const chipCategories = [...profile.categories, ...(perCategory.has(OTHER_CATEGORY) ? [OTHER_CATEGORY] : [])];

  const pending = candidates.filter((c) => !results[c.id]);
  const errored = candidates.filter((c) => results[c.id]?.status === "error");
  const invalid = candidates.filter((c) => results[c.id]?.status === "invalid");
  const unverified = Object.values(results).reduce((s, r) => s + (r.unverified || 0), 0);
  const done = candidates.length - pending.length;
  const pct = candidates.length ? Math.round((done / candidates.length) * 100) : 0;

  const existing = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const c of candidates) m.set(c.id, c.batch);
    return m;
  }, [candidates]);
  const nextBatch = (batches.length ? batches[batches.length - 1].n : 0) + 1;

  const markdown = () =>
    buildBenchmarkMarkdown(groups, totals, {
      title,
      profile,
      filters,
      generatedAt: new Date().toISOString(),
      showSources: settings.showSources,
    });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const toggleCategory = (c: string) => {
    const has = settings.categories.includes(c);
    onSettingsChange({ ...settings, categories: has ? settings.categories.filter((x) => x !== c) : [...settings.categories, c] });
  };

  const screenOther = async () => {
    setOtherError("");
    setOtherBusy(true);
    const err = await onScreenForDomain(otherDomain, otherFocus);
    setOtherBusy(false);
    if (err) setOtherError(err);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="ghost" size="sm" onClick={onBack} className="shrink-0">
              <ArrowLeft className="h-4 w-4" /> Dashboard
            </Button>
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 truncate text-base font-semibold">
                <Trophy className="h-4 w-4 text-muted-foreground" /> {title}
              </h2>
              <p className="text-sm text-muted-foreground">
                Domain: <span className="font-medium text-foreground">{d}</span> · {done}/{candidates.length} resumes screened ·{" "}
                {batches.length} batch{batches.length === 1 ? "" : "es"}
                {running ? ` · ${active} reading now${retrying ? ` · ${retrying} waiting to retry (rate limit)` : ""}` : ""}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Resumes screened in parallel"
              value={concurrency}
              onChange={(e) => onConcurrencyChange(Number(e.target.value))}
              className={cn(fieldClass, "w-auto")}
            >
              {CONCURRENCY_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} in parallel
                </option>
              ))}
            </select>
            {running ? (
              <Button variant="outline" onClick={onStop}>
                <Square className="h-4 w-4" /> Stop
              </Button>
            ) : pending.length ? (
              <Button onClick={() => onRun(pending)}>
                <Play className="h-4 w-4" /> Screen {pending.length} for {d}
              </Button>
            ) : null}
            {!running && errored.length ? (
              <Button variant="outline" onClick={() => onRun(errored)}>
                <RotateCcw className="h-4 w-4" /> Retry {errored.length} failed
              </Button>
            ) : null}
            {!running && invalid.length ? (
              <Button
                variant="outline"
                onClick={() => onRun(invalid)}
                title="Read these again — e.g. after a fix, or to double-check files judged to be photos / certificates"
              >
                <RotateCcw className="h-4 w-4" /> Re-check {invalid.length} &ldquo;not a resume&rdquo;
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setShowAdd((v) => !v)}>
              <FilePlus2 className="h-4 w-4" /> Add resumes
            </Button>
          </div>
        </CardContent>
        <div className="h-1.5 w-full overflow-hidden rounded-b-xl bg-muted">
          <div className={cn("h-full bg-primary transition-all", running && "animate-pulse")} style={{ width: `${pct}%` }} />
        </div>
      </Card>

      {storageError ? <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">{storageError}</p> : null}
      {notice ? <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">{notice}</p> : null}

      {showAdd ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Batch {nextBatch} — paste more resumes</CardTitle>
            <CardDescription>They are screened for {d} straight away and added to this run&apos;s export.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <BenchmarkPaste batch={nextBatch} existing={existing} onParsed={setNextRows} />
            <div className="flex justify-end">
              <Button
                disabled={!nextRows.length}
                onClick={() => {
                  onAddBatch(nextRows);
                  setNextRows([]);
                  setShowAdd(false);
                }}
              >
                <Play className="h-4 w-4" /> Screen {nextRows.length} resume{nextRows.length === 1 ? "" : "s"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Target className="h-4 w-4" /> {d}
          </CardTitle>
          <CardDescription>{profile.summary}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {profile.focus ? (
            <p>
              <span className="font-medium">Focus:</span> {profile.focus}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 font-medium">Sub-areas:</span>
            {profile.categories.map((c) => (
              <span key={c} className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                {c}
              </span>
            ))}
          </div>
          <button type="button" className="text-xs text-primary hover:underline" onClick={() => setShowProfile((v) => !v)}>
            {showProfile ? "Hide" : "Show"} what counts as 15+ LPA {d} work
          </button>
          {showProfile ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <p className="font-medium">Production-grade signals</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                  {profile.advancedSignals.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="font-medium">Basic work — excluded</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                  {profile.basicExamples.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  Resumes with none of the domain&apos;s {profile.keywords.length} terms are skipped without an AI call.
                </p>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile icon={<Users className="h-5 w-5" />} label="Resumes screened" value={done} accent="#4f46e5" />
        <StatTile icon={<FileText className="h-5 w-5" />} label={`Resumes with a ${d} project`} value={totals.withProjects} accent="#10b981" />
        <StatTile icon={<Trophy className="h-5 w-5" />} label={`${d} projects`} value={totals.projects} accent="#f59e0b" />
        <StatTile icon={<SearchX className="h-5 w-5" />} label={`No ${d} terms (skipped)`} value={totals.skipped} accent="#94a3b8" />
      </div>

      {(errored.length || invalid.length || unverified) && !running ? (
        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            {errored.length ? `${errored.length} couldn't be screened (use Retry) · ` : ""}
            {invalid.length ? `${invalid.length} weren't resumes (photos, certificates, blank) · ` : ""}
            {unverified ? `${unverified} project${unverified === 1 ? "" : "s"} dropped because they weren't found in the resume text · ` : ""}
            <button type="button" className="text-primary hover:underline" onClick={() => setShowErrors((v) => !v)}>
              {showErrors ? "hide details" : "show details"}
            </button>
          </p>
          {showErrors ? (
            <div className="max-h-64 overflow-auto rounded-md border text-xs">
              <table className="w-full">
                <thead className="sticky top-0 bg-muted text-left">
                  <tr>
                    <th className="px-2 py-1 font-medium">Resume</th>
                    <th className="px-2 py-1 font-medium">Status</th>
                    <th className="px-2 py-1 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {[...errored, ...invalid].slice(0, 500).map((c) => (
                    <tr key={c.id} className="border-t">
                      <td className="px-2 py-1 font-mono">{c.label}</td>
                      <td className="px-2 py-1">{results[c.id]?.status === "error" ? "Error" : "Not a resume"}</td>
                      <td className="px-2 py-1 text-muted-foreground">{results[c.id]?.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Download className="h-4 w-4" /> Export {d} projects for Notion
          </CardTitle>
          <CardDescription>
            A Markdown (.md) file of the {d} projects only, grouped by sub-area — each with its tech stack, core
            features &amp; architecture and why it hits the 15+ LPA benchmark. Paste it into a Notion page, or use
            Notion&apos;s Import → Markdown. Changing these settings re-builds the list instantly — no resume is read again.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="bench-bar">Quality bar (15+ LPA)</Label>
              <select
                id="bench-bar"
                value={settings.minScore}
                onChange={(e) => onSettingsChange({ ...settings, minScore: Number(e.target.value) })}
                className={fieldClass}
              >
                {SCORE_BARS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bench-match">Domain match ({d})</Label>
              <select
                id="bench-match"
                value={settings.minRelevance}
                onChange={(e) => onSettingsChange({ ...settings, minRelevance: Number(e.target.value) })}
                className={fieldClass}
              >
                {RELEVANCE_BARS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-start justify-between gap-3 rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">Include source resumes</p>
                <p className="text-xs text-muted-foreground">Mobile / resume number per project. Off for a page shared with students.</p>
              </div>
              <Switch checked={settings.showSources} onCheckedChange={(v) => onSettingsChange({ ...settings, showSources: v })} />
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">
              {d} sub-areas{" "}
              <span className="font-normal text-muted-foreground">
                ({settings.categories.length ? `${settings.categories.length} selected` : "all"} — click to include only some)
              </span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              {chipCategories.map((c) => {
                const on = settings.categories.includes(c);
                const count = perCategory.get(c) ?? 0;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => toggleCategory(c)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs transition-colors",
                      on ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
                      !count && !on && "opacity-50",
                    )}
                  >
                    {c === OTHER_CATEGORY ? `Other ${d}` : c}{" "}
                    <span className={cn("tabular-nums", on ? "opacity-80" : "text-muted-foreground")}>{count}</span>
                  </button>
                );
              })}
              {settings.categories.length ? (
                <button
                  type="button"
                  className="px-2 text-xs text-primary hover:underline"
                  onClick={() => onSettingsChange({ ...settings, categories: [] })}
                >
                  all sub-areas
                </button>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => download(benchmarkFileName(d), markdown())} disabled={!totals.screened}>
              <Download className="h-4 w-4" /> Download .md ({totals.projects} {d} project{totals.projects === 1 ? "" : "s"})
            </Button>
            <Button variant="outline" onClick={() => void copy()} disabled={!totals.screened}>
              <Copy className="h-4 w-4" /> {copied ? "Copied" : "Copy Markdown"}
            </Button>
            {running ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Still screening — the export covers what&apos;s done so far.
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {groups.length ? (
        groups.map((g) => {
          const open = expanded.has(g.category);
          const shown = open ? g.entries : g.entries.slice(0, PREVIEW_PER_GROUP);
          return (
            <Card key={g.category}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  {g.category === OTHER_CATEGORY ? `Other ${d}` : g.category} <Badge variant="secondary">{g.entries.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {shown.map((e, i) => (
                  <ProjectCard key={`${e.project.title}-${i}`} entry={e} rank={i + 1} showSources={settings.showSources} />
                ))}
                {g.entries.length > PREVIEW_PER_GROUP ? (
                  <button
                    type="button"
                    className="text-sm text-primary hover:underline"
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (open) next.delete(g.category);
                        else next.add(g.category);
                        return next;
                      })
                    }
                  >
                    {open ? "Show fewer" : `Show all ${g.entries.length}`}
                  </button>
                ) : null}
              </CardContent>
            </Card>
          );
        })
      ) : (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {running || pending.length
              ? `${d} projects that meet the bar will appear here as resumes are screened.`
              : `No ${d} project met the bar. Try a lower quality bar, a wider domain match, or all sub-areas.`}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Repeat className="h-4 w-4" /> Screen these resumes for another domain
          </CardTitle>
          <CardDescription>
            Starts a new run on the same {candidates.length} resume{candidates.length === 1 ? "" : "s"} — no need to paste
            them again. This run and its export stay as they are.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bench-other">Domain</Label>
              <Input
                id="bench-other"
                placeholder="e.g. Backend Engineering, MERN Stack, DevOps"
                value={otherDomain}
                onChange={(e) => setOtherDomain(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bench-other-focus">Focus (optional)</Label>
              <textarea
                id="bench-other-focus"
                className={textareaClass}
                placeholder="e.g. only microservices and event-driven systems"
                value={otherFocus}
                onChange={(e) => setOtherFocus(e.target.value)}
              />
            </div>
          </div>
          {otherError ? <p className="text-sm text-destructive">{otherError}</p> : null}
          <Button variant="outline" disabled={!otherDomain.trim() || otherBusy || running} onClick={() => void screenOther()}>
            {otherBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Repeat className="h-4 w-4" />}
            {otherBusy ? "Preparing the domain…" : `Screen ${candidates.length} resumes for ${otherDomain.trim() || "…"}`}
          </Button>
          {running ? <p className="text-xs text-muted-foreground">Available when this run finishes or is stopped.</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
