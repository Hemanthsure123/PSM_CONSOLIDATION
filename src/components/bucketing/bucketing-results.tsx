"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, Download, Loader2, PauseCircle, Play, RotateCcw, Search, Square, Users } from "lucide-react";
import { ActionBar } from "@/components/ui/action-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { Panel } from "@/components/ui/panel";
import { Progress } from "@/components/ui/progress";
import { NativeSelect } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SERIES_NEUTRAL } from "@/components/charts";
import { BucketingPaste, type ParsedInput } from "@/components/bucketing/bucketing-paste";
import { BUCKET_COLOR, CandidateDetail, TierBadge } from "@/components/bucketing/candidate-detail";
import { BUCKET_LABEL, BUCKET_RULE, BUCKETS, DOMAIN_LABEL, REASON_TEXT, STAGE_LABEL, STAGE_TIER, type Bucket, type Stage } from "@/lib/bucketing/config";
import { buildBucketCsv, buildCompleteCsv, buildNotBucketedCsv, rankBuckets } from "@/lib/bucketing/csv";
import type { BucketingBatch, BucketingCandidateInput, BucketingResult } from "@/lib/bucketing/types";
import { cn, slugify } from "@/lib/utils";

export const CONCURRENCY_OPTIONS = [2, 3, 4, 6, 8];

type Tab = Bucket | "NOT" | "RETRY";

interface Props {
  title: string;
  candidates: BucketingCandidateInput[];
  results: Record<string, BucketingResult>;
  batches: BucketingBatch[];
  defaultStage: Stage;
  running: boolean;
  active: number;
  /** GitHub budget pause: resumes at this time. */
  pausedUntil: string;
  githubLeft: number | null;
  concurrency: number;
  onConcurrencyChange: (n: number) => void;
  onRun: (targets: BucketingCandidateInput[]) => void;
  onStop: () => void;
  onBack: () => void;
  onAddBatch: (input: ParsedInput) => void;
  storageError: string;
}

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

const STAGES: Stage[] = ["TR2", "TR1", "ASSESSMENT"];
const PAGE = 100;

export function BucketingResults(p: Props) {
  const all = React.useMemo(() => Object.values(p.results), [p.results]);
  const ranked = React.useMemo(() => rankBuckets(all), [all]);
  const pending = React.useMemo(
    () => p.candidates.filter((c) => c.resumeUrl && !p.results[c.id]).sort((a, b) => STAGE_TIER[a.stage] - STAGE_TIER[b.stage]),
    [p.candidates, p.results],
  );
  // "Re-run needed" rows whose resume link the run still knows (an imported file may not carry it).
  const rerunnable = React.useMemo(
    () => ranked.retry.map((r) => p.candidates.find((c) => c.id === r.id)).filter((c): c is BucketingCandidateInput => Boolean(c?.resumeUrl)),
    [ranked.retry, p.candidates],
  );
  const [tab, setTab] = React.useState<Tab>("MERN");
  const [query, setQuery] = React.useState("");
  const [reviewOnly, setReviewOnly] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const [limit, setLimit] = React.useState(PAGE);
  const [adding, setAdding] = React.useState(false);
  const [newRows, setNewRows] = React.useState<ParsedInput>({ candidates: [], noResume: [] });
  const existing = React.useMemo(() => new Map(p.candidates.map((c) => [c.id, c.batch])), [p.candidates]);

  // Open on the first bucket that has someone in it.
  const picked = React.useRef(false);
  React.useEffect(() => {
    if (picked.current) return;
    const first = BUCKETS.find((b) => ranked.buckets[b].length);
    if (first) {
      setTab(first);
      picked.current = true;
    }
  }, [ranked]);

  const total = p.candidates.length;
  const done = all.length;
  const pct = total ? Math.round((100 * done) / total) : 0;
  const rows = tab === "NOT" ? ranked.notBucketed : tab === "RETRY" ? ranked.retry : ranked.buckets[tab];
  const q = query.trim().toLowerCase();
  const shown = rows.filter((r) => (!reviewOnly || r.trust.needsReview) && (!q || r.name.toLowerCase().includes(q) || r.mobile.includes(q)));
  const slug = slugify(p.title);
  const bucketed = BUCKETS.reduce((s, b) => s + ranked.buckets[b].length, 0);
  const bucketTab = tab !== "NOT" && tab !== "RETRY";

  const stageSplit = (rs: BucketingResult[]) => STAGES.map((s) => rs.filter((r) => r.stage === s).length);

  const tabTitle = tab === "NOT" ? "Not bucketed" : tab === "RETRY" ? "Re-run needed" : BUCKET_LABEL[tab];
  const tabDescription =
    tab === "NOT" ? (
      "Each with the reason, TR-2 first. Open a row to see every check behind the decision."
    ) : tab === "RETRY" ? (
      "Evidence was unavailable for these candidates. Open a row to see what failed."
    ) : (
      <>
        Ranked TR-2, then TR-1, then Assessment, then by overall score.{" "}
        <InfoHint label="Bucket rule" align="start">
          <span className="font-medium">Rule:</span> {BUCKET_RULE[tab]}
        </InfoHint>
      </>
    );

  return (
    <div className="space-y-6">
      {/* The run */}
      <div className="min-w-0">
        <h2 className="truncate font-display text-[20px] font-semibold leading-7 tracking-[-0.015em]">{p.title}</h2>
        <p className="text-[13px] text-muted-foreground tabular-nums">
          {done} of {total} evaluated · {bucketed} bucketed · {ranked.notBucketed.length} not bucketed
          {ranked.retry.length ? ` · ${ranked.retry.length} need a re-run` : ""}
          {pending.length ? ` · ${pending.length} waiting` : ""}
        </p>
      </div>

      {p.storageError ? <Notice tone="danger">{p.storageError}</Notice> : null}

      {/* Bucket counts — each tile opens its list */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7" role="group" aria-label="Buckets">
        {[...BUCKETS, "NOT" as const, "RETRY" as const].map((t) => {
          const rs = t === "NOT" ? ranked.notBucketed : t === "RETRY" ? ranked.retry : ranked.buckets[t];
          const [a, b, c] = stageSplit(rs);
          const label = t === "NOT" ? "Not bucketed" : t === "RETRY" ? "Re-run needed" : BUCKET_LABEL[t];
          const selected = tab === t;
          return (
            <button
              key={t}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setTab(t);
                setOpen(null);
                setLimit(PAGE);
              }}
              title={t === "NOT" || t === "RETRY" ? label : BUCKET_RULE[t]}
              className={cn(
                "min-w-0 rounded-xl border bg-card px-4 py-3.5 text-left shadow-surface transition-[border-color,background-color,box-shadow] duration-150 hover:border-[hsl(218_20%_75%)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25",
                selected && "border-primary bg-accent/50 ring-1 ring-primary hover:border-primary",
              )}
            >
              <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                {t === "RETRY" ? (
                  <RotateCcw className={cn("h-3.5 w-3.5 shrink-0", rs.length ? "text-warning" : "text-muted-foreground")} aria-hidden />
                ) : (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: t === "NOT" ? SERIES_NEUTRAL : BUCKET_COLOR[t] }}
                    aria-hidden
                  />
                )}
                <span className="truncate">{label}</span>
              </div>
              <div className="mt-1 font-display text-[26px] font-semibold leading-8 tracking-[-0.02em] tabular-nums">{rs.length}</div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground tabular-nums">
                TR-2 {a} · TR-1 {b} · Asmt {c}
              </div>
            </button>
          );
        })}
      </div>

      {/* The selected list */}
      <Panel
        flush
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {tab !== "NOT" && tab !== "RETRY" ? (
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: BUCKET_COLOR[tab] }} aria-hidden />
            ) : null}
            {tabTitle}
            <span className="rounded-md bg-secondary px-2 py-0.5 font-sans text-xs font-medium text-muted-foreground tabular-nums">{shown.length}</span>
          </span>
        }
        description={tabDescription}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={!rows.length}
              onClick={() =>
                tab === "NOT" || tab === "RETRY"
                  ? download(`${slug}-not-bucketed.csv`, buildNotBucketedCsv(all, p.candidates))
                  : download(`${slug}-${tab.toLowerCase()}.csv`, buildBucketCsv(tab, all, p.candidates))
              }
            >
              <Download className="h-4 w-4" /> This list (CSV)
            </Button>
            <Button variant="outline" size="sm" onClick={() => download(`${slug}-all-candidates.csv`, buildCompleteCsv(all, p.candidates))} disabled={!done}>
              <Download className="h-4 w-4" /> All candidates (CSV)
            </Button>
          </>
        }
        footer={
          shown.length > limit ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground tabular-nums">
                Showing {limit} of {shown.length}
              </span>
              <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + PAGE)}>
                Show {Math.min(PAGE, shown.length - limit)} more
              </Button>
            </div>
          ) : undefined
        }
      >
        {/* Toolbar: filters */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t bg-muted/30 px-4 py-2.5">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              aria-label="Search name or mobile"
              placeholder="Search name or mobile"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9 pl-9"
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="bk-review-only" checked={reviewOnly} onCheckedChange={setReviewOnly} />
            <label htmlFor="bk-review-only" className="cursor-pointer text-[13px]">
              Needs review only
            </label>
          </div>
        </div>

        {shown.length === 0 ? (
          <div className="border-t p-4">
            <EmptyState
              icon={<Users />}
              title={done ? "Nobody here" : "No results yet"}
              description={done ? (q || reviewOnly ? "Clear the search or the review filter to see everyone in this list." : undefined) : "Results appear here as candidates finish."}
              className="py-10"
            />
          </div>
        ) : (
          <Table containerClassName="max-h-[75vh] border-t">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 pr-0">
                  <span className="sr-only">Details</span>
                </TableHead>
                {bucketTab ? <TableHead className="w-10 text-right">#</TableHead> : null}
                <TableHead>Candidate</TableHead>
                <TableHead>Stage</TableHead>
                {bucketTab ? (
                  <>
                    <TableHead className="text-right">Overall</TableHead>
                    <TableHead>Flagship project</TableHead>
                    <TableHead className="text-right">Domain</TableHead>
                    <TableHead className="text-right">DSA</TableHead>
                  </>
                ) : (
                  <TableHead>Why</TableHead>
                )}
                <TableHead>Trust</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.slice(0, limit).map((r, i) => {
                const isOpen = open === r.id;
                const techs = r.flagship ? r.flagship.techs.slice(0, 5).join(", ") : "";
                return (
                  <React.Fragment key={r.id}>
                    <TableRow
                      className={cn("cursor-pointer [&>td]:align-top", isOpen && "bg-accent/40")}
                      onClick={() => setOpen(isOpen ? null : r.id)}
                    >
                      <TableCell className="w-10 pr-0">
                        {/* No handler of its own: the click (or Enter / Space) reaches the row. */}
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? "Hide" : "Show"} details for ${r.name || r.mobile}`}
                          className="-m-1 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
                        >
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                      </TableCell>
                      {bucketTab ? <TableCell className="text-right tabular-nums text-muted-foreground">{i + 1}</TableCell> : null}
                      <TableCell>
                        <div className="max-w-[220px] truncate font-medium" title={r.name || undefined}>
                          {r.name || "—"}
                        </div>
                        <div className="text-xs text-muted-foreground tabular-nums">{r.mobile}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={r.stage === "TR2" ? "default" : r.stage === "TR1" ? "secondary" : "outline"}>{r.stageLabel}</Badge>
                        {r.flags.includes("TRACK_MISMATCH") ? <div className="mt-1 text-xs text-warning">Track not backed</div> : null}
                      </TableCell>
                      {bucketTab ? (
                        <>
                          <TableCell className="text-right text-[14px] font-semibold tabular-nums">{r.scores.overall}</TableCell>
                          <TableCell>
                            {r.flagship ? (
                              <>
                                <div className="flex items-center gap-1.5">
                                  <span className="max-w-[240px] truncate font-medium" title={r.flagship.title}>
                                    {r.flagship.title}
                                  </span>
                                  <TierBadge tier={r.flagship.tier} valid />
                                </div>
                                <div className="max-w-[280px] truncate text-xs text-muted-foreground" title={techs}>
                                  {techs}
                                </div>
                              </>
                            ) : (
                              <span className="text-xs text-muted-foreground">Internship-backed</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{r.scores.domain}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.scores.dsa}</TableCell>
                        </>
                      ) : (
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {r.reasonCodes.map((c) => (
                              <Badge key={c} variant="outline" className="font-normal">
                                {REASON_TEXT[c]}
                              </Badge>
                            ))}
                          </div>
                          {r.primaryDomain ? (
                            <div className="mt-1 text-xs text-muted-foreground">
                              Resume points to {DOMAIN_LABEL[r.primaryDomain.domain]} (<span className="tabular-nums">{r.primaryDomain.score}</span>)
                            </div>
                          ) : null}
                        </TableCell>
                      )}
                      <TableCell>
                        {r.trust.trust === null ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <Badge
                            variant={r.trust.band === "High" ? "success" : r.trust.band === "Medium" ? "secondary" : "destructive"}
                            className="whitespace-nowrap tabular-nums"
                          >
                            {r.trust.trust} {r.trust.band}
                          </Badge>
                        )}
                        {r.trust.needsReview ? <div className="mt-1 text-xs text-warning">Needs review</div> : null}
                      </TableCell>
                    </TableRow>
                    {isOpen ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={bucketTab ? 9 : 5} className="bg-muted/20 px-3 py-3 sm:px-4">
                          <CandidateDetail r={r} />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>

      {/* Add more candidates to this run */}
      <section className="rounded-xl border bg-card shadow-surface">
        <button
          type="button"
          aria-expanded={adding}
          aria-controls="bk-add-batch"
          onClick={() => setAdding((v) => !v)}
          className="flex w-full items-center justify-between gap-3 rounded-xl px-5 py-3.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
        >
          <span className="min-w-0">
            <span className="block font-display text-[15px] font-semibold tracking-[-0.01em]">Add batch {p.batches.length + 1}</span>
            <span className="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground">
              More rows join this run. Mobiles already in it are skipped, and TR-2 rows go to the front of the queue.
            </span>
          </span>
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150", adding && "rotate-180")} />
        </button>
        {adding ? (
          <div id="bk-add-batch" className="animate-fade-in space-y-4 border-t px-5 py-4">
            <BucketingPaste batch={p.batches.length + 1} existing={existing} defaultStage={p.defaultStage} onParsed={setNewRows} />
            <div className="flex justify-end">
              <Button
                disabled={!newRows.candidates.length && !newRows.noResume.length}
                onClick={() => {
                  p.onAddBatch(newRows);
                  setAdding(false);
                }}
              >
                <Play className="h-4 w-4" /> Add {newRows.candidates.length + newRows.noResume.length} and run
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      {/* Run status and controls */}
      <ActionBar
        status={
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                {p.running ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> {p.active} in progress · TR-2 first, then TR-1, then Assessment
                  </>
                ) : pending.length ? (
                  `${pending.length} waiting to run`
                ) : (
                  `All ${total} candidates evaluated`
                )}
              </span>
              {p.running || pending.length ? (
                <span className="tabular-nums">
                  {done} of {total} · {pct}%
                </span>
              ) : null}
            </div>
            {p.running || pending.length ? <Progress value={done} max={total} label="Candidates evaluated" /> : null}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              {STAGES.map((s) => {
                const of = p.candidates.filter((c) => c.stage === s);
                const ok = of.filter((c) => p.results[c.id]).length;
                return (
                  <span key={s} className="tabular-nums">
                    {STAGE_LABEL[s]}: <span className="font-medium text-foreground">{ok}</span>/{of.length}
                  </span>
                );
              })}
              {p.pausedUntil ? (
                <span className="inline-flex items-center gap-1 font-medium text-warning">
                  <PauseCircle className="h-3.5 w-3.5" /> GitHub hourly budget low, paused until{" "}
                  {new Date(p.pausedUntil).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                </span>
              ) : p.githubLeft !== null ? (
                <span className="tabular-nums">GitHub calls left this hour: {p.githubLeft}</span>
              ) : null}
            </div>
          </div>
        }
      >
        <div className="flex items-center gap-2">
          <label htmlFor="bk-conc-run" className="text-[13px] text-muted-foreground">
            In parallel
          </label>
          <NativeSelect
            id="bk-conc-run"
            value={p.concurrency}
            onChange={(e) => p.onConcurrencyChange(Number(e.target.value))}
            className="h-9 w-[76px] tabular-nums"
          >
            {CONCURRENCY_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </NativeSelect>
        </div>
        {!p.running && rerunnable.length ? (
          <Button variant="outline" onClick={() => p.onRun(rerunnable)}>
            <RotateCcw className="h-4 w-4" /> Re-run {rerunnable.length}
          </Button>
        ) : null}
        {p.running ? (
          <Button variant="outline" onClick={p.onStop}>
            <Square className="h-4 w-4" /> Stop
          </Button>
        ) : pending.length ? (
          <Button onClick={() => p.onRun(pending)}>
            <Play className="h-4 w-4" /> Resume ({pending.length})
          </Button>
        ) : null}
      </ActionBar>
    </div>
  );
}
