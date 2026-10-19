"use client";

import * as React from "react";
import { ArrowLeft, Building2, Download, Filter, Layers, PieChart, Send, Users, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Notice } from "@/components/ui/notice";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DonutChart,
  Legend,
  SERIES,
  SERIES_NEUTRAL,
  StackedFunnelChart,
  type FunnelStageData,
  type Slice,
} from "@/components/charts";
import {
  TRACK_BUCKETS,
  trackLabel,
  type SheetAnalysis,
  type TrackBucket,
} from "@/lib/company-sheet";
import { cn, toCsv, slugify } from "@/lib/utils";

interface AnalysisViewProps {
  analysis: SheetAnalysis;
  onBack: () => void;
  backLabel?: string;
}

/**
 * Fixed chart slot per source, the same on every screen (dashboard included): a source always
 * keeps its colour, and "Not tracked" takes the neutral.
 */
const SOURCE_COLOR: Record<TrackBucket, string> = {
  edge: SERIES[0],
  academy: SERIES[1],
  external: SERIES[2],
  untracked: SERIES_NEUTRAL,
};

function companySlices(company: Record<TrackBucket, number>): Slice[] {
  return TRACK_BUCKETS.map((b) => ({ label: b.label, value: company[b.id], color: SOURCE_COLOR[b.id] }));
}

function stageData(analysis: SheetAnalysis): FunnelStageData[] {
  return analysis.stages.map((s) => ({
    label: s.round,
    total: s.total,
    segments: TRACK_BUCKETS.map((b) => ({ label: b.label, value: s.counts[b.id], color: SOURCE_COLOR[b.id] })),
  }));
}

/** The coloured mark that carries a source's identity (text stays in ink). */
function Swatch({ id, faded }: { id: TrackBucket; faded?: boolean }) {
  return (
    <span
      className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
      style={{ background: SOURCE_COLOR[id], opacity: faded ? 0.35 : 1 }}
      aria-hidden
    />
  );
}

function pctOf(value: number, total: number): string {
  return total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
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

  const meta = `${analysis.sheetTitle} · ${analysis.subsheets.join(", ")}`;

  return (
    <div className="space-y-6">
      {/* Which analysis this is, the way out, and every download in one place. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-2">
          <Button variant="ghost" size="sm" onClick={onBack} className="-ml-3">
            <ArrowLeft className="h-4 w-4" /> {backLabel}
          </Button>
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 font-display text-[20px] font-semibold leading-tight">
              <Building2 className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="truncate">{analysis.companyName}</span>
            </h2>
            <p className="mt-1 truncate text-[13px] text-muted-foreground" title={meta}>
              {meta}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="outline" onClick={downloadFunnel}>
            <Download className="h-4 w-4" /> Download round funnel (CSV)
          </Button>
          <Button onClick={downloadCandidates} disabled={candidates.length === 0}>
            <Download className="h-4 w-4" /> Download candidates (CSV)
          </Button>
        </div>
      </div>

      {analysis.note ? <Notice tone="warning">{analysis.note}</Notice> : null}

      {/* Numbers first. */}
      <StatGrid cols={4}>
        <Stat label="Sent to company" value={analysis.total} icon={<Send />} />
        <Stat
          label="Tracked"
          value={tracked}
          hint={`Edge, Academy or External · ${pctOf(tracked, analysis.total)}`}
          icon={<Users />}
        />
        <Stat
          label="Not tracked"
          value={company.untracked}
          hint={`No source match · ${pctOf(company.untracked, analysis.total)}`}
          icon={<UserX />}
        />
        <Stat
          label="Rounds tracked"
          value={roundColumns.length}
          hint={`From ${analysis.subsheets.length} subsheet${analysis.subsheets.length === 1 ? "" : "s"}`}
          icon={<Layers />}
        />
      </StatGrid>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* Company-wise funnel: the source split of everyone sent. */}
        <Panel
          title="Source split"
          description={`Where the ${analysis.total} candidates sent to ${analysis.companyName} came from.`}
          icon={<PieChart />}
          className="lg:col-span-2"
        >
          <div className="flex flex-col items-center gap-5 sm:flex-row">
            <DonutChart data={slices} total={analysis.total} />
            <Legend data={slices} total={analysis.total} />
          </div>
        </Panel>

        {/* Round-wise funnel: source split at each round. */}
        <Panel
          title="Round funnel"
          description="Candidates sent to each round, split by source. Width and % are relative to everyone sent."
          icon={<Layers />}
          className="lg:col-span-3"
        >
          {roundColumns.length === 0 ? (
            <EmptyState
              title="No round columns selected"
              description="Only the overall source split is shown. Pick round columns when you analyze the sheet to see the funnel."
              className="py-8"
            />
          ) : (
            <div className="space-y-4">
              <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]" aria-label="Sources">
                {TRACK_BUCKETS.map((b) => (
                  <li key={b.id} className="inline-flex items-center gap-1.5">
                    <Swatch id={b.id} /> {b.label}
                    <span className="tabular-nums text-muted-foreground">{company[b.id]}</span>
                  </li>
                ))}
              </ul>
              <StackedFunnelChart stages={stageData(analysis)} />
            </div>
          )}
        </Panel>
      </div>

      {/* Per-round numeric breakdown. */}
      {roundColumns.length > 0 ? (
        <Panel flush title="Rounds by source" description="The numbers behind the round funnel.">
          <Table containerClassName="border-t">
            <TableHeader>
              <TableRow>
                <TableHead>Round</TableHead>
                {TRACK_BUCKETS.map((b) => (
                  <TableHead key={b.id} className="text-right">
                    <span className="inline-flex items-center gap-1.5">
                      <Swatch id={b.id} /> {b.label}
                    </span>
                  </TableHead>
                ))}
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analysis.stages.map((s) => (
                <TableRow key={s.round}>
                  <TableCell className="max-w-[260px] font-medium">
                    <span className="block truncate" title={s.round}>
                      {s.round}
                    </span>
                  </TableCell>
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
        </Panel>
      ) : null}

      {/* Candidate-level detail. */}
      <Panel
        flush
        title="Candidates"
        description="Every candidate, their source and their status in each round."
        actions={
          <span className="text-[13px] tabular-nums text-muted-foreground">
            Showing {visible.length} of {candidates.length}
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
          <span className="mr-1 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <Filter className="h-3.5 w-3.5" /> Source
          </span>
          {TRACK_BUCKETS.map((b) => {
            const on = active.size === 0 || active.has(b.id);
            const pressed = active.has(b.id);
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => toggle(b.id)}
                className={cn(
                  "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25",
                  pressed
                    ? "border-primary/40 bg-accent text-accent-foreground"
                    : on
                      ? "border-input bg-card text-foreground hover:bg-muted/60"
                      : "border-border bg-card text-muted-foreground hover:bg-muted/60",
                )}
                aria-pressed={active.has(b.id)}
              >
                <Swatch id={b.id} faded={!on} />
                {b.label}
                <span className="tabular-nums text-muted-foreground">{company[b.id]}</span>
              </button>
            );
          })}
        </div>

        {visible.length === 0 ? (
          <div className="border-t px-5 py-5">
            <EmptyState
              icon={<Users />}
              title={candidates.length === 0 ? "No candidates in this analysis" : "No candidates match the selected filter"}
              description={candidates.length === 0 ? undefined : "Turn a source on or off above to change the filter."}
              className="py-8"
            />
          </div>
        ) : (
          <Table containerClassName="max-h-[560px] border-t">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Identifier</TableHead>
                <TableHead>Source</TableHead>
                {roundColumns.map((r) => (
                  <TableHead key={r} className="max-w-[200px]">
                    <span className="block truncate" title={r}>
                      {r}
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="max-w-[220px] font-medium">
                    {c.name ? (
                      <span className="block truncate" title={c.name}>
                        {c.name}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                    {c.identifier || "—"}
                  </TableCell>
                  <TableCell>
                    <span
                      className="inline-flex items-center gap-1.5 whitespace-nowrap"
                      title={c.matched ? c.sourceTrack || "matched" : "No BigQuery match"}
                    >
                      <Swatch id={c.bucket} />
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
        )}
      </Panel>
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
