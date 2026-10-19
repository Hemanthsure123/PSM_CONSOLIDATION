"use client";

import * as React from "react";
import {
  Award,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  FileWarning,
  Loader2,
  Play,
  RotateCcw,
  Search,
  SearchX,
  SlidersHorizontal,
  Square,
  TriangleAlert,
  Users,
  XCircle,
} from "lucide-react";
import { ActionBar } from "@/components/ui/action-bar";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { Panel } from "@/components/ui/panel";
import { Progress } from "@/components/ui/progress";
import { NativeSelect } from "@/components/ui/select";
import { SettingList, SettingRow } from "@/components/ui/setting-row";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SERIES } from "@/components/charts";
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

/** Status → badge. Highlighter only for the shortlist; status colours only for status meaning. */
const STATUS_BADGE: Record<QaStatus, NonNullable<BadgeProps["variant"]>> = {
  Shortlisted: "highlight",
  "Qualified – Outside Top N": "default",
  "Borderline – Review": "warning",
  "Unverified – Re-screen": "warning",
  "Not Shortlisted": "secondary",
  "Not QA – No Testing Terms": "outline",
  "Invalid – Not a Resume": "destructive",
  Error: "destructive",
  Pending: "secondary",
};

/** Fixed series slot per resume section — the same section always gets the same colour. */
const SECTION_COLOR: Record<QaSection, string> = {
  skills: SERIES[0],
  projects: SERIES[1],
  experience: SERIES[2],
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

/** Small coloured square identifying a resume section (the text beside it carries the name). */
function SectionSwatch({ s, className }: { s: QaSection; className?: string }) {
  return <span aria-hidden className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]", className)} style={{ backgroundColor: SECTION_COLOR[s] }} />;
}

/**
 * A collapsible section that keeps its content mounted while closed (so a half-pasted batch
 * survives collapsing). Styled to match the shared `Disclosure`.
 */
function KeepMountedDisclosure({ title, summary, children }: { title: React.ReactNode; summary?: React.ReactNode; children: React.ReactNode }) {
  return (
    <details className="group rounded-xl border bg-card shadow-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-5 py-3.5 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25 [&::-webkit-details-marker]:hidden">
        <span className="font-display text-[15px] font-semibold tracking-[-0.01em]">{title}</span>
        <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
          {summary ? <span className="hidden sm:inline group-open:!hidden">{summary}</span> : null}
          <ChevronDown className="h-4 w-4 transition-transform duration-150 group-open:rotate-180" />
        </span>
      </summary>
      <div className="animate-fade-in border-t px-5 py-4">{children}</div>
    </details>
  );
}

/** Five mandatory items × Skills / Projects / Experience, one square each. */
function Matrix({ r }: { r: QaEvaluation }) {
  return (
    <div className="flex gap-2">
      {MANDATORY.map((d) => {
        const q = r.mandatory[d.key];
        const tip = QA_SECTIONS.map((s) => `${SECTION_LABEL[s]}: ${q?.[s] ? `"${q[s]}"` : "—"}`).join("\n");
        return (
          <div key={d.key} className="flex flex-col items-center gap-1" title={`${d.label}\n${tip}`}>
            <span className="text-[10px] font-medium leading-none text-muted-foreground">{SHORT[d.key]}</span>
            <div className="flex gap-0.5">
              {QA_SECTIONS.map((s) =>
                q?.[s] ? <SectionSwatch key={s} s={s} /> : <span key={s} aria-hidden className="h-2.5 w-2.5 rounded-[3px] bg-input/70" />,
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DetailHeading({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] font-semibold text-foreground">{children}</p>;
}

function Details({ row }: { row: QaRanked }) {
  const r = row.result;
  if (!r) return null;
  if (r.status === "error") return <p className="text-[13px] text-destructive">{r.error}</p>;
  const gth = GOOD_TO_HAVE.filter((d) => r.goodToHave[d.key]);
  return (
    <div className="grid gap-6 text-[13px] leading-relaxed lg:grid-cols-2">
      <div className="min-w-0 space-y-3">
        <DetailHeading>Mandatory evidence (exact resume words)</DetailHeading>
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Item</th>
                {QA_SECTIONS.map((s) => (
                  <th key={s} className="px-3 py-2 font-medium">
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                      <SectionSwatch s={s} className="h-2 w-2 rounded-[2px]" />
                      {SECTION_LABEL[s]} <span className="font-normal tabular-nums">({SECTION_POINTS[s]})</span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MANDATORY.map((d) => (
                <tr key={d.key} className="border-t align-top">
                  <td className="whitespace-nowrap px-3 py-2 font-medium">{d.label}</td>
                  {QA_SECTIONS.map((s) => (
                    <td key={s} className="px-3 py-2">
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
        </div>
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

      <div className="min-w-0 space-y-4">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <DetailHeading>
              Good-to-have (<span className="tabular-nums">{gth.length}</span>)
            </DetailHeading>
            {gth.length ? (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="h-2.5 w-2.5 rounded-[3px] bg-accent ring-1 ring-primary/30" /> In a project or job
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="h-2.5 w-2.5 rounded-[3px] border border-border bg-card" /> Skills list only
                </span>
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {gth.length ? (
              gth.map((d) => {
                const q = r.goodToHave[d.key];
                const secs = QA_SECTIONS.filter((s) => q[s]);
                return (
                  <Badge
                    key={d.key}
                    variant={secs.some((s) => s !== "skills") ? "default" : "outline"}
                    title={secs.map((s) => `${SECTION_LABEL[s]}: "${q[s]}"`).join("\n")}
                  >
                    {d.label}
                  </Badge>
                );
              })
            ) : (
              <span className="text-muted-foreground">None found.</span>
            )}
          </div>
        </div>
        {r.qaProjects.length ? (
          <div className="space-y-1.5">
            <DetailHeading>QA / testing projects</DetailHeading>
            <ul className="list-disc space-y-1 pl-4 marker:text-muted-foreground">
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
          <div className="space-y-1.5">
            <DetailHeading>QA / testing internships &amp; jobs</DetailHeading>
            <ul className="list-disc space-y-1 pl-4 marker:text-muted-foreground">
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
          <div className="space-y-1.5">
            <DetailHeading>Verification notes</DetailHeading>
            <ul className="list-disc space-y-1 pl-4 text-muted-foreground marker:text-muted-foreground">
              {r.checks.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="border-t pt-3 text-xs text-muted-foreground">
          {r.model ? `Read by ${r.model}` : "No model needed"} · {r.source || "—"} ·{" "}
          {r.evidenceVerified ? "quotes checked against the resume text" : "scanned resume — quotes not text-verified"} ·{" "}
          <span className="tabular-nums">{(r.durationMs / 1000).toFixed(1)}s</span>
        </p>
      </div>
    </div>
  );
}

/** How the score is built — shown on demand next to the minimum score. */
function ScoreHelp() {
  return (
    <>
      Each mandatory item is worth 20: Skills {SECTION_POINTS.skills}, Projects {SECTION_POINTS.projects}, Experience{" "}
      {SECTION_POINTS.experience}. 100% only when all five are in all three sections (otherwise capped at 99%). Good-to-have
      adds +2 per item shown in a project or job, +1 if only in the skills list, and +2 for a QA / automation project or
      internship.
    </>
  );
}

/** The shortlist rule controls (shared by the setup Panel and the results disclosure). */
function RulesFields({ rules, onChange, disabled }: { rules: QaRules; onChange: (r: QaRules) => void; disabled?: boolean }) {
  const set = (patch: Partial<QaRules>) => onChange({ ...rules, ...patch });
  const num = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Minimum final score (%)" htmlFor="qa-min" hint="60 ≈ every mandatory item in Skills + a testing project." info={<ScoreHelp />}>
          <Input
            id="qa-min"
            type="number"
            min={0}
            max={200}
            className="tabular-nums"
            value={rules.minScore}
            disabled={disabled}
            onChange={(e) => set({ minScore: num(e.target.value, 0, 200) })}
          />
        </Field>
        <Field label="Keep only the top N" htmlFor="qa-top" hint="0 = no cap.">
          <Input
            id="qa-top"
            type="number"
            min={0}
            className="tabular-nums"
            value={rules.topN}
            disabled={disabled}
            onChange={(e) => set({ topN: num(e.target.value, 0, 100_000) })}
          />
        </Field>
      </div>
      <SettingList className="border-t pt-3">
        {(
          [
            ["requireAllMandatory", "All 5 mandatory present", "QA, Software Testing, Manual, Automated, Selenium — each in at least one section."],
            ["requireHandsOn", "Hands-on QA required", "A testing project or a QA / testing internship, not just a skills list."],
            ["requireQaExperience", "QA internship / job required", "Only candidates with QA / testing work experience."],
          ] as const
        ).map(([key, label, hint]) => (
          <SettingRow
            key={key}
            id={`qa-rule-${key}`}
            title={label}
            description={hint}
            checked={rules[key]}
            disabled={disabled}
            onCheckedChange={(v) => set({ [key]: v } as Partial<QaRules>)}
          />
        ))}
      </SettingList>
    </div>
  );
}

export function RulesCard({ rules, onChange, disabled }: { rules: QaRules; onChange: (r: QaRules) => void; disabled?: boolean }) {
  return (
    <Panel
      title="Shortlist rules"
      description="Changing a rule re-ranks at once. No resume is read again."
      icon={<SlidersHorizontal />}
    >
      <RulesFields rules={rules} onChange={onChange} disabled={disabled} />
    </Panel>
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

  // Presentation only: once nothing is left to screen, the shortlist download is the next step.
  const finished = !running && !pending.length;

  return (
    <div className="space-y-6">
      {/* The run being viewed (the page title comes from the app shell). */}
      <div className="min-w-0">
        <h2 className="truncate font-display text-[18px] font-semibold leading-7" title={title}>
          {title}
        </h2>
        <p className="text-[13px] text-muted-foreground">
          <span className="tabular-nums">{candidates.length}</span> candidates in <span className="tabular-nums">{batches.length}</span> batch
          {batches.length === 1 ? "" : "es"}
        </p>
      </div>

      {storageError ? <Notice tone="danger">{storageError}</Notice> : null}

      {stale.length ? (
        <Notice
          tone="warning"
          title={
            <>
              <span className="tabular-nums">{stale.length}</span> result{stale.length === 1 ? " was" : "s were"} screened before the
              latest accuracy checks.
            </>
          }
        >
          <p>
            Unverified results can&apos;t be shortlisted until re-screened.{" "}
            <InfoHint label="What the latest checks do">
              Those checks identify the uploaded file first (photos, ID cards and certificates are no longer read as resumes),
              verify image / scanned resumes against their transcription, and count one mention for one section only.
            </InfoHint>
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {unverified.length && unverified.length < stale.length ? (
              <Button variant="outline" size="sm" disabled={running} onClick={() => onRun(unverified)}>
                <RotateCcw className="h-4 w-4" /> Re-screen {unverified.length} unverified first
              </Button>
            ) : null}
            <Button variant="outline" size="sm" disabled={running} onClick={() => onRun(stale)}>
              <RotateCcw className="h-4 w-4" /> Re-screen {stale.length === unverified.length ? "" : "all "}
              {stale.length}
            </Button>
          </div>
        </Notice>
      ) : null}

      <StatGrid cols={4}>
        <Stat icon={<Users />} label="Screened" value={sum.evaluated} hint={`of ${candidates.length} candidates`} />
        <Stat
          icon={<Award />}
          label="Shortlisted"
          value={sum.shortlisted}
          tone="highlight"
          hint={`Minimum score ${rules.minScore}%${rules.topN > 0 ? ` · top ${rules.topN}` : ""}`}
        />
        <Stat icon={<TriangleAlert />} label="Borderline" value={sum.borderline} tone={sum.borderline ? "warning" : "default"} />
        <Stat
          icon={<XCircle />}
          label="Not shortlisted"
          value={sum.notShortlisted + sum.outsideTopN}
          hint={sum.outsideTopN ? `Includes ${sum.outsideTopN} outside the top ${rules.topN}` : undefined}
        />
        <Stat icon={<Ban />} label="Not QA" value={sum.notQa} />
        <Stat icon={<FileWarning />} label="Not a resume" value={sum.invalid} />
        <Stat icon={<TriangleAlert />} label="Errors" value={sum.errors} tone={sum.errors ? "danger" : "default"} />
        <Stat icon={<Clock />} label="Pending" value={sum.pending} />
      </StatGrid>

      <div className="grid gap-4">
        <Disclosure
          title="Shortlist rules"
          summary={`Minimum ${rules.minScore}% · ${rules.topN > 0 ? `top ${rules.topN} only` : "no top-N cap"}`}
        >
          <p className="mb-4 text-[13px] text-muted-foreground">Changing a rule re-ranks at once. No resume is read again.</p>
          <RulesFields rules={rules} onChange={onRulesChange} />
        </Disclosure>

        <KeepMountedDisclosure title={`Add batch ${nextBatch}`} summary="Paste more candidates into this run">
          <div className="space-y-3">
            <p className="text-[13px] text-muted-foreground">
              Mobile numbers already in this run are skipped. The ranking and downloads cover every batch together, or pick one
              batch next to the downloads.
            </p>
            <QaPaste key={pasteKey} batch={nextBatch} existing={existing} onParsed={setNewRows} />
            <div className="flex justify-end">
              <Button
                variant="soft"
                disabled={!newRows.length}
                onClick={() => {
                  onAddBatch(newRows);
                  setNewRows([]);
                  setPasteKey((k) => k + 1);
                }}
              >
                <Play className="h-4 w-4" /> Add {newRows.length || ""} &amp; screen
              </Button>
            </div>
          </div>
        </KeepMountedDisclosure>
      </div>

      <Panel
        flush
        title="Ranking"
        description="Select a row to see the full evidence."
        actions={
          <>
            <NativeSelect
              value={String(scope)}
              onChange={(e) => setScope(e.target.value === "all" ? "all" : Number(e.target.value))}
              className="h-9 w-auto text-[13px]"
              aria-label="Download scope"
            >
              <option value="all">All batches</option>
              {batches.map((b) => (
                <option key={b.n} value={b.n}>
                  Batch {b.n} ({b.count})
                </option>
              ))}
            </NativeSelect>
            <Button
              variant="outline"
              className="h-9"
              disabled={!done}
              title="CSV file"
              onClick={() => download(`${slugify(title)}-complete-ranking${suffix}-${scoped.length}.csv`, buildQaCsv(scoped))}
            >
              <Download className="h-4 w-4" /> Download ranking (<span className="tabular-nums">{scoped.length}</span>)
            </Button>
            <Button
              variant={finished ? "default" : "outline"}
              className="h-9"
              disabled={!shortlisted.length}
              title="CSV file"
              onClick={() => download(`${slugify(title)}-shortlisted${suffix}-${shortlisted.length}.csv`, buildQaCsv(shortlisted))}
            >
              <Download className="h-4 w-4" /> Download shortlist (<span className="tabular-nums">{shortlisted.length}</span>)
            </Button>
          </>
        }
        footer={
          pages > 1 ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-3 text-[13px] text-muted-foreground">
              <span className="tabular-nums">
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
          ) : undefined
        }
      >
        {/* Toolbar: status filters, search and the matrix legend. */}
        <div className="space-y-3 border-t px-5 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1.5">
              {tabs.map(([key, label, n]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25",
                    filter === key
                      ? "border-primary/40 bg-accent text-accent-foreground"
                      : "border-input bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  {label} <span className="text-xs tabular-nums opacity-80">{n}</span>
                </button>
              ))}
            </div>
            <div className="relative w-full lg:w-64 lg:shrink-0">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-9 pl-9"
                placeholder="Search mobile or name"
                aria-label="Search mobile or name"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>Mandatory per section:</span>
            {QA_SECTIONS.map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                <SectionSwatch s={s} /> {SECTION_LABEL[s]}
              </span>
            ))}
            <span aria-hidden>·</span>
            <span>QA · ST Software Testing · MT Manual · AT Automated · Sel Selenium</span>
            <InfoHint label="How to read the mandatory column" align="end">
              Each mandatory item shows three squares: Skills, Projects and Experience. A filled square means the resume shows the
              item in that section. Hover the squares for the quotes, or select a row for the full evidence.
            </InfoHint>
          </div>
        </div>

        <Table containerClassName={cn("max-h-[75vh] border-t", pages > 1 ? "" : "rounded-b-xl")}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10">
                <span className="sr-only">Evidence</span>
              </TableHead>
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
              const displayName = row.candidate.name || r?.name;
              return (
                <React.Fragment key={row.id}>
                  <TableRow
                    data-state={isOpen ? "selected" : undefined}
                    className={cn(expandable && "cursor-pointer")}
                    onClick={() => expandable && setOpen(isOpen ? null : row.id)}
                  >
                    <TableCell className="text-muted-foreground">
                      {expandable ? (
                        // No handler of its own: the click reaches the row, which toggles the evidence.
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-label={isOpen ? "Hide evidence" : "Show evidence"}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
                        >
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.rank || "—"}
                      {row.shortlistRank ? (
                        <div className="mt-1">
                          <span className="rounded-[4px] bg-highlight px-1 text-[11px] font-medium text-highlight-foreground">
                            #{row.shortlistRank} SL
                          </span>
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-[240px]">
                      <div className="truncate font-medium" title={displayName || undefined}>
                        {displayName || <span className="text-muted-foreground">—</span>}
                      </div>
                      <div className="text-xs tabular-nums text-muted-foreground">
                        {row.candidate.mobile} · B{row.candidate.batch}
                      </div>
                      {/^https?:\/\//i.test(row.candidate.resumeUrl) ? (
                        <a
                          href={row.candidate.resumeUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 rounded-sm text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
                        >
                          Resume <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-[240px]">
                      <Badge variant={STATUS_BADGE[row.status]}>{row.status}</Badge>
                      {row.reasons.length && row.status !== "Shortlisted" ? (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground" title={row.reasons.join("\n")}>
                          {row.reasons.join(" · ")}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      {s && r?.status === "ok" ? (
                        <>
                          <div className="text-[15px] font-semibold tabular-nums">{s.finalScore}%</div>
                          <div className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
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
                          <span className="font-semibold tabular-nums">{s.goodToHave.length}</span>
                          <span className="text-muted-foreground">
                            {" "}
                            — {s.goodToHave.slice(0, 4).join(", ")}
                            {s.goodToHave.length > 4 ? "…" : ""}
                          </span>
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-[260px] text-xs">
                      {r?.status === "ok" ? (
                        <>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="secondary" className="px-1.5 text-[11px] leading-4">
                              {r.qaFocus}
                            </Badge>
                            <span className="min-w-0">{r.primaryProfile}</span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-muted-foreground" title={r.remarks}>
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
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell colSpan={8} className="px-5 py-4">
                        <Details row={row} />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </React.Fragment>
              );
            })}
            {!pageRows.length ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="p-4">
                  {running && !done ? (
                    <EmptyState
                      className="border-0 bg-transparent py-10"
                      icon={<Loader2 className="animate-spin" />}
                      title="Reading the first resumes…"
                      description="Candidates appear here as each resume is screened."
                    />
                  ) : (
                    <EmptyState
                      className="border-0 bg-transparent py-10"
                      icon={<SearchX />}
                      title="No candidates in this view"
                      description="Pick another status or clear the search."
                    />
                  )}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </Panel>

      <ActionBar
        status={
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-2 font-medium text-foreground">
                {running ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : null}
                <span className="tabular-nums">
                  {done} of {candidates.length} resumes screened{eta}
                </span>
              </span>
              <span className="tabular-nums">{pct}%</span>
            </div>
            <Progress value={pct} max={100} label="Resumes screened" tone={finished ? "success" : "primary"} />
            {running ? (
              <p className="tabular-nums">
                Reading {active} resume{active === 1 ? "" : "s"}
                {retrying ? ` · ${retrying} waiting to retry after a rate limit` : ""}…
              </p>
            ) : null}
          </div>
        }
      >
        <div className="flex items-center gap-2">
          <label htmlFor="qa-parallel" className="text-[13px] text-muted-foreground">
            Parallel
          </label>
          <NativeSelect
            id="qa-parallel"
            value={concurrency}
            disabled={running}
            onChange={(e) => onConcurrencyChange(Number(e.target.value))}
            className="h-9 w-auto text-[13px]"
          >
            {CONCURRENCY_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} at a time
              </option>
            ))}
          </NativeSelect>
        </div>
        {!running && failed.length ? (
          <Button variant="outline" onClick={() => onRun(failed)}>
            <RotateCcw className="h-4 w-4" /> Re-run {failed.length} failed
          </Button>
        ) : null}
        {running ? (
          <Button variant="outline" onClick={onStop}>
            <Square className="h-4 w-4" /> Stop (finish in-flight)
          </Button>
        ) : pending.length ? (
          <Button onClick={() => onRun(pending)}>
            <Play className="h-4 w-4" /> {done ? `Resume — ${pending.length} left` : `Screen ${pending.length} resumes`}
          </Button>
        ) : (
          <Badge variant="success" className="h-9 px-3 text-[13px]">
            <CheckCircle2 className="!size-4" /> All {candidates.length} resumes screened
          </Badge>
        )}
      </ActionBar>
    </div>
  );
}
