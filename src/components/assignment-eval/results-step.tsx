"use client";

import * as React from "react";
import {
  ArrowLeft,
  Download,
  ExternalLink,
  ListChecks,
  Loader2,
  Play,
  RotateCcw,
  Square,
  Trophy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { buildAssignmentCsv } from "@/lib/assignment-csv";
import { bandLabel, rankEvaluations } from "@/lib/assignment-scoring";
import type {
  AssignmentRunConfig,
  AssignmentSpec,
  CandidateEvaluation,
  CandidateInput,
  SelectionStatus,
} from "@/lib/assignment-types";
import { cn, slugify, toCsv } from "@/lib/utils";

const STATUS_STYLE: Record<SelectionStatus, string> = {
  "Strongly Shortlisted": "border-transparent bg-emerald-600 text-white",
  Shortlisted: "border-transparent bg-emerald-100 text-emerald-800",
  "Borderline – Manual Review": "border-transparent bg-amber-100 text-amber-800",
  "AI Generated – Review Manually": "border-transparent bg-violet-600 text-white",
  "Not Shortlisted": "border-transparent bg-slate-100 text-slate-700",
  "Invalid Submission": "border-rose-200 bg-rose-50 text-rose-700",
  Error: "border-transparent bg-destructive text-destructive-foreground",
};

const STATUSES = Object.keys(STATUS_STYLE) as SelectionStatus[];

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

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Trophy className="h-4 w-4" /> 4 · Evaluate — {config.runName || spec.title}
          </CardTitle>
          <CardDescription>
            {bandLabel(config.ctcBand)} · shortlist at {config.thresholds.shortlist}+, strong at {config.thresholds.strong}+,
            manual review at {config.thresholds.borderline}+ · {spec.criteria.filter((c) => c.enabled).length} criteria
            {config.deadline ? ` · deadline ${config.deadline}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>
                {done} of {candidates.length} evaluated{eta ? ` · ${eta}` : ""}
              </span>
              <span>{pct}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {STATUSES.filter((s) => counts.get(s)).map((s) => (
              <Badge key={s} className={STATUS_STYLE[s]}>
                {counts.get(s)} {s}
              </Badge>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {!running && pending.length ? (
              <Button onClick={() => onEvaluate(pending)}>
                <Play className="h-4 w-4" />
                {done === 0 ? `Evaluate ${pending.length} candidate${pending.length === 1 ? "" : "s"}` : `Resume — ${pending.length} left`}
              </Button>
            ) : !running ? (
              <Badge variant="success" className="gap-1 px-3 py-1.5 text-sm">
                <Trophy className="h-4 w-4" /> All {candidates.length} candidates evaluated
              </Badge>
            ) : (
              <Button variant="outline" onClick={onStop}>
                <Square className="h-4 w-4" /> Stop (finish in-flight)
              </Button>
            )}
            {!running && failed.length ? (
              <Button variant="outline" onClick={() => onEvaluate(failed)}>
                <RotateCcw className="h-4 w-4" /> Re-run {failed.length} failed / invalid
              </Button>
            ) : null}
            <Button variant="outline" onClick={exportCsv} disabled={!done}>
              <Download className="h-4 w-4" /> Export CSV
            </Button>
            {running ? (
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Reviewing {active.join(", ")}…
              </span>
            ) : null}
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>

      {ranked.length || active.length ? (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>Mobile</TableHead>
                  <TableHead>Repository</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead className="text-right">Chance</TableHead>
                  <TableHead className="text-right">Mandatory</TableHead>
                  <TableHead>Remarks</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {active
                  .filter((id) => !results[id])
                  .map((id) => (
                    <TableRow key={`active-${id}`} className="bg-muted/30">
                      <TableCell />
                      <TableCell className="font-mono text-xs">{id}</TableCell>
                      <TableCell colSpan={6} className="text-sm text-muted-foreground">
                        <Loader2 className="mr-2 inline h-3 w-3 animate-spin" /> Downloading and reviewing the repository…
                      </TableCell>
                    </TableRow>
                  ))}
                {ranked.map((r, i) => {
                  const scored = r.status !== "Error" && r.status !== "Invalid Submission";
                  const repoUrl = r.repo?.resolvedRepo || r.githubUrl;
                  return (
                    <TableRow key={r.id} className={cn(active.includes(r.id) && "opacity-60")}>
                      <TableCell className="text-xs text-muted-foreground">{scored ? i + 1 : ""}</TableCell>
                      <TableCell className="font-mono text-xs">{r.id}</TableCell>
                      <TableCell className="max-w-[220px]">
                        <a
                          href={repoUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-1 truncate text-sm text-primary hover:underline"
                          title={repoUrl}
                        >
                          <span className="truncate">{shortRepo(repoUrl)}</span>
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </a>
                        {r.model ? <div className="text-[11px] text-muted-foreground">{r.model}</div> : null}
                      </TableCell>
                      <TableCell>
                        <Badge className={cn("whitespace-nowrap", STATUS_STYLE[r.status])}>{r.status}</Badge>
                        {r.similarity.length ? (
                          <div className="mt-1 text-[11px] text-rose-700">
                            Possible copy of {r.similarity.map((s) => s.with).join(", ")}
                          </div>
                        ) : null}
                        {r.aiReview && r.aiReview.verdict !== "none" && r.status !== "AI Generated – Review Manually" ? (
                          <div
                            className={cn(
                              "mt-1 text-[11px]",
                              r.aiReview.verdict === "ai-generated" ? "font-medium text-violet-700" : "text-violet-500",
                            )}
                            title={[...r.aiReview.reasons, ...r.aiReview.commitEvidence, ...r.aiReview.commentEvidence].join("\n")}
                          >
                            {r.aiReview.verdict === "ai-generated"
                              ? "AI generated — review manually"
                              : "Possible AI assistance"}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{scored ? r.overall : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{scored ? `${r.chance}%` : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {scored ? `${r.mandatoryMet}/${r.mandatoryTotal}` : "—"}
                      </TableCell>
                      <TableCell className="max-w-[360px]">
                        <p className="line-clamp-2 text-xs text-muted-foreground" title={r.error || r.remarks}>
                          {r.error || r.remarks}
                        </p>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap justify-between gap-3">
        <Button variant="outline" onClick={onBack} disabled={running}>
          <ArrowLeft className="h-4 w-4" /> Candidates
        </Button>
        <Button variant="outline" onClick={onCriteria} disabled={running}>
          <ListChecks className="h-4 w-4" /> Criteria &amp; thresholds
        </Button>
      </div>
    </div>
  );
}
