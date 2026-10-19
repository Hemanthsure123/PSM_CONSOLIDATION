"use client";

import * as React from "react";
import {
  Award,
  Ban,
  Briefcase,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock3,
  Download,
  ExternalLink,
  FilePlus2,
  FileWarning,
  ListOrdered,
  Loader2,
  Play,
  RotateCcw,
  Search,
  Square,
  TriangleAlert,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeProps } from "@/components/ui/badge";
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
import { QaPaste } from "@/components/qa-screening/qa-paste";
import { QA_SECTIONS, SECTION_LABEL } from "@/lib/qa-types";
import { buildZgCsv, jobPeriod } from "@/lib/zaggle/csv";
import { formatMonths } from "@/lib/zaggle/dates";
import {
  MANDATORY_LABEL,
  POINTS,
  rankZg,
  summarizeZg,
  type MandatoryId,
  type ZgRanked,
  type ZgScore,
  type ZgStatus,
} from "@/lib/zaggle/scoring";
import {
  COMPANY_TYPE_LABEL,
  ROLE_FOCUS_LABEL,
  ZAGGLE_ROLE,
  ZG_CHECKS_VERSION,
  ZG_GOOD_TO_HAVE,
  ZG_SKILLS,
  type ZgBatch,
  type ZgCandidateInput,
  type ZgEvaluation,
  type ZgRules,
} from "@/lib/zaggle/types";
import { cn, slugify } from "@/lib/utils";

export const ZG_CONCURRENCY_OPTIONS = [4, 6, 8, 10, 12, 16];

interface Props {
  title: string;
  candidates: ZgCandidateInput[];
  results: Record<string, ZgEvaluation>;
  rules: ZgRules;
  onRulesChange: (rules: ZgRules) => void;
  batches: ZgBatch[];
  running: boolean;
  active: number;
  retrying: number;
  concurrency: number;
  onConcurrencyChange: (n: number) => void;
  onRun: (targets: ZgCandidateInput[]) => void;
  onStop: () => void;
  onBack: () => void;
  onAddBatch: (candidates: ZgCandidateInput[]) => void;
  storageError: string;
}

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

/** Each status as a badge: a variant plus an icon, so the meaning never rests on colour alone. */
const STATUS_BADGE: Record<ZgStatus, { variant: BadgeVariant; icon: LucideIcon }> = {
  Shortlisted: { variant: "highlight", icon: Award },
  "Qualified – Outside Top N": { variant: "default", icon: CircleCheck },
  "Review – Check Manually": { variant: "warning", icon: TriangleAlert },
  "Not Shortlisted": { variant: "secondary", icon: CircleX },
  "No Relevant Full-time Experience": { variant: "secondary", icon: Ban },
  "Invalid – Not a Resume": { variant: "destructive", icon: FileWarning },
  Error: { variant: "destructive", icon: CircleAlert },
  Pending: { variant: "outline", icon: Clock3 },
};

/** Short labels for the seven mandatory checks in the table. */
const SHORT: Record<MandatoryId, string> = {
  backend_language: "Lang",
  dsa: "DSA",
  apis: "API",
  sql: "SQL",
  experience: "1 yr",
  product: "Prod",
  noServices: "No IT-svc",
};

type CheckState = "met" | "unclear" | "missing";

const CHECK_UI: Record<CheckState, { variant: BadgeVariant; icon: LucideIcon; word: string }> = {
  met: { variant: "success", icon: Check, word: "met" },
  unclear: { variant: "warning", icon: CircleHelp, word: "unclear" },
  missing: { variant: "destructive", icon: X, word: "missing" },
};

/** Met, unclear (product company only) or missing — the same reading the table always used. */
function checkState(s: ZgScore, k: MandatoryId): CheckState {
  if (s.met[k]) return "met";
  return k === "product" && s.productUnclear ? "unclear" : "missing";
}

type Filter = ZgStatus | "all";
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

function StatusBadge({ status }: { status: ZgStatus }) {
  const ui = STATUS_BADGE[status];
  const Icon = ui.icon;
  return (
    <Badge variant={ui.variant}>
      <Icon aria-hidden />
      {status}
    </Badge>
  );
}

function Mandatory({ row }: { row: ZgRanked }) {
  const s = row.score;
  if (!s) return null;
  return (
    <div className="flex min-w-[170px] max-w-[250px] flex-wrap gap-1">
      {(Object.keys(MANDATORY_LABEL) as MandatoryId[]).map((k) => {
        const ui = CHECK_UI[checkState(s, k)];
        const Icon = ui.icon;
        return (
          <Badge key={k} variant={ui.variant} title={`${MANDATORY_LABEL[k]}: ${ui.word}`} className="gap-0.5 px-1.5 text-[11px] leading-[18px]">
            <Icon aria-hidden />
            {SHORT[k]}
            <span className="sr-only"> {ui.word}</span>
          </Badge>
        );
      })}
    </div>
  );
}

function DetailSection({
  title,
  aside,
  info,
  children,
}: {
  title: React.ReactNode;
  aside?: React.ReactNode;
  info?: React.ReactNode;
  children: React.ReactNode;
}) {
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

function Details({ row }: { row: ZgRanked }) {
  const r = row.result;
  const s = row.score;
  if (!r) return null;
  if (r.status === "error" || r.status === "invalid") {
    return (
      <p className="flex items-start gap-2 text-[13px] text-destructive">
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {r.error}
      </p>
    );
  }
  const gth = ZG_GOOD_TO_HAVE.filter((d) => r.goodToHave[d.key]);
  return (
    <div className="space-y-5 py-1 text-[13px]">
      {s ? (
        <DetailSection title="Mandatory checks">
          <ul className="flex flex-wrap gap-1.5">
            {(Object.keys(MANDATORY_LABEL) as MandatoryId[]).map((k) => {
              const ui = CHECK_UI[checkState(s, k)];
              const Icon = ui.icon;
              return (
                <li key={k}>
                  <Badge variant={ui.variant}>
                    <Icon aria-hidden />
                    {MANDATORY_LABEL[k]}
                    <span className="sr-only">: {ui.word}</span>
                  </Badge>
                </li>
              );
            })}
          </ul>
        </DetailSection>
      ) : null}

      {row.reasons.length && row.status !== "Shortlisted" ? (
        <ul className="space-y-1 rounded-lg border border-[hsl(38_80%_82%)] bg-warning-soft px-3.5 py-2.5 text-[hsl(32_90%_24%)]">
          {row.reasons.map((x, i) => (
            <li key={i} className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{x}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <DetailSection
        title="Work history"
        aside={s ? `${formatMonths(s.months)} relevant full-time (${s.months} months, overlaps counted once)` : undefined}
      >
        {r.jobs.length ? (
          <div className="overflow-hidden rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Company</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Work</TableHead>
                  <TableHead>Period (as written)</TableHead>
                  <TableHead className="text-right">Months</TableHead>
                  <TableHead>Company type</TableHead>
                  <TableHead>Counts?</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(s?.jobs ?? []).map((v, i) => (
                  <TableRow key={i}>
                    <TableCell className="py-2 align-top font-medium">{v.job.company}</TableCell>
                    <TableCell className="py-2 align-top">{v.job.title || "—"}</TableCell>
                    <TableCell className="whitespace-nowrap py-2 align-top">{v.job.employmentType}</TableCell>
                    <TableCell className="whitespace-nowrap py-2 align-top" title={v.job.work}>
                      {ROLE_FOCUS_LABEL[v.job.roleFocus]}
                    </TableCell>
                    <TableCell className="py-2 align-top">
                      <div className="whitespace-nowrap">{jobPeriod(v.job)}</div>
                      <div className="text-xs text-muted-foreground">
                        “{v.job.datesText || "—"}”{!v.job.datesVerified ? " · model's reading" : v.job.datesApproximate ? " · approximate" : ""}
                      </div>
                    </TableCell>
                    <TableCell className="py-2 text-right align-top tabular-nums">{v.months}</TableCell>
                    <TableCell className="py-2 align-top" title={v.job.companyTypeReason}>
                      {v.disqualifies ? (
                        <Badge variant="destructive">
                          <Ban aria-hidden />
                          {COMPANY_TYPE_LABEL[v.job.companyType]}
                        </Badge>
                      ) : (
                        <span>{COMPANY_TYPE_LABEL[v.job.companyType]}</span>
                      )}
                      <div className="mt-0.5 line-clamp-2 min-w-[140px] max-w-[260px] text-xs text-muted-foreground">
                        {v.job.companyTypeSource === "list" ? "known firm list" : v.job.companyTypeReason}
                      </div>
                    </TableCell>
                    <TableCell className="py-2 align-top">
                      {v.counted ? (
                        <Badge variant="success">
                          <Check aria-hidden />
                          Counted
                        </Badge>
                      ) : (
                        <span className="block min-w-[140px] text-xs text-muted-foreground">{v.why}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-muted-foreground">No jobs or internships on the resume.</p>
        )}
      </DetailSection>

      <div className="grid gap-5 lg:grid-cols-2">
        <DetailSection title="Mandatory skills" aside="exact resume words">
          <div className="overflow-hidden rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Skill</TableHead>
                  {QA_SECTIONS.map((sec) => (
                    <TableHead key={sec}>{SECTION_LABEL[sec]}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {ZG_SKILLS.map((d) => (
                  <TableRow key={d.key}>
                    <TableCell className="whitespace-nowrap py-2 align-top font-medium">{MANDATORY_LABEL[d.key]}</TableCell>
                    {QA_SECTIONS.map((sec) => (
                      <TableCell key={sec} className="py-2 align-top">
                        {r.skills[d.key]?.[sec] ? <span>&ldquo;{r.skills[d.key][sec]}&rdquo;</span> : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {r.remarks ? (
            <p>
              <span className="font-medium">Remarks:</span> {r.remarks}
            </p>
          ) : null}
        </DetailSection>

        <DetailSection
          title={`Good-to-have (${gth.length})`}
          info="+2 when the item is shown in a project or job (marked with a briefcase), +1 when it is only in the skills list. Hover an item for the resume words."
        >
          <div className="flex flex-wrap gap-1.5">
            {gth.length ? (
              gth.map((d) => {
                const q = r.goodToHave[d.key];
                const secs = QA_SECTIONS.filter((x) => q[x]);
                const inWork = secs.some((x) => x !== "skills");
                return (
                  <Badge
                    key={d.key}
                    variant={inWork ? "default" : "secondary"}
                    title={secs.map((x) => `${SECTION_LABEL[x]}: "${q[x]}"`).join("\n")}
                  >
                    {inWork ? <Briefcase aria-hidden /> : null}
                    {d.label}
                    {secs.length ? <span className="tabular-nums opacity-70">+{inWork ? 2 : 1}</span> : null}
                  </Badge>
                );
              })
            ) : (
              <span className="text-muted-foreground">None found.</span>
            )}
          </div>
          {r.checks.length ? (
            <div className="space-y-1 pt-1">
              <p className="font-medium">Verification notes</p>
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                {r.checks.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="pt-1 text-xs text-muted-foreground">
            Read by {r.model || "—"} · {r.source || "—"} · quotes and dates checked against the resume text · screened {r.asOf} ·{" "}
            <span className="tabular-nums">{(r.durationMs / 1000).toFixed(1)}s</span>
          </p>
        </DetailSection>
      </div>
    </div>
  );
}

const RULE_SWITCHES = [
  ["countInternships", "Count internships", "Off: only full-time (and contract) jobs count toward the months."],
  ["countFrontendMobile", "Count frontend / mobile roles", "Off: backend, full-stack and general SDE roles only."],
  ["servicesInternshipDisqualifies", "IT-services internship disqualifies", "Off: only a job at an IT services / consulting firm rules a candidate out."],
] as const;

export function ZgRulesCard({ rules, onChange }: { rules: ZgRules; onChange: (r: ZgRules) => void }) {
  const set = (patch: Partial<ZgRules>) => onChange({ ...rules, ...patch });
  const num = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));
  const summary = `${rules.minMonths}–${rules.maxMonths} months${rules.topN > 0 ? ` · top ${rules.topN}` : ""}${rules.countInternships ? " · internships count" : ""}`;
  return (
    <Disclosure title="Shortlist rules" summary={summary}>
      <div className="space-y-5">
        <p className="flex flex-wrap items-center gap-1 text-[13px] text-muted-foreground">
          Changing a rule re-ranks instantly. No resume is read again.
          <InfoHint label="How the score works" align="start">
            Score: backend language {POINTS.backend_language} · DSA {POINTS.dsa} · APIs {POINTS.apis} · SQL {POINTS.sql} · 1 year
            experience {POINTS.experience} · product company {POINTS.product} · no IT services {POINTS.noServices}. 100% only when all
            seven are met (otherwise capped at 99%); each good-to-have adds +2 (shown in a project / job) or +1 (skills list only).
          </InfoHint>
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Experience from (months)" htmlFor="zg-min">
            <Input
              id="zg-min"
              type="number"
              min={0}
              max={120}
              className="tabular-nums"
              value={rules.minMonths}
              onChange={(e) => set({ minMonths: num(e.target.value, 0, 120) })}
            />
          </Field>
          <Field
            label="Experience up to (months)"
            htmlFor="zg-max"
            info={<>Cumulative relevant full-time months, overlaps counted once. 12–23 = &ldquo;1 year&rdquo;.</>}
          >
            <Input
              id="zg-max"
              type="number"
              min={0}
              max={240}
              className="tabular-nums"
              value={rules.maxMonths}
              onChange={(e) => set({ maxMonths: num(e.target.value, 0, 240) })}
            />
          </Field>
          <Field label="Keep only the top N" htmlFor="zg-top" hint="0 = no cap">
            <Input
              id="zg-top"
              type="number"
              min={0}
              className="tabular-nums"
              value={rules.topN}
              onChange={(e) => set({ topN: num(e.target.value, 0, 100_000) })}
            />
          </Field>
        </div>
        <SettingList>
          {RULE_SWITCHES.map(([key, label, hint]) => (
            <SettingRow
              key={key}
              id={`zg-${key}`}
              title={label}
              description={hint}
              checked={rules[key]}
              onCheckedChange={(v) => set({ [key]: v } as Partial<ZgRules>)}
            />
          ))}
        </SettingList>
      </div>
    </Disclosure>
  );
}

export function ZaggleResults({
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
}: Props) {
  const ranking = React.useMemo(() => rankZg(candidates, results, rules), [candidates, results, rules]);
  const sum = React.useMemo(() => summarizeZg(ranking), [ranking]);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(0);
  const [open, setOpen] = React.useState<string | null>(null);
  const [scope, setScope] = React.useState<"all" | number>("all");
  const [newRows, setNewRows] = React.useState<ZgCandidateInput[]>([]);
  const [pasteKey, setPasteKey] = React.useState(0);

  const pending = candidates.filter((c) => !results[c.id]);
  const failed = candidates.filter((c) => results[c.id]?.status === "error");
  const stale = candidates.filter((c) => {
    const r = results[c.id];
    return r && r.status !== "error" && (r.checksVersion ?? 0) < ZG_CHECKS_VERSION;
  });
  const done = candidates.length - pending.length;
  const pct = candidates.length ? Math.round((done / candidates.length) * 100) : 0;
  const avgSecs = React.useMemo(() => {
    const t = Object.values(results)
      .map((r) => r.durationMs)
      .filter((ms) => ms > 0);
    return t.length ? t.reduce((a, b) => a + b, 0) / t.length / 1000 : 0;
  }, [results]);
  const eta = running && pending.length && avgSecs ? ` · about ${Math.max(1, Math.ceil((avgSecs * pending.length) / Math.max(1, concurrency) / 60))} min left` : "";

  const existing = React.useMemo(() => new Map(candidates.map((c) => [c.id, c.batch])), [candidates]);
  const nextBatch = (batches.length ? batches[batches.length - 1].n : 0) + 1;
  const scoped = ranking.filter((r) => scope === "all" || r.candidate.batch === scope);
  const shortlisted = scoped.filter((r) => r.status === "Shortlisted");
  const review = scoped.filter((r) => r.status === "Review – Check Manually");
  const suffix = scope === "all" ? "" : `-batch-${scope}`;

  const q = query.trim().toLowerCase();
  const visible = ranking.filter(
    (r) => (filter === "all" || r.status === filter) && (!q || r.candidate.mobile.includes(q) || (r.candidate.name || r.result?.name || "").toLowerCase().includes(q)),
  );
  const pages = Math.max(1, Math.ceil(visible.length / PAGE));
  const pageRows = visible.slice(page * PAGE, page * PAGE + PAGE);
  React.useEffect(() => setPage(0), [filter, query]);

  const tabs: [Filter, string, number][] = [
    ["all", "All", candidates.length],
    ["Shortlisted", "Shortlisted", sum.shortlisted],
    ...(rules.topN > 0 ? ([["Qualified – Outside Top N", "Outside top N", sum.outsideTopN]] as [Filter, string, number][]) : []),
    ["Review – Check Manually", "Review", sum.review],
    ["Not Shortlisted", "Not shortlisted", sum.notShortlisted],
    ["No Relevant Full-time Experience", "No relevant experience", sum.noExperience],
    ["Invalid – Not a Resume", "Not a resume", sum.invalid],
    ["Error", "Errors", sum.errors],
    ["Pending", "Pending", sum.pending],
  ];

  // The one solid button: the run control while resumes are left, the shortlist download once all are read.
  const runIsPrimary = !running && pending.length > 0;
  const unread = sum.invalid + sum.errors;

  return (
    <div className="space-y-6">
      {storageError ? <Notice tone="warning">{storageError}</Notice> : null}
      {stale.length ? (
        <Notice
          tone="warning"
          action={
            <Button variant="outline" size="sm" disabled={running} onClick={() => onRun(stale)}>
              <RotateCcw className="h-4 w-4" /> Re-screen {stale.length}
            </Button>
          }
        >
          {stale.length} result{stale.length === 1 ? " was" : "s were"} screened with older checks.
        </Notice>
      ) : null}

      <Panel
        icon={<ListOrdered />}
        title={title}
        description={`${ZAGGLE_ROLE.company} · ${ZAGGLE_ROLE.title} · ${candidates.length} candidates in ${batches.length} batch${batches.length === 1 ? "" : "es"}`}
      >
        <div className="space-y-3">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="inline-flex items-center gap-2 font-medium text-foreground">
                {running ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden /> : null}
                <span>
                  <span className="tabular-nums">
                    {done} of {candidates.length}
                  </span>{" "}
                  resumes screened{eta}
                </span>
              </span>
              <span className="tabular-nums text-muted-foreground">{pct}%</span>
            </div>
            <Progress value={done} max={candidates.length} label="Resumes screened" tone={!running && !pending.length ? "success" : "primary"} />
            {running ? (
              <p className="text-[13px] text-muted-foreground" aria-live="polite">
                Reading <span className="tabular-nums">{active}</span> resume{active === 1 ? "" : "s"}
                {retrying ? ` · ${retrying} waiting to retry after a rate limit` : ""}…
              </p>
            ) : null}
          </div>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <label htmlFor="zg-run-conc">In parallel</label>
              <NativeSelect
                id="zg-run-conc"
                value={concurrency}
                disabled={running}
                onChange={(e) => onConcurrencyChange(Number(e.target.value))}
                className="h-8 text-[13px]"
              >
                {ZG_CONCURRENCY_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n} at a time
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
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
                <Badge variant="success" className="px-2.5 py-1 text-[13px]">
                  <CircleCheck aria-hidden className="!size-4" />
                  All {candidates.length} resumes screened
                </Badge>
              )}
            </div>
          </div>
        </div>
      </Panel>

      <StatGrid cols={6}>
        <Stat icon={<Users />} label="Screened" value={sum.evaluated} hint={`of ${candidates.length}`} />
        <Stat
          icon={<Award />}
          label="Shortlisted"
          value={sum.shortlisted}
          tone="highlight"
          hint={rules.topN > 0 && sum.outsideTopN ? `${sum.outsideTopN} more outside the top ${rules.topN}` : undefined}
        />
        <Stat icon={<TriangleAlert />} label="Review" value={sum.review} tone={sum.review ? "warning" : "default"} hint="check manually" />
        <Stat icon={<CircleX />} label="Not shortlisted" value={sum.notShortlisted + sum.outsideTopN} />
        <Stat icon={<Ban />} label="No relevant experience" value={sum.noExperience} />
        <Stat
          icon={<FileWarning />}
          label="Could not be read"
          value={unread}
          tone={unread ? "danger" : "default"}
          hint={`${sum.invalid} not a resume · ${sum.errors} error${sum.errors === 1 ? "" : "s"}`}
        />
      </StatGrid>

      <ZgRulesCard rules={rules} onChange={onRulesChange} />

      <Panel
        flush
        title={
          <span className="inline-flex items-center gap-1">
            Ranking
            <InfoHint label="What the mandatory badges mean" align="start">
              Mandatory: Lang (backend language) · DSA · API · SQL · 1 yr (relevant full-time) · Prod (product company) · No IT-svc. A tick
              means met, a question mark unclear, a cross missing.
            </InfoHint>
          </span>
        }
        description="Select a row for the work history and the exact resume words."
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
          <span className="mr-1 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
            Download CSV
          </span>
          <NativeSelect
            value={String(scope)}
            onChange={(e) => setScope(e.target.value === "all" ? "all" : Number(e.target.value))}
            className="h-8 text-[13px]"
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
            size="sm"
            disabled={!done}
            onClick={() => download(`${slugify(title)}-complete-ranking${suffix}-${scoped.length}.csv`, buildZgCsv(scoped))}
          >
            <Download className="h-4 w-4" /> Complete ranking ({scoped.length})
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!review.length}
            onClick={() => download(`${slugify(title)}-review${suffix}-${review.length}.csv`, buildZgCsv(review))}
          >
            <Download className="h-4 w-4" /> Review ({review.length})
          </Button>
          <Button
            variant={runIsPrimary ? "outline" : "default"}
            size="sm"
            disabled={!shortlisted.length}
            onClick={() => download(`${slugify(title)}-shortlisted${suffix}-${shortlisted.length}.csv`, buildZgCsv(shortlisted))}
          >
            <Download className="h-4 w-4" /> Shortlisted ({shortlisted.length})
          </Button>
        </div>

        <div className="flex flex-col gap-3 border-t px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
            {tabs.map(([key, label, n]) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25",
                  filter === key
                    ? "border-primary/40 bg-accent text-accent-foreground"
                    : "bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {label} <span className="tabular-nums opacity-80">{n}</span>
              </button>
            ))}
          </div>
          <div className="relative w-full shrink-0 lg:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              className="h-9 pl-9"
              placeholder="Search mobile or name"
              aria-label="Search mobile or name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        {pageRows.length ? (
          <Table containerClassName="max-h-[75vh] border-t">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10">
                  <span className="sr-only">Details</span>
                </TableHead>
                <TableHead className="w-14 text-right">Rank</TableHead>
                <TableHead>Candidate</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Score</TableHead>
                <TableHead>Experience</TableHead>
                <TableHead>Mandatory</TableHead>
                <TableHead>Good-to-have</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((row) => {
                const r = row.result;
                const s = row.score;
                const expandable = Boolean(r);
                const isOpen = expandable && open === row.id;
                const who = row.candidate.name || r?.name || "";
                return (
                  <React.Fragment key={row.id}>
                    <TableRow
                      className={cn(expandable && "cursor-pointer", isOpen && "bg-accent/40")}
                      onClick={() => expandable && setOpen(isOpen ? null : row.id)}
                    >
                      <TableCell className="w-10 pr-0 align-top text-muted-foreground">
                        {expandable ? (
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            aria-label={isOpen ? "Hide details" : "Show details"}
                            className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
                          >
                            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </button>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right align-top tabular-nums">
                        {row.rank || "—"}
                        {row.shortlistRank ? (
                          <div className="text-[11px] text-muted-foreground" title="Position in the shortlist">
                            #{row.shortlistRank} SL
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="max-w-[220px] truncate font-medium" title={who || undefined}>
                          {who || <span className="text-muted-foreground">—</span>}
                        </div>
                        <div className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
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
                            Resume <ExternalLink className="h-3 w-3" aria-hidden />
                          </a>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-[260px] align-top">
                        <StatusBadge status={row.status} />
                        {row.reasons.length && row.status !== "Shortlisted" ? (
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground" title={row.reasons.join("\n")}>
                            {row.reasons.join(" · ")}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right align-top">
                        {s && r?.status === "ok" ? (
                          <>
                            <div className="text-[15px] font-semibold tabular-nums">{s.finalScore}%</div>
                            <div className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
                              {s.points} + {s.bonus}
                            </div>
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[220px] align-top text-xs">
                        {s && r?.status === "ok" ? (
                          <>
                            <div className="whitespace-nowrap font-semibold">
                              {formatMonths(s.months)}
                              {s.monthsApproximate ? <span className="font-normal text-warning"> (approx.)</span> : null}
                            </div>
                            <div
                              className="line-clamp-2 text-muted-foreground"
                              title={s.jobs.map((j) => `${j.job.company}: ${j.counted ? `${j.months} mo` : j.why}`).join("\n")}
                            >
                              {s.jobs.filter((j) => j.counted).map((j) => `${j.job.company} ${j.months}mo`).join(" + ") || "no counted job"}
                            </div>
                          </>
                        ) : null}
                      </TableCell>
                      <TableCell className="align-top">{r?.status === "ok" ? <Mandatory row={row} /> : null}</TableCell>
                      <TableCell className="max-w-[200px] align-top text-xs">
                        {s && r?.status === "ok" ? (
                          <span title={s.goodToHave.join(", ")}>
                            <span className="font-semibold tabular-nums">{s.goodToHave.length}</span>
                            <span className="text-muted-foreground">
                              {" "}
                              — {s.goodToHave.slice(0, 3).join(", ")}
                              {s.goodToHave.length > 3 ? "…" : ""}
                            </span>
                          </span>
                        ) : r?.status === "error" ? (
                          <span className="text-muted-foreground">{r.retryable ? "Re-run later (rate limit / timeout)" : "Fix the link, then re-run"}</span>
                        ) : null}
                      </TableCell>
                    </TableRow>
                    {isOpen ? (
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableCell colSpan={8} className="py-4">
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
              icon={running && !done ? <Loader2 className="animate-spin" /> : <Search />}
              title={running && !done ? "Reading the first resumes…" : "No candidates in this view."}
              description={running && !done ? undefined : "Pick another status or clear the search."}
            />
          </div>
        )}
      </Panel>

      <Panel
        icon={<FilePlus2 />}
        title={`Add batch ${nextBatch}`}
        description="Paste the next set of candidates. Mobile numbers already in this run are skipped."
        footer={
          <>
            <span className="flex-1 text-[13px] text-muted-foreground">The ranking and downloads cover every batch.</span>
            <Button
              variant="outline"
              disabled={!newRows.length}
              onClick={() => {
                onAddBatch(newRows);
                setNewRows([]);
                setPasteKey((k) => k + 1);
              }}
            >
              <Play className="h-4 w-4" /> {newRows.length ? `Add ${newRows.length} and screen` : "Add and screen"}
            </Button>
          </>
        }
      >
        <QaPaste key={pasteKey} batch={nextBatch} existing={existing} onParsed={setNewRows} />
      </Panel>
    </div>
  );
}
