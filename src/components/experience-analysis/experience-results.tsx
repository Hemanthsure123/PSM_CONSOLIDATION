"use client";

import * as React from "react";
import {
  Briefcase,
  Building2,
  CircleAlert,
  CircleCheck,
  Clock3,
  Download,
  ExternalLink,
  GraduationCap,
  Loader2,
  Play,
  RotateCcw,
  Square,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { InfoHint } from "@/components/ui/info-hint";
import { Panel } from "@/components/ui/panel";
import { Progress } from "@/components/ui/progress";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SERIES, SERIES_NEUTRAL } from "@/components/charts";
import { EXPERIENCE_HEADERS, SUMMARY_HEADERS, buildExperienceCsvRows, buildSummaryCsvRows } from "@/lib/experience-csv";
import type { ExperienceCandidateInput, ExperienceResult } from "@/lib/experience-types";
import { cn, slugify, toCsv } from "@/lib/utils";

interface ExperienceResultsProps {
  title: string;
  subtitle: string;
  candidates: ExperienceCandidateInput[];
  results: Record<string, ExperienceResult>;
  running: boolean;
  active: string[];
  concurrency: number;
  onRun: (targets: ExperienceCandidateInput[]) => void;
  onStop: () => void;
  onBack?: () => void;
}

function download(name: string, headers: readonly string[], rows: Record<string, string>[]) {
  const blob = new Blob(["﻿" + toCsv([...headers], rows)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Experience type marks: a fixed series slot per type (never by rank), neutral for "Other".
 * The colour sits on a small mark beside the type name; the text stays in ink.
 */
const TYPE_COLOR: Record<string, string> = {
  Internship: SERIES[0],
  "Virtual Internship": SERIES[1],
  "Full-time": SERIES[2],
  "Part-time": SERIES[3],
  "Freelance / Contract": SERIES[4],
  Research: SERIES[5],
  Apprenticeship: SERIES[6],
  Other: SERIES_NEUTRAL,
};

export function ExperienceResults({
  title,
  subtitle,
  candidates,
  results,
  running,
  active,
  concurrency,
  onRun,
  onStop,
}: ExperienceResultsProps) {
  const pending = candidates.filter((c) => !results[c.id]);
  const failed = candidates.filter((c) => results[c.id]?.status === "error");
  const done = candidates.length - pending.length;
  const pct = candidates.length ? Math.round((done / candidates.length) * 100) : 0;

  const stats = React.useMemo(() => {
    const list = Object.values(results);
    const withExp = list.filter((r) => r.status === "ok");
    const entries = withExp.flatMap((r) => r.entries);
    const months = withExp.map((r) => r.totalMonths).filter((m): m is number => typeof m === "number");
    const times = list.map((r) => r.durationMs).filter((ms) => ms > 0);
    return {
      withExp: withExp.length,
      internships: entries.filter((e) => e.type === "Internship" || e.type === "Virtual Internship").length,
      entries: entries.length,
      avgMonths: months.length ? Math.round((months.reduce((a, b) => a + b, 0) / months.length) * 10) / 10 : 0,
      avgSecs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length / 1000) : 0,
    };
  }, [results]);

  const eta =
    running && pending.length && stats.avgSecs
      ? ` · about ${Math.ceil((stats.avgSecs * pending.length) / Math.max(1, concurrency) / 60)} min left`
      : "";

  const ordered = candidates.filter((c) => results[c.id]);
  // The one solid button: the run control while resumes are left, the Experience CSV once all are read.
  const runIsPrimary = !running && pending.length > 0;

  return (
    <div className="space-y-6">
      <Panel
        icon={<Briefcase />}
        title={title}
        description={subtitle || undefined}
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
                  resumes analysed{eta}
                </span>
              </span>
              <span className="tabular-nums text-muted-foreground">{pct}%</span>
            </div>
            <Progress value={done} max={candidates.length} label="Resumes analysed" tone={!running && !pending.length ? "success" : "primary"} />
          </div>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[13px] text-muted-foreground" aria-live="polite">
              {running && active.length ? (
                <>
                  Reading <span className="tabular-nums">{active.length}</span> resume{active.length === 1 ? "" : "s"}…
                </>
              ) : null}
            </p>
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
                  <Play className="h-4 w-4" /> {done ? `Resume — ${pending.length} left` : `Analyse ${pending.length} resumes`}
                </Button>
              ) : (
                <Badge variant="success" className="px-2.5 py-1 text-[13px]">
                  <CircleCheck aria-hidden className="!size-4" />
                  All {candidates.length} resumes analysed
                </Badge>
              )}
            </div>
          </div>
        </div>
      </Panel>

      <StatGrid cols={5}>
        <Stat icon={<Users />} label="Analysed" value={done} hint={`of ${candidates.length}`} />
        <Stat icon={<Briefcase />} label="With experience" value={stats.withExp} />
        <Stat icon={<Building2 />} label="Experiences found" value={stats.entries} />
        <Stat icon={<GraduationCap />} label="Internships" value={stats.internships} />
        <Stat icon={<Clock3 />} label="Avg months" value={stats.avgMonths} hint="candidates with experience" />
      </StatGrid>

      <Panel
        flush
        title={
          <span className="inline-flex items-center gap-1">
            Internship and work experience
            <InfoHint label="How the rows are built" align="start">
              Duration is normalised to months from the dates or the stated length. Tech stack lists only technologies the resume names
              for that role; otherwise the context says what they did. The Experience CSV has the same rows in a fixed column order for
              Google Sheets filters.
            </InfoHint>
          </span>
        }
        description="One row per internship or job."
      >
        <div className="flex flex-wrap items-center gap-2 border-t bg-muted/40 px-5 py-3">
          <span className="mr-1 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
            Download CSV
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!done}
            onClick={() =>
              download(`${slugify(title)}-candidate-summary.csv`, SUMMARY_HEADERS, buildSummaryCsvRows(candidates, results))
            }
          >
            <Download className="h-4 w-4" /> Candidate summary CSV
          </Button>
          <Button
            variant={runIsPrimary ? "outline" : "default"}
            size="sm"
            disabled={!done}
            onClick={() =>
              download(`${slugify(title)}-experience.csv`, EXPERIENCE_HEADERS, buildExperienceCsvRows(candidates, results))
            }
          >
            <Download className="h-4 w-4" /> Experience CSV
          </Button>
        </div>
        {ordered.length ? (
          <Table containerClassName="max-h-[560px] border-t">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Candidate</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Tech stack / context</TableHead>
                <TableHead className="text-right">Total exp.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ordered.flatMap((c) => {
                const r = results[c.id];
                const who = (span: number) => (
                  <TableCell rowSpan={span} className="align-top">
                    <div className="max-w-[200px] truncate font-medium" title={r.name || undefined}>
                      {r.name || <span className="text-muted-foreground">—</span>}
                    </div>
                    <div className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{r.mobile}</div>
                    {/^https?:\/\//i.test(r.resumeUrl) ? (
                      <a
                        href={r.resumeUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-sm text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
                      >
                        Resume <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                    ) : null}
                  </TableCell>
                );
                const total = (span: number) => (
                  <TableCell rowSpan={span} className="whitespace-nowrap text-right align-top font-semibold tabular-nums">
                    {typeof r.totalMonths === "number" ? `${r.totalMonths} mo` : <span className="font-normal text-muted-foreground">—</span>}
                  </TableCell>
                );
                if (!r.entries.length) {
                  return [
                    <TableRow key={c.id} className={cn(active.includes(c.id) && "opacity-60")}>
                      {who(1)}
                      <TableCell colSpan={4} className="align-top text-muted-foreground">
                        {r.status === "error" ? (
                          <span className="inline-flex items-start gap-1.5 text-destructive">
                            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                            {r.error}
                          </span>
                        ) : (
                          "No internship or work experience in the resume."
                        )}
                      </TableCell>
                      {total(1)}
                    </TableRow>,
                  ];
                }
                return r.entries.map((e, i) => (
                  <TableRow key={`${c.id}-${i}`}>
                    {i === 0 ? who(r.entries.length) : null}
                    <TableCell className="align-top">
                      <div className="max-w-[220px] truncate font-medium" title={e.company || undefined}>
                        {e.company || <span className="text-muted-foreground">—</span>}
                      </div>
                      <span className="mt-1 inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
                        <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: TYPE_COLOR[e.type] ?? SERIES_NEUTRAL }} aria-hidden />
                        {e.type}
                      </span>
                    </TableCell>
                    <TableCell className="min-w-[140px] max-w-[220px] align-top">{e.role || <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="whitespace-nowrap align-top" title={e.durationText || "Not mentioned"}>
                      {e.durationLabel || <span className="text-muted-foreground">{e.durationText ? "Unclear" : "—"}</span>}
                      {e.ongoing ? (
                        <div className="mt-0.5">
                          <Badge variant="success" className="px-1.5 text-[11px] leading-[18px]">
                            Current
                          </Badge>
                        </div>
                      ) : null}
                      {e.durationText ? <div className="max-w-[180px] truncate text-[11px] text-muted-foreground">{e.durationText}</div> : null}
                    </TableCell>
                    <TableCell className="min-w-[220px] max-w-[420px] align-top">
                      {e.techStack.length ? (
                        <div className="mb-1 flex flex-wrap gap-1">
                          {e.techStack.map((t) => (
                            <Badge key={t} variant="secondary" className="px-1.5 py-0 text-[11px]">
                              {t}
                            </Badge>
                          ))}
                        </div>
                      ) : null}
                      <p className="line-clamp-2 text-xs text-muted-foreground" title={e.context}>
                        {e.context}
                      </p>
                    </TableCell>
                    {i === 0 ? total(r.entries.length) : null}
                  </TableRow>
                ));
              })}
            </TableBody>
          </Table>
        ) : (
          <div className="border-t p-5">
            <EmptyState
              icon={running ? <Loader2 className="animate-spin" /> : <Briefcase />}
              title={running ? "Reading the first resumes…" : "No resumes analysed yet."}
              description={running ? "Rows appear here as each resume is read." : undefined}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}
