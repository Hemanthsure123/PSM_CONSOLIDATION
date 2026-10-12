"use client";

import * as React from "react";
import {
  ArrowLeft,
  Building2,
  Download,
  Filter,
  Layers,
  Send,
  SlidersHorizontal,
  UserX,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DonutChart,
  FunnelChart,
  Legend,
  StackedFunnelChart,
  StatTile,
  type FunnelStageData,
  type Slice,
} from "@/components/charts";
import {
  TRACK_BUCKETS,
  trackColor,
  trackLabel,
  type SheetAnalysis,
  type TrackBucket,
} from "@/lib/company-sheet";
import { toCsv, slugify } from "@/lib/utils";

interface AnalysisViewProps {
  analysis: SheetAnalysis;
  onBack: () => void;
  backLabel?: string;
}

function companySlices(company: Record<TrackBucket, number>): Slice[] {
  return TRACK_BUCKETS.map((b) => ({ label: b.label, value: company[b.id], color: b.color }));
}

function stageData(analysis: SheetAnalysis): FunnelStageData[] {
  return analysis.stages.map((s) => ({
    label: s.round,
    total: s.total,
    segments: TRACK_BUCKETS.map((b) => ({ label: b.label, value: s.counts[b.id], color: b.color })),
  }));
}

export function AnalysisView({ analysis, onBack, backLabel = "Back" }: AnalysisViewProps) {
  const { company, candidates, roundColumns } = analysis;
  const tracked = company.edge + company.academy + company.external;
  const slices = companySlices(company);

  const [active, setActive] = React.useState<Set<TrackBucket>>(new Set());
  const toggle = (id: TrackBucket) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const visible = React.useMemo(
    () => (active.size === 0 ? candidates : candidates.filter((c) => active.has(c.bucket))),
    [candidates, active],
  );

  const downloadCandidates = () => {
    const headers = ["Name", "Identifier", "Subsheet", "Source", ...roundColumns];
    const rows = candidates.map((c) => ({
      Name: c.name,
      Identifier: c.identifier,
      Subsheet: c.subsheet,
      Source: trackLabel(c.bucket),
      ...c.rounds,
    }));
    downloadCsv(headers, rows, `${slugify(analysis.companyName)}-funnel-candidates.csv`);
  };

  const downloadFunnel = () => {
    const headers = ["Round", ...TRACK_BUCKETS.map((b) => b.label), "Total"];
    const rows = analysis.stages.map((s) => {
      const rec: Record<string, string> = { Round: s.round };
      for (const b of TRACK_BUCKETS) rec[b.label] = String(s.counts[b.id]);
      rec.Total = String(s.total);
      return rec;
    });
    downloadCsv(headers, rows, `${slugify(analysis.companyName)}-round-funnel.csv`);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" /> {backLabel}
          </Button>
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Building2 className="h-4 w-4 text-muted-foreground" /> {analysis.companyName}
            </h2>
            <p className="text-sm text-muted-foreground">
              {analysis.sheetTitle} · {analysis.subsheets.join(", ")}
            </p>
          </div>
        </div>
        <Button onClick={downloadCandidates} disabled={candidates.length === 0}>
          <Download className="h-4 w-4" /> Download candidates CSV
        </Button>
      </div>

      {analysis.note ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">{analysis.note}</p>
      ) : null}

      {/* Company-wise funnel: the source split of everyone sent. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Company funnel — source split</CardTitle>
          <CardDescription>
            Of the {analysis.total} candidates sent to {analysis.companyName}, how many came from
            each source.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-[1fr_1fr_1fr]">
          <div className="grid gap-4">
            <StatTile icon={<Send className="h-5 w-5" />} label="Sent to company" value={analysis.total} accent="#4f46e5" />
            <StatTile icon={<Users className="h-5 w-5" />} label="Tracked (Edge/Academy/Ext)" value={tracked} accent="#10b981" />
            <StatTile icon={<UserX className="h-5 w-5" />} label="Not tracked" value={company.untracked} accent="#94a3b8" />
          </div>
          <div className="flex items-center justify-center rounded-xl border p-4">
            <FunnelChart data={slices.filter((s) => s.value > 0)} />
          </div>
          <div className="flex flex-col items-center gap-4 rounded-xl border p-4 sm:flex-row">
            <DonutChart data={slices} total={analysis.total} />
            <Legend data={slices} total={analysis.total} />
          </div>
        </CardContent>
      </Card>

      {/* Round-wise funnel: source split at each round. */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Layers className="h-4 w-4 text-muted-foreground" /> Round funnel
              </CardTitle>
              <CardDescription>
                How many candidates were sent to each round, split by source. Width and % are
                relative to everyone sent.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={downloadFunnel}>
              <Download className="h-4 w-4" /> Funnel CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-center gap-4">
            {TRACK_BUCKETS.map((b) => (
              <span key={b.id} className="inline-flex items-center gap-1.5 text-sm">
                <span className="h-3 w-3 rounded-sm" style={{ background: b.color }} /> {b.label}
              </span>
            ))}
          </div>

          {roundColumns.length === 0 ? (
            <p className="rounded-md bg-muted/40 px-3 py-4 text-sm text-muted-foreground">
              No round columns were selected, so only the overall source split is shown above.
            </p>
          ) : (
            <>
              <StackedFunnelChart stages={stageData(analysis)} />

              {/* Per-round numeric breakdown. */}
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Round</TableHead>
                      {TRACK_BUCKETS.map((b) => (
                        <TableHead key={b.id} className="text-right">
                          {b.label}
                        </TableHead>
                      ))}
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {analysis.stages.map((s) => (
                      <TableRow key={s.round}>
                        <TableCell className="font-medium">{s.round}</TableCell>
                        {TRACK_BUCKETS.map((b) => (
                          <TableCell key={b.id} className="text-right tabular-nums">
                            {s.counts[b.id] || <span className="text-muted-foreground">0</span>}
                          </TableCell>
                        ))}
                        <TableCell className="text-right font-semibold tabular-nums">{s.total}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Candidate-level detail. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <SlidersHorizontal className="h-4 w-4 text-muted-foreground" /> Candidates
          </CardTitle>
          <CardDescription>Every candidate, their source, and their per-round status.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Filter className="h-3.5 w-3.5" /> Source
            </span>
            {TRACK_BUCKETS.map((b) => {
              const on = active.size === 0 || active.has(b.id);
              return (
                <button
                  key={b.id}
                  onClick={() => toggle(b.id)}
                  className={
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors" +
                    (on ? " text-white" : " border-border text-muted-foreground hover:bg-muted")
                  }
                  style={on ? { background: b.color, borderColor: b.color } : undefined}
                  aria-pressed={active.has(b.id)}
                >
                  {b.label}
                  <span className="tabular-nums opacity-90">{company[b.id]}</span>
                </button>
              );
            })}
            <span className="ml-auto text-sm text-muted-foreground">
              Showing {visible.length} of {candidates.length}
            </span>
          </div>

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Identifier</TableHead>
                  <TableHead>Source</TableHead>
                  {roundColumns.map((r) => (
                    <TableHead key={r}>{r}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="whitespace-nowrap font-medium">
                      {c.name || <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {c.identifier || "—"}
                    </TableCell>
                    <TableCell>
                      <span
                        className="inline-block rounded px-2 py-0.5 text-[11px] font-semibold text-white"
                        style={{ background: trackColor(c.bucket) }}
                        title={c.matched ? c.sourceTrack || "matched" : "No BigQuery match"}
                      >
                        {trackLabel(c.bucket)}
                      </span>
                    </TableCell>
                    {roundColumns.map((r) => {
                      const value = c.rounds[r] ?? "";
                      return (
                        <TableCell key={r} className="max-w-[200px]">
                          <span className="block truncate" title={value}>
                            {value || <span className="text-muted-foreground">—</span>}
                          </span>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">No candidates match the selected filter.</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function downloadCsv(headers: string[], rows: Record<string, string>[], filename: string): void {
  const csv = toCsv(headers, rows);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
