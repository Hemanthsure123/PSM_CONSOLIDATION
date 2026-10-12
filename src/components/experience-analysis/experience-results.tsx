"use client";

import * as React from "react";
import {
  ArrowLeft,
  Briefcase,
  Building2,
  Clock3,
  Download,
  ExternalLink,
  Loader2,
  Play,
  RotateCcw,
  Square,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatTile } from "@/components/charts";
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

const TYPE_STYLE: Record<string, string> = {
  Internship: "bg-sky-100 text-sky-800",
  "Virtual Internship": "bg-slate-100 text-slate-700",
  "Full-time": "bg-emerald-100 text-emerald-800",
  "Part-time": "bg-teal-100 text-teal-800",
  "Freelance / Contract": "bg-amber-100 text-amber-800",
  Research: "bg-violet-100 text-violet-800",
  Apprenticeship: "bg-indigo-100 text-indigo-800",
  Other: "bg-slate-100 text-slate-700",
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
  onBack,
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {onBack ? (
            <Button variant="ghost" size="sm" onClick={onBack} disabled={running}>
              <ArrowLeft className="h-4 w-4" /> Dashboard
            </Button>
          ) : null}
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Briefcase className="h-4 w-4 text-muted-foreground" /> {title}
            </h2>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={!done}
            onClick={() =>
              download(`${slugify(title)}-candidate-summary.csv`, SUMMARY_HEADERS, buildSummaryCsvRows(candidates, results))
            }
          >
            <Download className="h-4 w-4" /> Candidate summary CSV
          </Button>
          <Button
            disabled={!done}
            onClick={() =>
              download(`${slugify(title)}-experience.csv`, EXPERIENCE_HEADERS, buildExperienceCsvRows(candidates, results))
            }
          >
            <Download className="h-4 w-4" /> Experience CSV
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex justify-between text-sm">
            <span className="inline-flex items-center gap-2 font-medium">
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {done} of {candidates.length} resumes analysed{eta}
            </span>
            <span className="tabular-nums text-muted-foreground">{pct}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {running ? (
              <Button variant="outline" onClick={onStop}>
                <Square className="h-4 w-4" /> Stop (finish in-flight)
              </Button>
            ) : pending.length ? (
              <Button onClick={() => onRun(pending)}>
                <Play className="h-4 w-4" /> {done ? `Resume — ${pending.length} left` : `Analyse ${pending.length} resumes`}
              </Button>
            ) : (
              <Badge variant="success" className="px-3 py-1.5 text-sm">
                All {candidates.length} resumes analysed
              </Badge>
            )}
            {!running && failed.length ? (
              <Button variant="outline" onClick={() => onRun(failed)}>
                <RotateCcw className="h-4 w-4" /> Re-run {failed.length} failed
              </Button>
            ) : null}
            {running && active.length ? (
              <span className="text-sm text-muted-foreground">Reading {active.length} resume{active.length === 1 ? "" : "s"}…</span>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile icon={<Users className="h-5 w-5" />} label="Analysed" value={done} accent="#4f46e5" />
        <StatTile icon={<Briefcase className="h-5 w-5" />} label="With experience" value={stats.withExp} accent="#10b981" />
        <StatTile icon={<Building2 className="h-5 w-5" />} label="Experiences found" value={stats.entries} accent="#0ea5e9" />
        <StatTile icon={<Building2 className="h-5 w-5" />} label="Internships" value={stats.internships} accent="#f59e0b" />
        <StatTile icon={<Clock3 className="h-5 w-5" />} label="Avg months (with exp.)" value={stats.avgMonths} accent="#8b5cf6" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Internship &amp; work experience</CardTitle>
          <CardDescription>
            One row per internship / job. Duration is normalised to months from the dates or the stated length; tech
            stack lists only technologies the resume names for that role — otherwise the context says what they did.
            The Experience CSV has the same rows in a fixed column order for Google Sheets filters.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Candidate</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="whitespace-nowrap">Duration</TableHead>
                  <TableHead>Tech stack / context</TableHead>
                  <TableHead className="whitespace-nowrap text-right">Total exp.</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ordered.flatMap((c) => {
                  const r = results[c.id];
                  const who = (span: number) => (
                    <TableCell rowSpan={span} className="align-top">
                      <div className="font-medium">{r.name || <span className="text-muted-foreground">—</span>}</div>
                      <div className="font-mono text-xs text-muted-foreground">{r.mobile}</div>
                      {/^https?:\/\//i.test(r.resumeUrl) ? (
                        <a
                          href={r.resumeUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          Resume <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : null}
                    </TableCell>
                  );
                  const total = (span: number) => (
                    <TableCell rowSpan={span} className="text-right align-top font-semibold tabular-nums">
                      {typeof r.totalMonths === "number" ? `${r.totalMonths} mo` : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  );
                  if (!r.entries.length) {
                    return [
                      <TableRow key={c.id} className={cn(active.includes(c.id) && "opacity-60")}>
                        {who(1)}
                        <TableCell colSpan={4} className="text-sm text-muted-foreground">
                          {r.status === "error" ? (
                            <span className="text-destructive">{r.error}</span>
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
                        <div className="font-medium">{e.company || <span className="text-muted-foreground">—</span>}</div>
                        <span className={cn("mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium", TYPE_STYLE[e.type])}>
                          {e.type}
                        </span>
                      </TableCell>
                      <TableCell className="align-top text-sm">{e.role || <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="whitespace-nowrap align-top text-sm" title={e.durationText || "Not mentioned"}>
                        {e.durationLabel || <span className="text-muted-foreground">{e.durationText ? "Unclear" : "—"}</span>}
                        {e.ongoing ? <div className="text-[11px] text-emerald-700">Current</div> : null}
                        {e.durationText ? <div className="text-[11px] text-muted-foreground">{e.durationText}</div> : null}
                      </TableCell>
                      <TableCell className="max-w-[420px] align-top">
                        {e.techStack.length ? (
                          <div className="mb-1 flex flex-wrap gap-1">
                            {e.techStack.map((t) => (
                              <Badge key={t} variant="secondary" className="px-1.5 py-0 text-[11px] font-medium">
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
                {!ordered.length ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                      {running ? "Reading the first resumes…" : "No resumes analysed yet."}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
