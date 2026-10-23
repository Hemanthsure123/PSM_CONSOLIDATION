"use client";

import * as React from "react";
import {
  Award,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock,
  Download,
  ExternalLink,
  Filter,
  Loader2,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Undo2,
  UserMinus,
} from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { Panel } from "@/components/ui/panel";
import { Progress } from "@/components/ui/progress";
import { NativeSelect } from "@/components/ui/select";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SpDsaBarPanel, SpRulesCard } from "@/components/showcase/showcase-rules";
import { buildCompanyWorkbook, buildInternalWorkbook, buildRoleCsv, dsaPlatformLines, slug } from "@/lib/showcase/export";
import { SP_LANES, SP_LANE_LABEL, laneMinutes, laneSize, planShowcase, type SpLane } from "@/lib/showcase/pipeline";
import { SP_STAGES, dsaHeadline, experienceLine, headline, rankShowcase, type SpRanked, type SpRoleFit, type SpStage, type SpStatus, type SpTrustScore } from "@/lib/showcase/scoring";
import { SP_SIGNAL_LABEL, type SpDataset, type SpRecord, type SpRules } from "@/lib/showcase/types";
import { cn, slugify } from "@/lib/utils";

export const SP_CONCURRENCY_OPTIONS = [2, 4, 6, 8, 10, 12];

export interface SpLaneProgress {
  lane: SpLane;
  done: number;
  total: number;
  running: number;
  waiting: number;
  /** "Waiting for GitHub's rate limit to reset (12 min)". */
  note: string;
}

interface Props {
  title: string;
  dataset: SpDataset;
  records: Record<string, SpRecord>;
  rules: SpRules;
  onRulesChange: (rules: SpRules) => void;
  rejected: string[];
  onToggleReject: (id: string) => void;
  running: boolean;
  progress: SpLaneProgress | null;
  concurrency: number;
  onConcurrencyChange: (n: number) => void;
  onRun: () => void;
  onStop: () => void;
  onReload: () => void;
  reloading: boolean;
  reloadError: string;
  storageError: string;
}

type BadgeVariant = NonNullable<BadgeProps["variant"]>;
type View = { kind: "role"; role: string } | { kind: "near" } | { kind: "all" };
const PAGE = 50;

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function download(name: string, data: BlobPart, type: string) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const STATUS_VARIANT: Record<SpStatus, BadgeVariant> = { Showcase: "success", Strong: "default", "Near miss": "warning", Excluded: "secondary", Pending: "outline" };

function StatusBadge({ row }: { row: SpRanked }) {
  const Icon = row.status === "Showcase" ? Award : row.status === "Strong" ? CircleCheck : row.status === "Pending" ? Clock : row.status === "Near miss" ? Sparkles : CircleX;
  return (
    <Badge variant={STATUS_VARIANT[row.status]}>
      <Icon aria-hidden />
      {row.status}
    </Badge>
  );
}

function TrustBadge({ trust }: { trust: SpTrustScore | null }) {
  if (!trust) return <span className="text-xs text-muted-foreground">—</span>;
  const Icon = trust.band === "High" ? ShieldCheck : ShieldAlert;
  return (
    <Badge variant={trust.band === "High" ? "success" : trust.band === "Medium" ? "warning" : "destructive"} title={`Trust ${trust.score}/100`}>
      <Icon aria-hidden />
      Trust {trust.score} · {trust.band}
    </Badge>
  );
}

function Section({ title, aside, info, children }: { title: React.ReactNode; aside?: React.ReactNode; info?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <h3 className="flex items-center gap-1 text-[13px] font-semibold text-foreground">
          {title}
          {info ? <InfoHint align="start">{info}</InfoHint> : null}
        </h3>
        {aside ? <span className="text-xs text-muted-foreground">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

const PROOF_VARIANT: Record<string, BadgeVariant> = { verified: "success", weak: "warning", failed: "destructive", "no-repo": "secondary", unavailable: "outline", unchecked: "outline" };
const PROOF_LABEL: Record<string, string> = { verified: "Verified in code", weak: "Weak proof", failed: "Not theirs / no code", "no-repo": "No repo", unavailable: "GitHub didn't answer", unchecked: "Not checked" };

function Details({ row }: { row: SpRanked }) {
  const read = row.rec.read?.status === "ok" ? row.rec.read : null;
  const fit: SpRoleFit | null = row.primary ?? row.fits[0] ?? null;
  const dsa = dsaPlatformLines(row);
  return (
    <div className="space-y-5 py-1 text-[13px]">
      <p className={cn("font-medium", row.status === "Excluded" && "text-muted-foreground")}>
        {row.tier ? headline(row) : `${row.stage}: ${row.reason}`}
        {row.tier && row.reason ? <span className="block font-normal text-warning">{row.reason}</span> : null}
      </p>

      {fit ? (
        <Section title={`Checks — ${fit.label}`} aside={`profile score ${fit.score}${fit.score !== fit.raw ? ` (${fit.raw} before trust)` : ""} · projects ${fit.parts.projects} · DSA ${fit.parts.dsa} · GitHub ${fit.parts.engineering} · experience ${fit.parts.experience}`}>
          <ul className="space-y-1">
            {fit.gates.map((g) => (
              <li key={g.key} className="flex items-start gap-2">
                {g.pending ? (
                  <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                ) : g.ok ? (
                  <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
                ) : (
                  <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
                )}
                <span>
                  <span className="font-medium">{g.label}:</span> {g.detail}
                </span>
              </li>
            ))}
          </ul>
          {row.alsoFor.length ? <p className="text-muted-foreground">Also strong for: {row.alsoFor.map((f) => `${f.label} (${f.score})`).join(", ")}</p> : null}
        </Section>
      ) : null}

      {row.projects.length ? (
        <Section
          title={`Projects (${row.projects.length})`}
          info="Quality is the model's 0-100 on a 15+ LPA bar, capped by the program (course / template work, depth, verified complexity signals). Signals are the resume's own words; the code column is what the candidate's own repository proves."
        >
          <div className="overflow-hidden rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Project</TableHead>
                  <TableHead>Roles</TableHead>
                  <TableHead className="text-right">Quality</TableHead>
                  <TableHead>Signals (resume&apos;s words)</TableHead>
                  <TableHead>GitHub proof</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...row.projects]
                  .sort((a, b) => b.quality - a.quality)
                  .map((x, i) => (
                    <TableRow key={i}>
                      <TableCell className="min-w-[180px] max-w-[260px] py-2 align-top">
                        <div className="font-medium">{x.p.title}</div>
                        <div className="text-xs text-muted-foreground">{x.p.techs.join(", ") || "no technologies named"}</div>
                        {x.p.quote ? <div className="mt-0.5 text-xs text-muted-foreground">&ldquo;{x.p.quote}&rdquo;</div> : null}
                      </TableCell>
                      <TableCell className="py-2 align-top text-xs">{x.roles.map((r) => (row.fits.find((f) => f.role === r)?.label ?? r)).join(", ") || "—"}</TableCell>
                      <TableCell className="py-2 text-right align-top tabular-nums">
                        <div className="font-semibold">{x.quality}</div>
                        {x.quality < x.p.quality ? <div className="text-[11px] text-muted-foreground" title={x.capReasons.join("; ")}>model {x.p.quality}</div> : null}
                      </TableCell>
                      <TableCell className="min-w-[200px] max-w-[320px] py-2 align-top text-xs">
                        {x.p.signals.length ? (
                          <ul className="space-y-0.5">
                            {x.p.signals.map((s) => (
                              <li key={s.type}>
                                <span className="font-medium">{SP_SIGNAL_LABEL[s.type]}:</span> <span className="text-muted-foreground">&ldquo;{s.quote}&rdquo;</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="text-muted-foreground">none</span>
                        )}
                        {x.capReasons.length ? <div className="mt-1 text-warning">Capped: {x.capReasons.join("; ")}</div> : null}
                      </TableCell>
                      <TableCell className="min-w-[200px] max-w-[300px] py-2 align-top text-xs">
                        <Badge variant={PROOF_VARIANT[x.proofStatus]}>{PROOF_LABEL[x.proofStatus]}</Badge>
                        {x.proof?.repoUrl ? (
                          <a href={x.proof.repoUrl} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-1 text-primary hover:underline">
                            {x.proof.repoUrl.replace(/^https?:\/\/github\.com\//, "")} <ExternalLink className="h-3 w-3" aria-hidden />
                          </a>
                        ) : null}
                        {x.proofStatus !== "unchecked" ? <div className="mt-0.5 text-muted-foreground">{x.proofWhy}</div> : null}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="DSA" aside={row.dsa?.passed ? `clears the bar on ${dsaHeadline(row)}` : row.dsa?.reason}>
          {dsa.length ? (
            <ul className="space-y-1">
              {dsa.map((d) => (
                <li key={d.key}>
                  <a href={d.url} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
                    {d.line || d.label}
                  </a>
                  {d.identity ? <span className="text-muted-foreground"> · {d.identity}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">No coding profile read.</p>
          )}
          {row.dsa?.notes.map((n) => (
            <p key={n} className="text-warning">
              {n}
            </p>
          ))}
        </Section>
        <Section title="Experience" aside={fit ? `${fit.experience.months} in-role months` : undefined}>
          <p className={cn(!read?.jobs.length && "text-muted-foreground")}>{experienceLine(row) || "No jobs or internships on the resume."}</p>
          {read ? (
            <p className="text-muted-foreground">
              {[read.education.degree, read.education.institution, read.education.year].filter(Boolean).join(" · ") || "Education not read"}
            </p>
          ) : null}
        </Section>
      </div>

      {row.trust ? (
        <Section title="Trust" aside={`${row.trust.score}/100 · ${row.trust.band}`}>
          {row.trust.summary ? <p className="text-muted-foreground">{row.trust.summary}</p> : null}
          <ul className="space-y-0.5">
            {row.trust.checks.map((x, i) => (
              <li key={i} className={cn(x.points < 0 && "text-destructive")}>
                <span className="font-medium">{x.label}</span>
                {x.points ? ` (${x.points})` : ""} — <span className="text-muted-foreground">{x.detail}</span>
                {x.source === "agent" ? <span className="text-xs text-muted-foreground"> · trust agent</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {[
          row.rec.screen?.links.githubProfile ? `GitHub ${row.rec.screen.links.githubProfile.replace(/^https?:\/\//, "")}` : "",
          row.rec.probe?.status === "ok" ? `${row.rec.probe.repos.length} own repos` : "",
          read ? `read by ${read.model}` : "",
          row.rec.screen?.fromSheet.length ? `from the sheet: ${row.rec.screen.fromSheet.join(", ")}` : "",
          ...(read?.checks.slice(0, 4) ?? []),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </div>
  );
}

export function ShowcaseResults({
  title,
  dataset,
  records,
  rules,
  onRulesChange,
  rejected,
  onToggleReject,
  running,
  progress,
  concurrency,
  onConcurrencyChange,
  onRun,
  onStop,
  onReload,
  reloading,
  reloadError,
  storageError,
}: Props) {
  const outcome = React.useMemo(() => rankShowcase(dataset, records, rules, rejected), [dataset, records, rules, rejected]);
  const plan = React.useMemo(() => planShowcase(outcome, rules), [outcome, rules]);
  const s = outcome.stats;
  const work = SP_LANES.map((lane) => ({ lane, n: laneSize(plan, lane) })).filter((x) => x.n > 0);
  const left = work.reduce((n, x) => n + x.n, 0);
  const minutes = work.reduce((m, x) => m + laneMinutes(x.lane, x.n), 0);

  const [view, setView] = React.useState<View | null>(null);
  const active: View = view ?? (outcome.tabs[0] ? { kind: "role", role: outcome.tabs[0].role } : { kind: "all" });
  const tab = active.kind === "role" ? outcome.tabs.find((t) => t.role === active.role) : undefined;
  const [query, setQuery] = React.useState("");
  const [stageFilter, setStageFilter] = React.useState<SpStage | "">("");
  const [page, setPage] = React.useState(0);
  const [open, setOpen] = React.useState<string | null>(null);
  const viewKey = active.kind === "role" ? `role:${active.role}` : active.kind;
  React.useEffect(() => setPage(0), [viewKey, query, stageFilter]);

  const base: SpRanked[] =
    active.kind === "role"
      ? [...(tab?.rows ?? []), ...outcome.rows.filter((r) => r.rejected && r.tier && (r.primary?.role === active.role || (active.role === "sde" && r.sde)))]
      : active.kind === "near"
        ? outcome.rows.filter((r) => r.status === "Near miss").sort((a, b) => ((b.primary ?? b.fits[0])?.raw ?? 0) - ((a.primary ?? a.fits[0])?.raw ?? 0))
        : outcome.rows.filter((r) => !stageFilter || r.stage === stageFilter);
  const q = query.trim().toLowerCase();
  const visible = base.filter((r) => !q || r.c.name.toLowerCase().includes(q) || r.c.email.includes(q) || r.c.mobile.includes(q) || r.candidateId.toLowerCase().includes(q));
  const pages = Math.max(1, Math.ceil(visible.length / PAGE));
  const pageRows = visible.slice(page * PAGE, page * PAGE + PAGE);
  const shownIds = new Set(tab?.shown.map((r) => r.c.id) ?? []);

  const companyName = `${slugify(title)}-sample-profiles-company.xlsx`;
  const downloadCompany = () => download(companyName, buildCompanyWorkbook(outcome, rules) as BlobPart, XLSX);
  const downloadInternal = () => download(`${slugify(title)}-sample-profiles-internal.xlsx`, buildInternalWorkbook(title, dataset, outcome, rules) as BlobPart, XLSX);
  const downloadCsv = (audience: "company" | "internal") => {
    if (!tab) return;
    download(`${slugify(title)}-${slug(tab.label)}-${audience}.csv`, buildRoleCsv(tab, audience, rules), "text/csv;charset=utf-8;");
  };
  const complete = !running && left === 0;
  const profiles = s.showcase + s.strong;

  return (
    <div className="space-y-6">
      {storageError ? <Notice tone="warning">{storageError}</Notice> : null}
      {reloadError ? <Notice tone="danger">{reloadError}</Notice> : null}
      {dataset.warnings.map((w) => (
        <Notice key={w} tone="warning">
          {w}
        </Notice>
      ))}

      <Panel
        icon={<Award />}
        title={title}
        description={`${dataset.source.title} › ${dataset.source.tab} · ${dataset.candidates.length} rows · read ${dataset.loadedAt.slice(0, 16).replace("T", " ")}`}
        actions={
          <Button variant="outline" size="sm" onClick={onReload} disabled={running || reloading}>
            {reloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Reload sheet
          </Button>
        }
      >
        <div className="space-y-3">
          {running && progress ? (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="inline-flex items-center gap-2 font-medium text-foreground">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden />
                  {SP_LANE_LABEL[progress.lane]} —{" "}
                  <span className="tabular-nums">
                    {progress.done} of {progress.total}
                  </span>
                </span>
                <span className="tabular-nums text-muted-foreground">{progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%</span>
              </div>
              <Progress value={progress.done} max={Math.max(1, progress.total)} label={SP_LANE_LABEL[progress.lane]} />
              <p className="text-[13px] text-muted-foreground" aria-live="polite">
                {progress.running} running{progress.waiting ? ` · ${progress.waiting} waiting to retry` : ""}
                {progress.note ? ` · ${progress.note}` : ""}
              </p>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-1.5 text-[13px]" aria-label="Work left by stage">
            {work.length ? (
              work.map((x) => (
                <Badge key={x.lane} variant={progress?.lane === x.lane && running ? "default" : "secondary"}>
                  {SP_LANE_LABEL[x.lane]} <span className="tabular-nums">{x.n}</span>
                </Badge>
              ))
            ) : (
              <Badge variant="success">
                <CircleCheck aria-hidden /> Every row went as far as the rules allow
              </Badge>
            )}
          </div>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <label htmlFor="sp-run-conc">Resumes in parallel</label>
              <NativeSelect id="sp-run-conc" value={concurrency} disabled={running} onChange={(e) => onConcurrencyChange(Number(e.target.value))} className="h-8 text-[13px]">
                {SP_CONCURRENCY_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n} at a time
                  </option>
                ))}
              </NativeSelect>
              <InfoHint label="About the stages" align="start">
                Cheap and strict first: every resume is screened (links, no model); the DSA bar is read Codeforces → LeetCode → CodeChef and
                stops at the first that clears; GitHub accounts are checked in one query each; only then is the resume read by a model; only
                candidates with 2 strong projects get the deep GitHub proof; only those still in get the trust check. Everything is saved as it
                arrives and reused for 24 hours, so a stop or a refresh loses nothing.
              </InfoHint>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              {running ? (
                <Button variant="outline" onClick={onStop}>
                  <Square className="h-4 w-4" /> Stop (finish in-flight)
                </Button>
              ) : left ? (
                <Button onClick={onRun}>
                  <Play className="h-4 w-4" /> {s.screened ? "Continue" : "Start"} — {left} step{left === 1 ? "" : "s"} · about {minutes < 60 ? `${Math.max(1, minutes)} min` : `${(minutes / 60).toFixed(1)} h`}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </Panel>

      <StatGrid cols={6}>
        <Stat icon={<Award />} label="Showcase" value={s.showcase} tone="highlight" hint="the very top" />
        <Stat icon={<CircleCheck />} label="Strong" value={s.strong} hint={`${outcome.tabs.length} role${outcome.tabs.length === 1 ? "" : "s"}`} />
        <Stat icon={<Sparkles />} label="Near misses" value={s.nearMiss} tone={s.nearMiss ? "warning" : "default"} hint="one check short" />
        <Stat label="DSA bar cleared" value={s.dsaPassed} hint={`of ${s.screened} screened`} />
        <Stat label="Resumes read" value={s.read} hint="DSA + GitHub survivors" />
        <Stat icon={<Clock />} label="Pending" value={s.pending} tone={s.pending ? "primary" : "default"} hint={`of ${s.rows} rows`} />
      </StatGrid>

      <Panel title="Funnel" description="Where every row stopped. Select a stage in “All rows” to see who and why.">
        <div className="grid gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {SP_STAGES.map((st) => {
            const f = outcome.funnel[st];
            return (
              <button
                key={st}
                type="button"
                onClick={() => {
                  setView({ kind: "all" });
                  setStageFilter(st);
                }}
                className="rounded-lg border bg-card px-3 py-2 text-left text-[13px] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
              >
                <div className="font-medium">{st === "Score" ? "Scored" : st}</div>
                <div className="tabular-nums text-muted-foreground">{f.reached} reached</div>
                <div className="text-xs tabular-nums text-muted-foreground">
                  {f.stopped ? `${f.stopped} stopped` : ""}
                  {f.stopped && f.pending ? " · " : ""}
                  {f.pending ? `${f.pending} pending` : ""}
                </div>
              </button>
            );
          })}
        </div>
      </Panel>

      <SpDsaBarPanel rules={rules} onChange={onRulesChange} note={`${s.dsaPassed} clear it now. Changing it re-ranks instantly; profiles not read yet are read on Continue.`} />
      <SpRulesCard rules={rules} onChange={onRulesChange} />

      <Panel
        flush
        title={
          <span className="inline-flex items-center gap-1">
            Sample profiles by role
            <InfoHint label="How profiles are placed" align="start">
              A candidate&apos;s role comes from the evidence — the technologies each strong project names and its code proves — never from the
              resume&apos;s title. They are placed once, in the role of their strongest projects; the SDE tab lists every qualified candidate whose DSA
              also clears the SDE bar. Each tab is ranked by profile score; the company workbook takes the top {rules.topN}. Take a profile out by
              hand and the next one moves up.
            </InfoHint>
          </span>
        }
        description={
          profiles
            ? `${profiles} profile${profiles === 1 ? "" : "s"} across ${outcome.tabs.length} role${outcome.tabs.length === 1 ? "" : "s"}. Select a row for the evidence.`
            : "Profiles appear here as candidates pass every check."
        }
        footer={
          pages > 1 ? (
            <>
              <span className="flex-1 text-[13px] tabular-nums text-muted-foreground">
                {page * PAGE + 1}–{Math.min(visible.length, (page + 1) * PAGE)} of {visible.length}
              </span>
              <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button size="sm" variant="outline" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </>
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-center gap-2 border-t bg-muted/40 px-5 py-3">
          <Button size="sm" variant={complete && profiles ? "default" : "outline"} onClick={downloadCompany} disabled={!profiles}>
            <Download className="h-4 w-4" /> Company workbook (.xlsx)
          </Button>
          <Button size="sm" variant="outline" onClick={downloadInternal}>
            <Download className="h-4 w-4" /> Internal workbook (.xlsx)
          </Button>
          {tab ? (
            <>
              <Button size="sm" variant="outline" onClick={() => downloadCsv("company")}>
                <Download className="h-4 w-4" /> {tab.label} (CSV, company)
              </Button>
              <Button size="sm" variant="outline" onClick={() => downloadCsv("internal")}>
                <Download className="h-4 w-4" /> {tab.label} (CSV, internal)
              </Button>
            </>
          ) : null}
          <span className="text-xs text-muted-foreground">Company: Candidate IDs, no name / phone / email{rules.companyLinks ? "" : ", no profile links"}. Internal: everything, plus near misses and every row.</span>
        </div>

        <div className="flex flex-col gap-3 border-t px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
            {[
              ...outcome.tabs.map((t) => ({ key: `role:${t.role}`, label: t.label, count: t.rows.length, onClick: () => setView({ kind: "role", role: t.role }) })),
              { key: "near", label: "Near misses", count: s.nearMiss, onClick: () => setView({ kind: "near" }) },
              { key: "all", label: "All rows", count: s.rows, onClick: () => setView({ kind: "all" }) },
            ].map((t) => (
              <button
                key={t.key}
                type="button"
                aria-pressed={viewKey === t.key}
                onClick={t.onClick}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25",
                  viewKey === t.key ? "border-primary/40 bg-accent text-accent-foreground" : "bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {t.label} <span className="tabular-nums opacity-80">{t.count}</span>
              </button>
            ))}
          </div>
          <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
            {active.kind === "all" ? (
              <div className="flex items-center gap-2">
                <Filter className="h-4 w-4 text-muted-foreground" aria-hidden />
                <NativeSelect aria-label="Stopped at stage" value={stageFilter} onChange={(e) => setStageFilter(e.target.value as SpStage | "")} className="h-9 text-[13px]">
                  <option value="">Every stage</option>
                  {SP_STAGES.map((st) => (
                    <option key={st} value={st}>
                      Stopped at {st === "Score" ? "scoring" : st}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
            <div className="relative w-full shrink-0 lg:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input className="h-9 pl-9" placeholder="Search name, mobile, email, ID" aria-label="Search name, mobile, email or candidate ID" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>
        </div>

        {pageRows.length ? (
          <Table containerClassName="max-h-[75vh] border-t">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10">
                  <span className="sr-only">Details</span>
                </TableHead>
                {active.kind === "role" ? <TableHead className="w-14 text-right">Rank</TableHead> : null}
                <TableHead>Candidate</TableHead>
                <TableHead>{active.kind === "role" ? "Tier" : "Status"}</TableHead>
                <TableHead className="text-right">Score</TableHead>
                <TableHead>{active.kind === "role" ? "Profile" : "Why"}</TableHead>
                <TableHead>Trust</TableHead>
                {active.kind === "role" ? <TableHead className="text-right">Company file</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((row, i) => {
                const key = `${viewKey}:${row.c.id}`;
                const isOpen = open === key;
                const fit = active.kind === "role" && active.role !== "sde" ? (row.fits.find((f) => f.role === active.role) ?? row.primary) : (row.primary ?? row.fits[0]);
                const cols = active.kind === "role" ? 8 : 6;
                return (
                  <React.Fragment key={key}>
                    <TableRow className={cn("cursor-pointer", isOpen && "bg-accent/40", row.rejected && "opacity-60")} onClick={() => setOpen(isOpen ? null : key)}>
                      <TableCell className="w-10 pr-0 align-top text-muted-foreground">
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-label={isOpen ? "Hide details" : "Show details"}
                          className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
                        >
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                      </TableCell>
                      {active.kind === "role" ? <TableCell className="text-right align-top tabular-nums">{row.rejected ? "—" : page * PAGE + i + 1}</TableCell> : null}
                      <TableCell className="align-top">
                        <div className="max-w-[220px] truncate font-medium" title={row.c.name || undefined}>
                          {row.c.name || <span className="text-muted-foreground">—</span>}
                        </div>
                        <div className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                          {row.candidateId || `row ${row.c.sheetRow}`} · {row.c.mobile || row.c.email}
                        </div>
                        {row.c.resumeUrl ? (
                          <a
                            href={row.c.resumeUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 rounded-sm text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
                          >
                            Resume <ExternalLink className="h-3 w-3" aria-hidden />
                          </a>
                        ) : null}
                      </TableCell>
                      <TableCell className="align-top">
                        <StatusBadge row={row} />
                        {active.kind !== "role" ? <div className="mt-0.5 text-[11px] text-muted-foreground">at {row.stage === "Score" ? "scoring" : row.stage}</div> : null}
                        {active.kind === "role" && row.tier && !shownIds.has(row.c.id) && !row.rejected ? <div className="mt-0.5 text-[11px] text-muted-foreground">beyond top {rules.topN}</div> : null}
                      </TableCell>
                      <TableCell className="text-right align-top">
                        {fit ? (
                          <>
                            <div className="text-[15px] font-semibold tabular-nums">{fit.score}</div>
                            <div className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground" title="Projects · DSA · GitHub · experience">
                              {fit.parts.projects} · {fit.parts.dsa} · {fit.parts.engineering} · {fit.parts.experience}
                            </div>
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="min-w-[240px] max-w-[420px] align-top text-xs">
                        {active.kind === "role" ? (
                          <>
                            <div className="font-medium text-foreground">{dsaHeadline(row)}</div>
                            <div className="text-muted-foreground">
                              {fit?.verifiedStrong.map((x) => x.p.title).join(" · ") || "—"}
                              {fit && fit.strong.length > fit.verifiedStrong.length ? ` (+${fit.strong.length - fit.verifiedStrong.length} strong, unproven)` : ""}
                            </div>
                            {fit?.experience.months ? <div className="text-muted-foreground">{fit.experience.months} months in-role experience</div> : null}
                            {row.reason ? <div className="text-warning">{row.reason}</div> : null}
                          </>
                        ) : (
                          <>
                            {fit ? <div className="font-medium text-foreground">{fit.label}</div> : null}
                            <div className="line-clamp-3 text-muted-foreground">{row.tier ? headline(row) : row.reason}</div>
                          </>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <TrustBadge trust={row.trust} />
                      </TableCell>
                      {active.kind === "role" ? (
                        <TableCell className="text-right align-top">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleReject(row.c.id);
                            }}
                            title={row.rejected ? "Put back into the company workbook" : "Leave out of the company workbook"}
                          >
                            {row.rejected ? <Undo2 className="h-4 w-4" /> : <UserMinus className="h-4 w-4" />}
                            {row.rejected ? "Put back" : "Take out"}
                          </Button>
                        </TableCell>
                      ) : null}
                    </TableRow>
                    {isOpen ? (
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableCell colSpan={cols} className="py-4">
                          <Details row={row} />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <div className="border-t p-5">
            <EmptyState
              icon={running ? <Loader2 className="animate-spin" /> : <Search />}
              title={running ? "Working through the stages…" : active.kind === "role" ? "No profiles in this role." : "No rows in this view."}
              description={running ? "Profiles appear as candidates pass every check." : "Pick another tab, stage or clear the search."}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}
