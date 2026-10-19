"use client";

import * as React from "react";
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Copy,
  Download,
  ExternalLink,
  ListChecks,
  Loader2,
  Play,
  RotateCcw,
  Square,
  Star,
  Trophy,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Notice } from "@/components/ui/notice";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionBar } from "@/components/ui/action-bar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { buildAssignmentCsv } from "@/lib/assignment-csv";
import { bandLabel, rankEvaluations } from "@/lib/assignment-scoring";
import type {
  AssignmentRunConfig,
  AssignmentSpec,
  CandidateEvaluation,
  CandidateInput,
  CriterionStatus,
  SelectionStatus,
} from "@/lib/assignment-types";
import { cn, slugify, toCsv } from "@/lib/utils";

/** Status → badge. "Shortlisted" marks use the highlighter; review / failure use status tokens. */
const STATUS_VARIANT: Record<SelectionStatus, NonNullable<BadgeProps["variant"]>> = {
  "Strongly Shortlisted": "highlight",
  Shortlisted: "highlight",
  "Borderline – Manual Review": "warning",
  "AI Generated – Review Manually": "warning",
  "Not Shortlisted": "secondary",
  "Invalid Submission": "outline",
  Error: "destructive",
};

const STATUSES = Object.keys(STATUS_VARIANT) as SelectionStatus[];

function StatusBadge({ status, count }: { status: SelectionStatus; count?: number }) {
  return (
    <Badge variant={STATUS_VARIANT[status]} className={cn(status === "Invalid Submission" && "text-destructive")}>
      {status === "Strongly Shortlisted" ? <Star /> : null}
      {status === "AI Generated – Review Manually" ? <Bot /> : null}
      {status === "Error" ? <XCircle /> : null}
      {count !== undefined ? <span className="tabular-nums">{count}</span> : null}
      {status}
    </Badge>
  );
}

const CRITERION_STATUS: Record<CriterionStatus, { label: string; variant: NonNullable<BadgeProps["variant"]> }> = {
  met: { label: "Met", variant: "success" },
  partial: { label: "Partial", variant: "warning" },
  not_met: { label: "Not met", variant: "destructive" },
  unverified: { label: "Unverified", variant: "secondary" },
};

interface ResultsStepProps {
  spec: AssignmentSpec;
  config: AssignmentRunConfig;
  candidates: CandidateInput[];
  results: Record<string, CandidateEvaluation>;
  running: boolean;
  active: string[];
  error: string;
  onEvaluate: (targets: CandidateInput[]) => void;
  onStop: () => void;
  onBack: () => void;
  onCriteria: () => void;
}

function shortRepo(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
}

/** A short titled list inside a repo's review (skipped when empty). */
function DetailList({ title, items, tone }: { title: string; items: string[]; tone?: "danger" | "warning" }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="text-xs font-medium text-foreground">{title}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-muted-foreground">
        {items.map((item, i) => (
          <li
            key={i}
            className={cn(tone === "danger" && "marker:text-destructive", tone === "warning" && "marker:text-warning")}
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Everything the reviewer found for one repository: rubric scores with evidence, flags and AI signals. */
function RepoReview({ r, spec }: { r: CandidateEvaluation; spec: AssignmentSpec }) {
  const titles = new Map(spec.criteria.map((c) => [c.id, c.title]));
  const criteria = r.criteria ?? [];
  const flags = [...(r.restrictionViolations ?? []), ...(r.redFlags ?? [])];
  const ai = r.aiReview && r.aiReview.verdict !== "none" ? r.aiReview : null;
  const repo = r.repo;
  return (
    <div className="mt-2 space-y-3 border-t pt-3">
      {criteria.length ? (
        <div>
          <p className="text-xs font-medium text-foreground">Rubric</p>
          <ul className="mt-1.5 space-y-2">
            {criteria.map((c) => {
              const s = CRITERION_STATUS[c.status] ?? CRITERION_STATUS.unverified;
              return (
                <li key={c.id} className="text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0">
                      <span className="tabular-nums text-muted-foreground">{c.id}</span>{" "}
                      <span className="font-medium text-foreground">{titles.get(c.id) ?? ""}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <Badge variant={s.variant}>{s.label}</Badge>
                      <span className="w-9 text-right font-medium tabular-nums text-foreground">{c.score}/10</span>
                    </span>
                  </div>
                  {c.evidence ? (
                    <p className="mt-0.5 line-clamp-3 leading-relaxed text-muted-foreground" title={c.evidence}>
                      {c.evidence}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      <DetailList title="Missing features" items={r.missingFeatures ?? []} />
      <DetailList title="Red flags" items={flags} tone="danger" />
      {ai ? (
        <DetailList
          title={ai.verdict === "ai-generated" ? "AI generation evidence" : "Possible AI assistance"}
          items={[...ai.reasons, ...ai.commitEvidence, ...ai.commentEvidence]}
          tone="warning"
        />
      ) : null}
      {repo ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          <span className="tabular-nums">{repo.commits}</span> commits
          {repo.commitsAfterDeadline ? (
            <>
              {" "}
              (<span className="tabular-nums">{repo.commitsAfterDeadline}</span> after the deadline)
            </>
          ) : null}
          {" · "}
          <span className="tabular-nums">{repo.filesTotal}</span> files
          {repo.primaryLanguage ? ` · ${repo.primaryLanguage}` : ""}
          {` · README ${repo.hasReadme ? "yes" : "no"} · tests ${repo.hasTests ? "yes" : "no"}`}
          {repo.autoDetected && repo.autoDetectNote ? ` · ${repo.autoDetectNote}` : ""}
        </p>
      ) : null}
    </div>
  );
}

export function ResultsStep({
  spec,
  config,
  candidates,
  results,
  running,
  active,
  error,
  onEvaluate,
  onStop,
  onBack,
  onCriteria,
}: ResultsStepProps) {
  const pending = candidates.filter((c) => !results[c.id]);
  const failed = candidates.filter((c) => {
    const s = results[c.id]?.status;
    return s === "Error" || s === "Invalid Submission";
  });
  const done = candidates.length - pending.length;
  const ranked = React.useMemo(
    () => rankEvaluations(candidates.map((c) => results[c.id]).filter((r): r is CandidateEvaluation => Boolean(r))),
    [candidates, results],
  );
  const counts = React.useMemo(() => {
    const m = new Map<SelectionStatus, number>();
    for (const r of ranked) m.set(r.status, (m.get(r.status) ?? 0) + 1);
    return m;
  }, [ranked]);

  const exportCsv = () => {
    const { headers, rows } = buildAssignmentCsv(spec, candidates, results);
    const blob = new Blob(["﻿" + toCsv(headers, rows)], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugify(config.runName || spec.title)}-assignment-evaluation.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const pct = candidates.length ? Math.round((done / candidates.length) * 100) : 0;
  // Rough ETA from this run's own timings and the rolling-window width.
  const eta = React.useMemo(() => {
    const times = ranked.map((r) => r.durationMs ?? 0).filter((ms) => ms > 0);
    if (!times.length || !pending.length) return "";
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const mins = Math.ceil((avg * pending.length) / Math.max(1, config.concurrency) / 60_000);
    return `~${Math.round(avg / 1000)}s per repo · about ${mins} min left`;
  }, [ranked, pending.length, config.concurrency]);

  const n = (s: SelectionStatus) => counts.get(s) ?? 0;
  const strong = n("Strongly Shortlisted");
  const shortlisted = strong + n("Shortlisted");
  const aiFlagged = n("AI Generated – Review Manually");
  const review = n("Borderline – Manual Review") + aiFlagged;
  const complete = !running && !pending.length;
  const inFlight = active.filter((id) => !results[id]);

  return (
    <div className="space-y-6">
      {/* Numbers first. */}
      <StatGrid cols={5}>
        <Stat
          label="Evaluated"
          value={done}
          hint={`of ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}`}
          icon={<ClipboardList />}
        />
        <Stat
          label="Shortlisted"
          value={shortlisted}
          tone="highlight"
          hint={`${strong} strongly shortlisted`}
          icon={<Trophy />}
        />
        <Stat
          label="Manual review"
          value={review}
          tone={review ? "warning" : "default"}
          hint={aiFlagged ? `${aiFlagged} flagged as AI generated` : "Borderline or AI flagged"}
        />
        <Stat label="Not shortlisted" value={n("Not Shortlisted")} />
        <Stat
          label="Failed or invalid"
          value={failed.length}
          tone={failed.length ? "danger" : "default"}
          hint={failed.length ? "Re-run them from the bar below" : undefined}
        />
      </StatGrid>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Panel
        flush
        title={config.runName || spec.title}
        description={
          <span className="tabular-nums">
            {bandLabel(config.ctcBand)} · shortlist at {config.thresholds.shortlist}+, strong at {config.thresholds.strong}+,
            manual review at {config.thresholds.borderline}+ · {spec.criteria.filter((c) => c.enabled).length} criteria
            {config.deadline ? ` · deadline ${config.deadline}` : ""}
          </span>
        }
        actions={
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!done}>
            <Download className="h-4 w-4" /> Download results (CSV)
          </Button>
        }
      >
        {ranked.length || active.length ? (
          <>
            {ranked.length ? (
              <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
                {STATUSES.filter((s) => counts.get(s)).map((s) => (
                  <StatusBadge key={s} status={s} count={counts.get(s)} />
                ))}
              </div>
            ) : null}
            <Table containerClassName="max-h-[75vh] border-t">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 text-right">#</TableHead>
                  <TableHead>Mobile</TableHead>
                  <TableHead>Repository</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead className="text-right">Chance</TableHead>
                  <TableHead className="text-right">Mandatory</TableHead>
                  <TableHead>Review</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inFlight.map((id) => (
                  <TableRow key={`active-${id}`} className="bg-muted/40">
                    <TableCell />
                    <TableCell className="whitespace-nowrap tabular-nums">{id}</TableCell>
                    <TableCell colSpan={6} className="text-muted-foreground">
                      <Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin" /> Downloading and reviewing the repository…
                    </TableCell>
                  </TableRow>
                ))}
                {ranked.map((r, i) => {
                  const scored = r.status !== "Error" && r.status !== "Invalid Submission";
                  const repoUrl = r.repo?.resolvedRepo || r.githubUrl;
                  const remark = r.error || r.remarks;
                  return (
                    <TableRow key={r.id} className={cn("align-top", active.includes(r.id) && "opacity-60")}>
                      <TableCell className="text-right align-top tabular-nums text-muted-foreground">
                        {scored ? i + 1 : ""}
                      </TableCell>
                      <TableCell className="whitespace-nowrap align-top tabular-nums">{r.id}</TableCell>
                      <TableCell className="max-w-[240px] align-top">
                        <a
                          href={repoUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-1 font-medium text-primary hover:underline"
                          title={repoUrl}
                        >
                          <span className="truncate">{shortRepo(repoUrl)}</span>
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </a>
                        {r.model ? (
                          <div className="truncate text-xs text-muted-foreground" title={r.model}>
                            {r.model}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="align-top">
                        <StatusBadge status={r.status} />
                        {r.similarity.length ? (
                          <div className="mt-1 flex items-center gap-1 text-xs text-destructive">
                            <Copy className="h-3 w-3 shrink-0" />
                            Possible copy of {r.similarity.map((s) => s.with).join(", ")}
                          </div>
                        ) : null}
                        {r.aiReview && r.aiReview.verdict !== "none" && r.status !== "AI Generated – Review Manually" ? (
                          <div
                            className={cn(
                              "mt-1 flex items-center gap-1 text-xs",
                              r.aiReview.verdict === "ai-generated" ? "font-medium text-warning" : "text-muted-foreground",
                            )}
                            title={[...r.aiReview.reasons, ...r.aiReview.commitEvidence, ...r.aiReview.commentEvidence].join("\n")}
                          >
                            <Bot className="h-3 w-3 shrink-0" />
                            {r.aiReview.verdict === "ai-generated"
                              ? "AI generated — review manually"
                              : "Possible AI assistance"}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right align-top font-semibold tabular-nums">
                        {scored ? r.overall : "—"}
                      </TableCell>
                      <TableCell className="text-right align-top tabular-nums">{scored ? `${r.chance}%` : "—"}</TableCell>
                      <TableCell className="text-right align-top tabular-nums">
                        {scored ? `${r.mandatoryMet}/${r.mandatoryTotal}` : "—"}
                      </TableCell>
                      <TableCell className="min-w-[260px] max-w-[420px] align-top">
                        {scored ? (
                          <details className="group">
                            <summary className="cursor-pointer list-none rounded-md focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25 [&::-webkit-details-marker]:hidden">
                              <span
                                className="line-clamp-2 text-xs leading-relaxed text-muted-foreground group-open:line-clamp-none"
                                title={remark}
                              >
                                {remark}
                              </span>
                              <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary">
                                <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                                <span className="group-open:hidden">Show review</span>
                                <span className="hidden group-open:inline">Hide review</span>
                              </span>
                            </summary>
                            <RepoReview r={r} spec={spec} />
                          </details>
                        ) : (
                          <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground" title={remark}>
                            {remark}
                          </p>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </>
        ) : (
          <div className="px-5 pb-5">
            <EmptyState
              icon={<ListChecks />}
              title="No results yet"
              description="Each repository is downloaded, read end to end and scored against the rubric. Start the evaluation from the bar below."
            />
          </div>
        )}
      </Panel>

      <ActionBar
        status={
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              {complete ? (
                <span className="inline-flex items-center gap-1.5 font-medium text-success">
                  <CheckCircle2 className="h-4 w-4" /> All {candidates.length} candidates evaluated
                </span>
              ) : (
                <span className="tabular-nums">
                  {done} of {candidates.length} evaluated{eta ? ` · ${eta}` : ""}
                </span>
              )}
              <span className="tabular-nums">{pct}%</span>
            </div>
            <Progress
              value={done}
              max={Math.max(1, candidates.length)}
              tone={complete ? "success" : "primary"}
              label="Repositories evaluated"
            />
            {running && active.length ? (
              <p className="truncate text-xs" title={active.join(", ")}>
                <Loader2 className="mr-1.5 inline h-3 w-3 animate-spin" />
                Reviewing {active.join(", ")}…
              </p>
            ) : null}
          </div>
        }
      >
        <Button variant="ghost" onClick={onCriteria} disabled={running}>
          <ListChecks className="h-4 w-4" /> Criteria &amp; thresholds
        </Button>
        {!running && failed.length ? (
          <Button variant="outline" onClick={() => onEvaluate(failed)}>
            <RotateCcw className="h-4 w-4" /> Re-run {failed.length} failed / invalid
          </Button>
        ) : null}
        <Button variant="outline" onClick={onBack} disabled={running}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        {!running && pending.length ? (
          <Button onClick={() => onEvaluate(pending)}>
            <Play className="h-4 w-4" />
            {done === 0 ? `Evaluate ${pending.length} candidate${pending.length === 1 ? "" : "s"}` : `Resume — ${pending.length} left`}
          </Button>
        ) : running ? (
          <Button variant="outline" onClick={onStop}>
            <Square className="h-4 w-4" /> Stop (finish in-flight)
          </Button>
        ) : null}
      </ActionBar>
    </div>
  );
}
