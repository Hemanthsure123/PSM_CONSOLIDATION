"use client";

import * as React from "react";
import {
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Download,
  ExternalLink,
  FileQuestion,
  ArrowRightLeft,
  Layers,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Loader2,
  Monitor,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Shuffle,
  Square,
  TriangleAlert,
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
import { AcNudgePanel, AcRulesCard, AcSignalsPanel } from "@/components/academy/academy-rules";
import { AC_TABS, AC_TAB_LABEL, buildAcademyCsv, buildAcademyWorkbook, tabRows, type AcTab } from "@/lib/academy/export";
import { itemBackendShare, needsRead, rankAcademy, SIGNAL_LABEL, staleReads, summarizeAcademy, type AcRanked, type AcSignalKey, type AcTrust } from "@/lib/academy/scoring";
import { AC_BUCKETS, AC_BUCKET_LABEL, AC_PLACEMENT_LABEL, type AcBucket, type AcCandidate, type AcDataset, type AcEvaluation, type AcPlacement, type AcRules, type AcStack } from "@/lib/academy/types";
import { cn, slugify } from "@/lib/utils";

export const AC_CONCURRENCY_OPTIONS = [2, 4, 6, 8, 10, 12];

interface Props {
  title: string;
  dataset: AcDataset;
  results: Record<string, AcEvaluation>;
  rules: AcRules;
  onRulesChange: (rules: AcRules) => void;
  running: boolean;
  active: number;
  retrying: number;
  concurrency: number;
  onConcurrencyChange: (n: number) => void;
  onRead: (targets: AcCandidate[]) => void;
  onStop: () => void;
  onReload: () => void;
  reloading: boolean;
  reloadError: string;
  storageError: string;
}

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

const PLACEMENT_ICON: Record<AcPlacement, React.ComponentType<{ className?: string }>> = {
  frontend: Monitor,
  backend: Server,
  aiml: BrainCircuit,
  fullstack: Layers,
  mixed: Shuffle,
};

const SHORT: Record<AcBucket, string> = { frontend: "FE", backend: "BE", aiml: "AI", fullstack: "FS" };
const STACK_LABEL = (s: AcStack) => (s === "other" ? "Other" : AC_BUCKET_LABEL[s]);
const PAGE = 50;

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

function PlacementBadge({ row }: { row: AcRanked }) {
  if (!row.placement) {
    const variant: BadgeVariant = row.status === "Needs evidence" ? "warning" : row.status === "Pending" ? "outline" : "secondary";
    return <Badge variant={variant}>{row.status}</Badge>;
  }
  const Icon = PLACEMENT_ICON[row.placement];
  return (
    <Badge variant={row.placement === "mixed" ? "warning" : "default"}>
      <Icon aria-hidden />
      {AC_PLACEMENT_LABEL[row.placement]}
    </Badge>
  );
}

function StackBadge({ stack }: { stack: AcStack }) {
  return (
    <Badge variant={stack === "other" ? "secondary" : "outline"} className="whitespace-nowrap">
      {STACK_LABEL(stack)}
    </Badge>
  );
}

/** Four small bars, the candidate's bucket in the accent colour. */
function ScoreBars({ row }: { row: AcRanked }) {
  if (!row.used.length) return <span className="text-muted-foreground">—</span>;
  const lit = new Set<AcBucket>(row.placement === "mixed" ? row.mixedWith : row.placement ? [row.placement] : []);
  return (
    <div className="grid min-w-[150px] gap-0.5" aria-label={AC_BUCKETS.map((b) => `${AC_BUCKET_LABEL[b]} ${row.scores[b]}`).join(", ")}>
      {AC_BUCKETS.map((b) => (
        <div key={b} className="grid grid-cols-[22px_1fr_24px] items-center gap-1.5 text-[11px] leading-4">
          <span className={cn("font-medium", lit.has(b) ? "text-foreground" : "text-muted-foreground")}>{SHORT[b]}</span>
          <span className="h-1.5 overflow-hidden rounded-full bg-muted">
            <span className={cn("block h-full rounded-full", lit.has(b) ? "bg-primary" : "bg-[hsl(218_20%_75%)]")} style={{ width: `${row.scores[b]}%` }} />
          </span>
          <span className={cn("text-right tabular-nums", lit.has(b) ? "font-semibold text-foreground" : "text-muted-foreground")}>{row.scores[b]}</span>
        </div>
      ))}
    </div>
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

const SIGNAL_KEYS = Object.keys(SIGNAL_LABEL) as AcSignalKey[];

const TRUST_UI: Record<AcTrust["band"], { variant: BadgeVariant; icon: React.ComponentType<{ className?: string }> }> = {
  High: { variant: "success", icon: ShieldCheck },
  Medium: { variant: "warning", icon: ShieldAlert },
  Low: { variant: "destructive", icon: ShieldAlert },
  Unverified: { variant: "outline", icon: ShieldQuestion },
};

/** Trust as a badge: icon + band + score, so the meaning never rests on colour alone. */
function TrustBadge({ trust }: { trust: AcTrust }) {
  const ui = TRUST_UI[trust.band];
  const Icon = ui.icon;
  return (
    <Badge variant={ui.variant} title={trust.score === null ? "No resume reading to check" : `Trust ${trust.score}/100`}>
      <Icon aria-hidden />
      {trust.band === "Unverified" ? "Trust unverified" : `Trust ${trust.score} · ${trust.band}`}
    </Badge>
  );
}

function TrustSection({ row }: { row: AcRanked }) {
  const t = row.trust;
  const e = row.result;
  if (!t) return null;
  return (
    <Section
      title="Trust"
      aside={t.score === null ? "no resume reading to check" : `${t.score}/100 · ${t.band}${t.agentRan ? "" : e?.trustError ? " · trust agent failed — re-read" : " · program checks only (re-read for the trust agent)"}`}
      info="100 minus the checks below. The program checks identity, GitHub authorship, interview integrity and resume vs interview level; the trust agent's flags are kept only when their exact words are in the resume or the evidence (high −15, medium −8, low −3, at most −45)."
    >
      {t.summary ? <p className="text-muted-foreground">{t.summary}</p> : null}
      {t.checks.length ? (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Check</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead>By</TableHead>
                <TableHead className="text-right">Points</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {t.checks.map((x, i) => (
                <TableRow key={i}>
                  <TableCell className="whitespace-nowrap py-2 align-top font-medium">{x.label}</TableCell>
                  <TableCell className="min-w-[260px] py-2 align-top text-xs text-muted-foreground">{x.detail}</TableCell>
                  <TableCell className="whitespace-nowrap py-2 align-top text-xs">{x.source === "agent" ? "Trust agent" : "Program"}</TableCell>
                  <TableCell className={cn("py-2 text-right align-top tabular-nums", x.points < 0 && "text-destructive")}>{x.points || "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : t.score !== null ? (
        <p className="text-muted-foreground">No doubts found.</p>
      ) : null}
    </Section>
  );
}

function Details({ row, rules }: { row: AcRanked; rules: AcRules }) {
  const c = row.candidate;
  const e = row.result;
  const res = row.signals.resume;
  const gh = row.signals.github;
  return (
    <div className="space-y-5 py-1 text-[13px]">
      <ul className="space-y-1">
        {row.reasons.map((x, i) => (
          <li key={i} className={cn("flex items-start gap-2", i === 0 && "font-medium")}>
            {i === 0 ? <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden /> : <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" aria-hidden />}
            <span>{x}</span>
          </li>
        ))}
      </ul>
      {row.tag ? (
        <p className="flex items-start gap-2 rounded-lg border border-[hsl(38_80%_82%)] bg-warning-soft px-3.5 py-2.5 text-[hsl(32_90%_24%)]">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {row.tag}
        </p>
      ) : null}

      <Section title="Score by signal" aside="0-100 per bucket; the final row is the weighted average of the signals that speak for each bucket">
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Signal</TableHead>
                <TableHead className="text-right">Weight</TableHead>
                {AC_BUCKETS.map((b) => (
                  <TableHead key={b} className="text-right">
                    {AC_BUCKET_LABEL[b]}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {SIGNAL_KEYS.map((k) => {
                const s = row.signals[k];
                const used = row.used.includes(k);
                return (
                  <TableRow key={k} className={cn(!used && "text-muted-foreground")}>
                    <TableCell className="py-1.5">
                      {SIGNAL_LABEL[k]}
                      {!used ? <span className="text-xs"> · {!rules.signals[k] ? "switched off" : "no evidence"}</span> : null}
                    </TableCell>
                    <TableCell className="py-1.5 text-right tabular-nums">{used ? rules.weights[k] : "—"}</TableCell>
                    {AC_BUCKETS.map((b) => {
                      const obs = s && "observes" in s ? (s.observes as Record<AcBucket, number>)[b] : 1;
                      return (
                        <TableCell key={b} className="py-1.5 text-right tabular-nums" title={obs === 0 ? "This signal says nothing about this bucket" : obs < 1 ? "Counts at half weight (no repo of this stack)" : undefined}>
                          {!s ? "—" : obs === 0 ? <span className="text-muted-foreground">n/a</span> : obs < 1 ? <span className="text-muted-foreground">{s.scores[b]}½</span> : s.scores[b]}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })}
              <TableRow className="font-semibold hover:bg-transparent">
                <TableCell className="py-1.5">Final</TableCell>
                <TableCell />
                {AC_BUCKETS.map((b) => (
                  <TableCell key={b} className="py-1.5 text-right tabular-nums">
                    {row.used.length ? row.scores[b] : "—"}
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </Section>

      <TrustSection row={row} />

      {e && e.status !== "ok" ? (
        <p className="flex items-start gap-2 text-destructive">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Resume: {e.error}
        </p>
      ) : null}

      {res ? (
        <Section title={`Resume (${res.items.length} items)`} aside={e?.primaryProfile} info="The stack is decided from the technologies the resume names for each item; the model's reading only when they don't decide. Points = 25 × kind (job 1.6 · internship 1.3 · freelance 1.2 · project 1) × depth (production 1.25 · substantial 1 · basic 0.5).">
          {res.items.length ? (
            <div className="overflow-hidden rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Stack</TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead>Kind · depth</TableHead>
                    <TableHead title="For web work: the side the resume says they worked on more">Worked on</TableHead>
                    <TableHead>Technologies</TableHead>
                    <TableHead>Resume words</TableHead>
                    <TableHead className="text-right">Points</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {res.items.map((x, i) => (
                    <TableRow key={i}>
                      <TableCell className="py-2 align-top" title={x.why}>
                        <StackBadge stack={x.stack} />
                        {x.stack !== x.item.stack ? <div className="mt-0.5 text-[11px] text-muted-foreground">model: {STACK_LABEL(x.item.stack)}</div> : null}
                      </TableCell>
                      <TableCell className="min-w-[160px] py-2 align-top font-medium">
                        {x.item.title}
                        {x.item.org ? <div className="text-xs font-normal text-muted-foreground">{x.item.org}</div> : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap py-2 align-top">
                        {x.item.kind} · {x.item.depth}
                      </TableCell>
                      <TableCell className="whitespace-nowrap py-2 align-top text-xs">
                        {x.stack === "fullstack" ? `${Math.round(itemBackendShare(x.item) * 100)}% backend` : x.stack === "frontend" || x.stack === "backend" ? x.stack : "—"}
                      </TableCell>
                      <TableCell className="min-w-[140px] max-w-[240px] py-2 align-top text-xs">{x.item.techs.join(", ") || <span className="text-muted-foreground">none named</span>}</TableCell>
                      <TableCell className="min-w-[200px] max-w-[360px] py-2 align-top text-xs text-muted-foreground">{x.item.quote ? <>&ldquo;{x.item.quote}&rdquo;</> : "—"}</TableCell>
                      <TableCell className="py-2 text-right align-top tabular-nums">{x.points || "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-muted-foreground">No projects, internships or jobs on the resume.</p>
          )}
          {e?.skills.length ? (
            <p>
              <span className="font-medium">Skills:</span> {e.skills.join(", ")}
            </p>
          ) : null}
          {e?.remarks ? (
            <p>
              <span className="font-medium">Remarks:</span> {e.remarks}
            </p>
          ) : null}
        </Section>
      ) : null}

      {e?.github ? (
        <Section
          title="GitHub"
          aside={
            <>
              {e.github.profile ? (
                <a href={e.github.profile} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                  {e.github.profile.replace(/^https?:\/\/(www\.)?/, "")} <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              ) : null}
              {e.github.status !== "checked" ? ` ${e.github.note}` : e.github.fromCache ? " · reused from the last 24 h" : ""}
            </>
          }
        >
          {gh ? (
            <div className="overflow-hidden rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Stack</TableHead>
                    <TableHead>Repo</TableHead>
                    <TableHead>Proven by the code</TableHead>
                    <TableHead className="text-right">Points</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {gh.repos.map((x) => (
                    <TableRow key={x.repo.url} className={cn(!x.points && "text-muted-foreground")}>
                      <TableCell className="py-2 align-top">
                        <StackBadge stack={x.stack} />
                      </TableCell>
                      <TableCell className="py-2 align-top">
                        <a href={x.repo.url} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
                          {x.repo.name}
                        </a>
                        {x.repo.aiLikelihood === "high" ? <div className="text-[11px] text-warning">AI-written commits</div> : null}
                      </TableCell>
                      <TableCell className="py-2 align-top text-xs">{x.repo.techs.join(", ") || "—"}</TableCell>
                      <TableCell className="py-2 text-right align-top tabular-nums">{x.points || "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : e.github.status === "checked" ? (
            <p className="text-muted-foreground">No repo proves a frontend, backend or AI technology.</p>
          ) : null}
        </Section>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Assessments" aside={row.placement ? `priority score ${row.priorityScore} · evidence coverage ${Math.round(row.coverage * 100)}%` : undefined}>
          <ul className="space-y-1">
            <li>
              <span className="font-medium">Eligible via:</span> {c.eligibility.via.join(", ") || "—"}
            </li>
            {c.competencies
              .filter((k) => k.level || k.score !== null)
              .map((k) => (
                <li key={k.name}>
                  <span className="font-medium">{k.name}:</span> {[k.level, k.score !== null ? `${k.score}/100` : "", k.verdict, k.clearance].filter(Boolean).join(" · ")}
                </li>
              ))}
            {c.oldBucket ? (
              <li>
                <span className="font-medium">Old process:</span> Bucket {c.oldBucket}
                {c.oldOverall !== null ? ` · overall ${c.oldOverall}` : ""}
                {c.oldCoding !== null ? ` · coding ${c.oldCoding}/120` : ""}
                {c.oldRounds.length ? ` · ${c.oldRounds.map((r) => `${r.label} ${[r.score, r.status].filter(Boolean).join(" ")}`).join(", ")}` : ""}
              </li>
            ) : null}
            {c.dsaOffline ? (
              <li>
                <span className="font-medium">DSA Offline:</span> {c.dsaOffline}
              </li>
            ) : null}
            <li>
              <span className="font-medium">Assessment score:</span> {row.assessment.score} — {row.assessment.basis}
            </li>
            <li>
              <span className="font-medium">DSA score:</span> {row.dsa.score} — {row.dsa.basis}
            </li>
          </ul>
        </Section>
        <Section title="Student preference" aside={row.signals.preference ? `read as ${row.signals.preference.order.map((b) => AC_BUCKET_LABEL[b]).join(", ")}` : undefined}>
          <p className={cn(!c.preference && "text-muted-foreground")}>{c.preference || "No preference noted."}</p>
          {e?.checks.length ? (
            <div className="space-y-1 pt-1">
              <p className="font-medium">Verification notes</p>
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                {e.checks.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {e ? (
            <p className="pt-1 text-xs text-muted-foreground">
              Read by {e.model || "—"} · {e.source || "—"} · {(e.durationMs / 1000).toFixed(1)}s · {e.analyzedAt.slice(0, 16).replace("T", " ")}
            </p>
          ) : null}
        </Section>
      </div>
    </div>
  );
}

export function AcademyResults({
  title,
  dataset,
  results,
  rules,
  onRulesChange,
  running,
  active,
  retrying,
  concurrency,
  onConcurrencyChange,
  onRead,
  onStop,
  onReload,
  reloading,
  reloadError,
  storageError,
}: Props) {
  const ranking = React.useMemo(() => rankAcademy(dataset.candidates, results, rules), [dataset, results, rules]);
  const sum = React.useMemo(() => summarizeAcademy(ranking), [ranking]);
  const toRead = React.useMemo(() => needsRead(ranking, rules), [ranking, rules]);
  const stale = React.useMemo(() => staleReads(ranking, rules), [ranking, rules]);
  const inScope = (r: AcRanked) => r.candidate.activePool && r.candidate.eligibility.eligible;
  const failed = ranking.filter((r) => inScope(r) && r.result?.status === "error" && r.result.retryable);
  const unreadable = ranking.filter((r) => inScope(r) && r.result?.status === "error" && !r.result.retryable);
  const readable = ranking.filter((r) => r.candidate.eligibility.eligible && r.candidate.activePool && r.candidate.resumeUrl && r.status !== "Placed – not bucketed");
  const readDone = readable.length - toRead.length;
  const pct = readable.length ? Math.round((readDone / readable.length) * 100) : 100;

  const counts: Record<AcTab, number> = React.useMemo(() => Object.fromEntries(AC_TABS.map((t) => [t, tabRows(ranking, t).length])) as Record<AcTab, number>, [ranking]);
  const [tab, setTab] = React.useState<AcTab | null>(null);
  const activeTab: AcTab = tab ?? AC_TABS.find((t) => t !== "all" && counts[t] > 0) ?? "all";
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(0);
  const [open, setOpen] = React.useState<string | null>(null);
  React.useEffect(() => setPage(0), [activeTab, query]);

  const q = query.trim().toLowerCase();
  const visible = tabRows(ranking, activeTab).filter(
    (r) => !q || r.candidate.name.toLowerCase().includes(q) || r.candidate.mobile.includes(q) || r.candidate.email.toLowerCase().includes(q) || r.candidate.uid.toLowerCase().includes(q),
  );
  const pages = Math.max(1, Math.ceil(visible.length / PAGE));
  const pageRows = visible.slice(page * PAGE, page * PAGE + PAGE);
  const complete = !running && toRead.length === 0;

  const downloadWorkbook = () =>
    download(`${slugify(title)}-academy-buckets.xlsx`, buildAcademyWorkbook(title, dataset, ranking, rules) as BlobPart, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const downloadTab = () => {
    const rows = tabRows(ranking, activeTab);
    download(`${slugify(title)}-${slugify(AC_TAB_LABEL[activeTab])}-${rows.length}.csv`, buildAcademyCsv(dataset, rows), "text/csv;charset=utf-8;");
  };

  return (
    <div className="space-y-6">
      {storageError ? <Notice tone="warning">{storageError}</Notice> : null}
      {reloadError ? <Notice tone="danger">{reloadError}</Notice> : null}
      {dataset.warnings.map((w) => (
        <Notice key={w} tone="warning">
          {w}
        </Notice>
      ))}
      {stale.length && !running ? (
        <Notice
          tone="info"
          action={
            <Button variant="outline" size="sm" onClick={() => onRead(stale.map((r) => r.candidate))}>
              <RotateCcw className="h-4 w-4" /> Re-read {stale.length}
            </Button>
          }
        >
          {stale.length} candidate{stale.length === 1 ? " was" : "s were"} read with older checks or without{" "}
          {[rules.signals.github ? "GitHub" : "", rules.signals.dsa ? "DSA profiles" : "", rules.trust.enabled ? "the trust agent" : ""].filter(Boolean).join(" / ")}. Re-read
          them for the backend / frontend split of their work and the trust review.
        </Notice>
      ) : null}

      {unreadable.length && !running ? (
        <Notice
          tone="warning"
          title={`${unreadable.length} resume link${unreadable.length === 1 ? "" : "s"} can't be opened`}
          action={
            <Button variant="outline" size="sm" onClick={() => onRead(unreadable.map((r) => r.candidate))}>
              <RotateCcw className="h-4 w-4" /> Read again
            </Button>
          }
        >
          Mostly Drive files not shared with the service account. Until they are, these candidates are bucketed from their competency level and
          preference and tagged to verify over call. Share them (Viewer), then read again.
        </Notice>
      ) : null}

      <Panel
        icon={<Layers />}
        title={title}
        description={`${dataset.sources.s1.title} › ${dataset.sources.s1.tabs[0]} · sheets read ${dataset.loadedAt.slice(0, 16).replace("T", " ")}`}
        actions={
          <Button variant="outline" size="sm" onClick={onReload} disabled={running || reloading}>
            {reloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Reload sheets
          </Button>
        }
      >
        <div className="space-y-3">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="inline-flex items-center gap-2 font-medium text-foreground">
                {running ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden /> : null}
                <span>
                  <span className="tabular-nums">
                    {readDone} of {readable.length}
                  </span>{" "}
                  resumes read{rules.signals.resume ? "" : " (resume signal is off)"}
                </span>
              </span>
              <span className="tabular-nums text-muted-foreground">{pct}%</span>
            </div>
            <Progress value={readDone} max={Math.max(1, readable.length)} label="Resumes read" tone={complete ? "success" : "primary"} />
            {running ? (
              <p className="text-[13px] text-muted-foreground" aria-live="polite">
                Reading <span className="tabular-nums">{active}</span> candidate{active === 1 ? "" : "s"} (resume, GitHub, coding profiles)
                {retrying ? ` · ${retrying} waiting to retry after a rate limit` : ""}…
              </p>
            ) : null}
          </div>
          <p className="text-[13px] text-muted-foreground">
            Sheet 1: <span className="tabular-nums">{sum.candidates}</span> candidates · <span className="tabular-nums">{sum.eligible}</span> eligible ·{" "}
            <span className="font-medium text-foreground tabular-nums">{sum.inScope}</span> eligible and in the Active Pool (P1 not placed{" "}
            <span className="tabular-nums">{sum.p1}</span> · P2 placed <span className="tabular-nums">{sum.p2}</span>) ·{" "}
            <span className="tabular-nums">{sum.toVerify}</span> tagged to verify over call
            {rules.trust.enabled ? (
              <>
                {" "}
                · trust: <span className="tabular-nums">{sum.trust.High}</span> high · <span className="tabular-nums">{sum.trust.Medium}</span> medium ·{" "}
                <span className="tabular-nums">{sum.trust.Low}</span> low · <span className="tabular-nums">{sum.trust.Unverified}</span> unverified
              </>
            ) : null}
          </p>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <label htmlFor="ac-run-conc">In parallel</label>
              <NativeSelect id="ac-run-conc" value={concurrency} disabled={running} onChange={(e) => onConcurrencyChange(Number(e.target.value))} className="h-8 text-[13px]">
                {AC_CONCURRENCY_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n} at a time
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              {!running && failed.length ? (
                <Button variant="outline" onClick={() => onRead(failed.map((r) => r.candidate))}>
                  <RotateCcw className="h-4 w-4" /> Re-run {failed.length} failed
                </Button>
              ) : null}
              {running ? (
                <Button variant="outline" onClick={onStop}>
                  <Square className="h-4 w-4" /> Stop (finish in-flight)
                </Button>
              ) : toRead.length ? (
                <Button onClick={() => onRead(toRead.map((r) => r.candidate))}>
                  <Play className="h-4 w-4" /> {readDone ? `Resume — ${toRead.length} left` : `Read ${toRead.length} resumes`}
                </Button>
              ) : (
                <Badge variant="success" className="px-2.5 py-1 text-[13px]">
                  <CircleCheck aria-hidden className="!size-4" />
                  Every in-scope resume read
                </Badge>
              )}
            </div>
          </div>
        </div>
      </Panel>

      <StatGrid cols={6}>
        {AC_BUCKETS.map((b) => {
          const Icon = PLACEMENT_ICON[b];
          return (
            <Stat
              key={b}
              icon={<Icon />}
              label={AC_BUCKET_LABEL[b]}
              value={sum.byPlacement[b]}
              hint={b === "backend" && sum.nudged ? `+${sum.nudged} nudged from Full Stack` : b === "fullstack" && sum.nudged ? `−${sum.nudged} nudged to Backend` : undefined}
            />
          );
        })}
        <Stat icon={<Shuffle />} label="Mixed" value={sum.byPlacement.mixed} tone={sum.byPlacement.mixed ? "warning" : "default"} hint="verify over call on priority" />
        <Stat
          icon={<FileQuestion />}
          label="Needs evidence"
          value={sum.needsEvidence + sum.pending}
          tone={sum.needsEvidence ? "danger" : "default"}
          hint={`of ${sum.inScope} in scope`}
        />
      </StatGrid>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <AcSignalsPanel rules={rules} onChange={onRulesChange} collapsed />
        <AcRulesCard rules={rules} onChange={onRulesChange} />
      </div>

      <AcNudgePanel rules={rules} onChange={onRulesChange} preview={{ moves: sum.nudged, fullstack: sum.byPlacement.fullstack, backend: sum.byPlacement.backend }} />

      <Panel
        flush
        title={
          <span className="inline-flex items-center gap-1">
            Buckets
            <InfoHint label="How the buckets are ranked" align="start">
              Each bucket lists P1 (Active, not placed) first, then P2 (Active, placed); inside each, by priority score (stack fit, best internal
              assessment, DSA). The bars show the four bucket scores; the candidate&apos;s own bucket is in blue.
            </InfoHint>
          </span>
        }
        description="Select a row for the evidence behind the bucket."
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
          <Button size="sm" variant={complete ? "default" : "outline"} onClick={downloadWorkbook}>
            <Download className="h-4 w-4" /> Download workbook (.xlsx)
          </Button>
          <Button size="sm" variant="outline" onClick={downloadTab} disabled={!counts[activeTab]}>
            <Download className="h-4 w-4" /> {AC_TAB_LABEL[activeTab]} (CSV, {counts[activeTab]})
          </Button>
          <span className="text-xs text-muted-foreground">The workbook has a tab per bucket plus Mixed, Needs evidence, All candidates and a summary.</span>
        </div>

        <div className="flex flex-col gap-3 border-t px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show bucket">
            {AC_TABS.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={activeTab === t}
                onClick={() => setTab(t)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25",
                  activeTab === t ? "border-primary/40 bg-accent text-accent-foreground" : "bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {AC_TAB_LABEL[t]} <span className="tabular-nums opacity-80">{counts[t]}</span>
              </button>
            ))}
          </div>
          <div className="relative w-full shrink-0 lg:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input className="h-9 pl-9" placeholder="Search name, mobile, email" aria-label="Search name, mobile or email" value={query} onChange={(e) => setQuery(e.target.value)} />
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
                <TableHead>Bucket</TableHead>
                <TableHead>Scores</TableHead>
                <TableHead className="text-right">Priority score</TableHead>
                <TableHead>Signals</TableHead>
                <TableHead>Eligible via</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((row) => {
                const isOpen = open === row.id;
                const c = row.candidate;
                return (
                  <React.Fragment key={row.id}>
                    <TableRow className={cn("cursor-pointer", isOpen && "bg-accent/40")} onClick={() => setOpen(isOpen ? null : row.id)}>
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
                      <TableCell className="text-right align-top tabular-nums">{row.rank || "—"}</TableCell>
                      <TableCell className="align-top">
                        <div className="max-w-[220px] truncate font-medium" title={c.name || undefined}>
                          {c.name || <span className="text-muted-foreground">—</span>}
                        </div>
                        <div className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                          {c.mobile || c.email}
                          {row.priority ? (
                            <Badge variant={row.priority === "P1" ? "highlight" : "secondary"} className="ml-1.5 px-1.5 py-0 text-[11px] leading-4">
                              {row.priority}
                            </Badge>
                          ) : null}
                        </div>
                        {c.resumeUrl ? (
                          <a
                            href={c.resumeUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 rounded-sm text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
                          >
                            Resume <ExternalLink className="h-3 w-3" aria-hidden />
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">No resume</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[260px] align-top">
                        <div className="flex flex-wrap items-center gap-1">
                          <PlacementBadge row={row} />
                          {row.nudgedFrom ? (
                            <Badge variant="outline" title="Moved by the temporary rebalancing">
                              <ArrowRightLeft aria-hidden />
                              from {AC_BUCKET_LABEL[row.nudgedFrom]}
                            </Badge>
                          ) : null}
                        </div>
                        {row.mixedWith.length ? (
                          <p className="mt-1 text-xs font-medium">{row.mixedWith.map((b) => `${AC_BUCKET_LABEL[b]} ${row.scores[b]}`).join(" · ")}</p>
                        ) : null}
                        {row.tag ? <p className="mt-1 line-clamp-2 text-xs text-warning">{row.tag}</p> : null}
                        {row.confidence && row.placement !== "mixed" && !/confidence/i.test(row.tag) ? (
                          <p className="mt-0.5 text-[11px] text-muted-foreground">{row.confidence} confidence</p>
                        ) : null}
                        {!row.placement && row.reasons[0] ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{row.reasons[0]}</p> : null}
                        {row.trust && (row.placement || row.status === "Needs evidence") ? (
                          <div className="mt-1">
                            <TrustBadge trust={row.trust} />
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="align-top">
                        <ScoreBars row={row} />
                      </TableCell>
                      <TableCell className="text-right align-top">
                        {row.placement ? (
                          <>
                            <div className="text-[15px] font-semibold tabular-nums">{row.priorityScore}</div>
                            <div className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground" title="Stack fit · assessments · DSA">
                              {row.fit} · {row.assessment.score} · {rules.signals.dsa ? row.dsa.score : "—"}
                            </div>
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[160px] align-top text-xs">
                        {row.used.length ? row.used.map((k) => SIGNAL_LABEL[k]).join(", ") : <span className="text-muted-foreground">none</span>}
                        {row.result?.status === "error" ? (
                          <div className={row.result.retryable ? "text-destructive" : "text-warning"}>{row.result.retryable ? "Read failed — re-run" : "Resume not readable"}</div>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-[180px] align-top text-xs text-muted-foreground">{c.eligibility.via.join(", ") || "—"}</TableCell>
                    </TableRow>
                    {isOpen ? (
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableCell colSpan={8} className="py-4">
                          <Details row={row} rules={rules} />
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
              icon={running && !readDone ? <Loader2 className="animate-spin" /> : <Search />}
              title={running && !readDone ? "Reading the first resumes…" : "No candidates in this view."}
              description={running && !readDone ? undefined : "Pick another bucket or clear the search."}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}
