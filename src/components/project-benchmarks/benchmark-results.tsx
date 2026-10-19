"use client";

import * as React from "react";
import {
  ChevronDown,
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/select";
import { Panel } from "@/components/ui/panel";
import { Field } from "@/components/ui/field";
import { SettingRow } from "@/components/ui/setting-row";
import { InfoHint } from "@/components/ui/info-hint";
import { Notice } from "@/components/ui/notice";
import { Progress } from "@/components/ui/progress";
import { Stat, StatGrid } from "@/components/ui/stat";
import { ActionBar } from "@/components/ui/action-bar";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BarChart, SERIES, SERIES_NEUTRAL } from "@/components/charts";
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

/** Entries shown per sub-area before "show all". */
const PREVIEW_PER_GROUP = 8;

const inlineLink =
  "rounded-sm text-[13px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25";

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

/** 85+ exceptional, 70+ meets the bar, below that borderline. */
function scoreVariant(score: number): "success" | "default" | "warning" {
  if (score >= 85) return "success";
  if (score >= 70) return "default";
  return "warning";
}

function ProjectCard({ entry, rank, showSources }: { entry: BenchmarkEntry; rank: number; showSources: boolean }) {
  const p = entry.project;
  const from = entry.sources.map((s) => s.label).join(", ");
  return (
    <li className="px-5 py-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h4 className="font-sans text-sm font-semibold leading-snug tracking-normal">
            <span className="mr-1.5 font-normal tabular-nums text-muted-foreground">{rank}.</span>
            {p.title}
          </h4>
          {showSources ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={from}>
              From: {from}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {entry.sources.length > 1 ? (
            <Badge variant="secondary" className="tabular-nums">
              in {entry.sources.length} resumes
            </Badge>
          ) : null}
          <Badge variant="outline" className="tabular-nums" title="Domain match">
            Match {p.relevance}
          </Badge>
          <Badge variant={scoreVariant(p.score)} className="tabular-nums" title="15+ LPA benchmark score">
            Score {p.score}
          </Badge>
        </div>
      </div>
      {p.techStack.length ? (
        <ul className="mt-2.5 flex flex-wrap gap-1" aria-label="Tech stack">
          {p.techStack.map((t) => (
            <li key={t}>
              <Badge variant="secondary" className="font-normal text-foreground">
                {t}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-2.5 text-[13px] leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Why 15+ LPA:</span> {p.whyBenchmark}
      </p>
      {p.architecture.length ? (
        <details className="group mt-2">
          <summary className={cn(inlineLink, "inline-flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden")}>
            <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
            Core features and architecture
            <span className="font-normal tabular-nums text-muted-foreground">({p.architecture.length})</span>
          </summary>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[13px] leading-relaxed">
            {p.architecture.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
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

  // Presentation only: one primary action at a time, sub-area names and colours.
  const canScreen = !running && pending.length > 0;
  const showRunBar = running || pending.length > 0 || errored.length > 0 || invalid.length > 0;
  const failedRows = [...errored, ...invalid];
  const issues = [
    errored.length ? `${errored.length} couldn't be screened (use Retry)` : "",
    invalid.length ? `${invalid.length} weren't resumes (photos, certificates, blank)` : "",
    unverified ? `${unverified} project${unverified === 1 ? "" : "s"} dropped because they weren't found in the resume text` : "",
  ].filter(Boolean);
  const categoryLabel = (c: string) => (c === OTHER_CATEGORY ? `Other ${d}` : c);
  // Fixed slot per sub-area (its position in the domain profile); "Other" is neutral.
  const categoryColor = (c: string) => {
    const i = profile.categories.indexOf(c);
    return c !== OTHER_CATEGORY && i >= 0 && i < SERIES.length ? SERIES[i] : SERIES_NEUTRAL;
  };
  const chartData = chipCategories.map((c) => ({ label: categoryLabel(c), value: perCategory.get(c) ?? 0, color: categoryColor(c) }));

  return (
    <div className="space-y-6">
      {/* Run header: which run this is, how fast it reads, and adding more resumes. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="truncate font-display text-[18px] font-semibold leading-7" title={title}>
            {title}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
            <Badge>
              <Target /> {d}
            </Badge>
            <span className="tabular-nums">
              {candidates.length} resume{candidates.length === 1 ? "" : "s"}
            </span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">
              {batches.length} batch{batches.length === 1 ? "" : "es"}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            aria-label="Resumes screened in parallel"
            value={concurrency}
            onChange={(e) => onConcurrencyChange(Number(e.target.value))}
            className="h-9 w-auto"
          >
            {CONCURRENCY_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} in parallel
              </option>
            ))}
          </NativeSelect>
          <Button variant="outline" size="sm" className="h-9" aria-expanded={showAdd} onClick={() => setShowAdd((v) => !v)}>
            <FilePlus2 className="h-4 w-4" /> Add resumes
          </Button>
        </div>
      </div>

      {storageError ? (
        <Notice tone="danger" title="Not saved in this browser">
          {storageError}
        </Notice>
      ) : null}
      {notice ? (
        <Notice tone="info" title="This run was repaired">
          {notice}
        </Notice>
      ) : null}

      {showAdd ? (
        <Panel
          icon={<FilePlus2 />}
          title={`Batch ${nextBatch}: paste more resumes`}
          description={`They are screened for ${d} straight away and added to this run's export.`}
          footer={
            <div className="flex w-full justify-end">
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
          }
        >
          <BenchmarkPaste batch={nextBatch} existing={existing} onParsed={setNextRows} />
        </Panel>
      ) : null}

      <StatGrid cols={4}>
        <Stat icon={<Users />} label="Resumes screened" value={done} hint={`of ${candidates.length}`} />
        <Stat icon={<FileText />} label={`Resumes with a ${d} project`} value={totals.withProjects} />
        <Stat icon={<Trophy />} label={`${d} projects`} value={totals.projects} tone="highlight" hint="At the current bars" />
        <Stat icon={<SearchX />} label={`No ${d} terms (skipped)`} value={totals.skipped} hint="Skipped without an AI call" />
      </StatGrid>

      {issues.length && !running ? (
        <div className="space-y-3">
          <Notice
            tone="warning"
            action={
              failedRows.length ? (
                <Button variant="ghost" size="sm" aria-expanded={showErrors} onClick={() => setShowErrors((v) => !v)}>
                  {showErrors ? "Hide details" : "Show details"}
                </Button>
              ) : null
            }
          >
            {issues.join(" · ")}
          </Notice>
          {showErrors && failedRows.length ? (
            <div className="overflow-hidden rounded-xl border bg-card shadow-surface">
              <Table containerClassName="max-h-[320px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Resume</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {failedRows.slice(0, 500).map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="whitespace-nowrap tabular-nums">{c.label}</TableCell>
                      <TableCell>
                        {results[c.id]?.status === "error" ? (
                          <Badge variant="destructive">Error</Badge>
                        ) : (
                          <Badge variant="warning">Not a resume</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <div className="line-clamp-2 max-w-[640px]" title={results[c.id]?.error}>
                          {results[c.id]?.error}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <Panel icon={<Target />} title={d} description="What this run screens for">
          <div className="space-y-3 text-[13px] leading-relaxed">
            <p className="text-muted-foreground">{profile.summary}</p>
            {profile.focus ? (
              <p>
                <span className="font-medium">Focus:</span> {profile.focus}
              </p>
            ) : null}
            <button type="button" className={inlineLink} aria-expanded={showProfile} onClick={() => setShowProfile((v) => !v)}>
              {showProfile ? "Hide" : "Show"} what counts as 15+ LPA {d} work
            </button>
            {showProfile ? (
              <div className="grid gap-4 border-t pt-3 sm:grid-cols-2">
                <div>
                  <p className="font-medium">Production-grade signals</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                    {profile.advancedSignals.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="font-medium">Basic work, excluded</p>
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
          </div>
        </Panel>
        <Panel title="Projects by sub-area" description="At the current quality bar and domain match">
          <BarChart data={chartData} />
        </Panel>
      </div>

      <Panel
        flush
        icon={<Trophy />}
        title={`${d} projects`}
        description="Grouped by sub-area. Changing a filter rebuilds the list instantly; no resume is read again."
      >
        {/* Toolbar: the export, then the bars and sub-areas that decide what is listed and exported. */}
        <div className="space-y-4 border-y bg-muted/30 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 text-[13px] font-medium">
              Markdown for Notion
              <InfoHint align="start" label="About the Markdown export">
                A Markdown (.md) file of the {d} projects only, grouped by sub-area, each with its tech stack, core
                features and architecture and why it hits the 15+ LPA benchmark. Paste it into a Notion page, or use
                Notion&apos;s Import, then Markdown.
              </InfoHint>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => void copy()} disabled={!totals.screened}>
                <Copy className="h-4 w-4" /> {copied ? "Copied" : "Copy Markdown"}
              </Button>
              <Button
                variant={canScreen ? "outline" : "default"}
                className="h-auto min-h-10 whitespace-normal py-2 text-left"
                onClick={() => download(benchmarkFileName(d), markdown())}
                disabled={!totals.screened}
              >
                <Download className="h-4 w-4" /> Download .md ({totals.projects} {d} project{totals.projects === 1 ? "" : "s"})
              </Button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Quality bar (15+ LPA)" htmlFor="bench-bar">
              <NativeSelect
                id="bench-bar"
                value={settings.minScore}
                onChange={(e) => onSettingsChange({ ...settings, minScore: Number(e.target.value) })}
              >
                {SCORE_BARS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={`Domain match (${d})`} htmlFor="bench-match">
              <NativeSelect
                id="bench-match"
                value={settings.minRelevance}
                onChange={(e) => onSettingsChange({ ...settings, minRelevance: Number(e.target.value) })}
              >
                {RELEVANCE_BARS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <div>
              <SettingRow
                id="bench-sources"
                title="Include source resumes"
                description="Mobile or resume number per project."
                info="Lists the resumes each project came from. Keep it off for a page shared with students."
                checked={settings.showSources}
                onCheckedChange={(v) => onSettingsChange({ ...settings, showSources: v })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
              <span className="font-medium">{d} sub-areas</span>
              <span className="text-muted-foreground">
                {settings.categories.length ? `${settings.categories.length} selected` : "All included"}
              </span>
              <InfoHint align="start">Click sub-areas to include only those in the list and the export.</InfoHint>
              {settings.categories.length ? (
                <button type="button" className={inlineLink} onClick={() => onSettingsChange({ ...settings, categories: [] })}>
                  Include all sub-areas
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {chipCategories.map((c) => {
                const on = settings.categories.includes(c);
                const count = perCategory.get(c) ?? 0;
                return (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleCategory(c)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25",
                      on ? "border-primary bg-accent font-medium text-accent-foreground" : "bg-card hover:bg-muted",
                      !count && !on && "opacity-60",
                    )}
                  >
                    <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: categoryColor(c) }} aria-hidden />
                    {categoryLabel(c)}
                    <span className="tabular-nums text-muted-foreground">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {running ? (
            <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Still screening. The export covers what&apos;s done so far.
            </p>
          ) : null}
        </div>

        {groups.length ? (
          groups.map((g, gi) => {
            const open = expanded.has(g.category);
            const shown = open ? g.entries : g.entries.slice(0, PREVIEW_PER_GROUP);
            return (
              <section key={g.category} aria-label={categoryLabel(g.category)} className={cn(gi > 0 && "border-t")}>
                <div className="flex items-center gap-2 border-b bg-muted/50 px-5 py-2.5">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: categoryColor(g.category) }} aria-hidden />
                  <h3 className="font-sans text-sm font-semibold tracking-normal">{categoryLabel(g.category)}</h3>
                  <Badge variant="secondary" className="tabular-nums">
                    {g.entries.length}
                  </Badge>
                </div>
                <ol className="divide-y">
                  {shown.map((e, i) => (
                    <ProjectCard key={`${e.project.title}-${i}`} entry={e} rank={i + 1} showSources={settings.showSources} />
                  ))}
                </ol>
                {g.entries.length > PREVIEW_PER_GROUP ? (
                  <div className="border-t px-5 py-2.5">
                    <button
                      type="button"
                      className={inlineLink}
                      aria-expanded={open}
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
                  </div>
                ) : null}
              </section>
            );
          })
        ) : (
          <div className="p-5">
            <EmptyState
              icon={<Trophy />}
              title={running || pending.length ? "No projects yet" : "No project met the bar"}
              description={
                running || pending.length
                  ? `${d} projects that meet the bar will appear here as resumes are screened.`
                  : `No ${d} project met the bar. Try a lower quality bar, a wider domain match, or all sub-areas.`
              }
            />
          </div>
        )}
      </Panel>

      <Panel
        icon={<Repeat />}
        title="Screen these resumes for another domain"
        description={`Starts a new run on the same ${candidates.length} resume${candidates.length === 1 ? "" : "s"}, with no need to paste them again. This run and its export stay as they are.`}
        footer={
          <>
            {running ? <p className="text-xs text-muted-foreground">Available when this run finishes or is stopped.</p> : null}
            <Button
              variant="outline"
              className="ml-auto h-auto min-h-10 whitespace-normal py-2 text-left"
              disabled={!otherDomain.trim() || otherBusy || running}
              onClick={() => void screenOther()}
            >
              {otherBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Repeat className="h-4 w-4" />}
              {otherBusy ? "Preparing the domain…" : `Screen ${candidates.length} resumes for ${otherDomain.trim() || "…"}`}
            </Button>
          </>
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Domain" htmlFor="bench-other">
            <Input
              id="bench-other"
              placeholder="e.g. Backend Engineering, MERN Stack, DevOps"
              value={otherDomain}
              onChange={(e) => setOtherDomain(e.target.value)}
            />
          </Field>
          <Field label="Focus" optional htmlFor="bench-other-focus">
            <Textarea
              id="bench-other-focus"
              className="min-h-[64px]"
              placeholder="e.g. only microservices and event-driven systems"
              value={otherFocus}
              onChange={(e) => setOtherFocus(e.target.value)}
            />
          </Field>
        </div>
        {otherError ? (
          <Notice tone="danger" className="mt-4">
            {otherError}
          </Notice>
        ) : null}
      </Panel>

      {showRunBar ? (
        <ActionBar
          status={
            <div className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span>
                  <span className="font-medium tabular-nums text-foreground">{done}</span> of{" "}
                  <span className="tabular-nums">{candidates.length}</span> resumes screened
                </span>
                {running ? (
                  <span className="tabular-nums">
                    {active} reading now{retrying ? ` · ${retrying} waiting to retry (rate limit)` : ""}
                  </span>
                ) : null}
              </div>
              <Progress value={done} max={candidates.length} label="Resumes screened" />
            </div>
          }
        >
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
          {running ? (
            <Button variant="outline" onClick={onStop}>
              <Square className="h-4 w-4" /> Stop
            </Button>
          ) : pending.length ? (
            <Button onClick={() => onRun(pending)}>
              <Play className="h-4 w-4" /> Screen {pending.length} for {d}
            </Button>
          ) : null}
        </ActionBar>
      ) : null}
    </div>
  );
}
