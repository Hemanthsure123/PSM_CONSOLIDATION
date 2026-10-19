"use client";

import * as React from "react";
import { ArrowLeft, Download, ExternalLink, Filter, Send, Sparkles, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Notice } from "@/components/ui/notice";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DonutChart, FunnelChart, Legend, SERIES, type Slice } from "@/components/charts";
import { SOURCE_BUCKETS, bucketLabel, type SourceBucket } from "@/lib/source-track";
import { toCsv, slugify } from "@/lib/utils";
import type { BucketCount, CandidateDetail, CompanySummary } from "@/lib/types";

interface CompanyDetailProps {
  company: CompanySummary;
  onBack: () => void;
}

const SOURCE_COLUMN = "Source";

/** Chart colour per source — a fixed series slot, the same on every screen. */
const SOURCE_COLOR: Record<SourceBucket, string> = {
  edge: SERIES[0],
  academy: SERIES[1],
  external: SERIES[2],
};

function toSlices(buckets: BucketCount[]): Slice[] {
  return buckets.map((b) => ({ label: bucketLabel(b.bucket), value: b.count, color: SOURCE_COLOR[b.bucket] }));
}

/** Re-derive the per-bucket counts from the visible (possibly filtered) rows. */
function bucketsOf(candidates: CandidateDetail[]): BucketCount[] {
  const counts: Record<SourceBucket, number> = { edge: 0, academy: 0, external: 0 };
  for (const c of candidates) counts[c.bucket]++;
  return SOURCE_BUCKETS.map((b) => ({ bucket: b.id, count: counts[b.id] }));
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

/** The coloured mark that carries a source's identity (text stays in ink). */
function SourceMark({ bucket, className }: { bucket: SourceBucket; className?: string }) {
  return <span className={cn("h-2.5 w-2.5 shrink-0 rounded-[3px]", className)} style={{ background: SOURCE_COLOR[bucket] }} aria-hidden />;
}

export function CompanyDetail({ company, onBack }: CompanyDetailProps) {
  const candidates = React.useMemo(() => company.candidates ?? [], [company.candidates]);
  const columns = company.candidateColumns ?? [];

  // Active source filters — empty means "show all".
  const [active, setActive] = React.useState<Set<SourceBucket>>(new Set());
  const toggle = (id: SourceBucket) =>
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

  // Funnel/donut always reflect the full snapshot so the split stays stable
  // even while filtering the table below.
  const fullSlices = toSlices(company.buckets);

  const download = () => {
    const headers = ["Subsheet", SOURCE_COLUMN, ...columns];
    const rows = candidates.map((c) => {
      const rec: Record<string, string> = {
        Subsheet: c.subsheet,
        [SOURCE_COLUMN]: bucketLabel(c.bucket),
        ...c.fields,
      };
      return rec;
    });
    const csv = toCsv(headers, rows);
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugify(company.companyName)}-candidates.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const hasDetail = candidates.length > 0;
  const subsheetCount = company.subsheets.length;

  return (
    <div className="space-y-6">
      {/* Header: back to the list, the company, and its one action. */}
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
          <ArrowLeft /> Back to dashboard
        </Button>
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h2 className="break-words font-display text-[20px] font-semibold leading-tight tracking-[-0.015em]">{company.sheetName}</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {formatDate(company.createdAt)}
              {subsheetCount ? ` · ${subsheetCount} subsheet${subsheetCount === 1 ? "" : "s"}` : ""}
            </p>
          </div>
          <Button onClick={download} disabled={!hasDetail}>
            <Download /> Download candidates (CSV)
          </Button>
        </div>
      </div>

      <StatGrid cols={3}>
        <Stat icon={<Send />} label="Candidates shared" value={company.total} />
        <Stat icon={<Users />} label="BigQuery matched" value={company.matched} hint={`of ${company.total} shared`} />
        <Stat icon={<Sparkles />} label="Reports generated" value={company.reportsGenerated} />
      </StatGrid>

      {/* Source funnel — how many candidates were shared from each source. */}
      <Panel
        title="Source funnel"
        description={`How many of the ${company.total} shared candidates came from Edge, Academy and External.`}
      >
        <div className="grid items-center gap-8 md:grid-cols-2">
          <FunnelChart data={fullSlices} />
          <div className="flex flex-col items-center gap-6 sm:flex-row">
            <DonutChart data={fullSlices} total={company.total} />
            <div className="w-full min-w-0 flex-1">
              <Legend data={fullSlices} total={company.total} />
            </div>
          </div>
        </div>
      </Panel>

      {/* Split per subsheet (only when the company sheet has more than one). */}
      {subsheetCount > 1 ? (
        <Panel flush title="By subsheet" description="Candidates shared from each subsheet, by source.">
          <Table containerClassName="rounded-b-xl border-t">
            <TableHeader>
              <TableRow>
                <TableHead>Subsheet</TableHead>
                {SOURCE_BUCKETS.map((b) => (
                  <TableHead key={b.id} className="text-right">
                    <span className="inline-flex items-center gap-1.5">
                      <SourceMark bucket={b.id} className="h-2 w-2 rounded-[2px]" />
                      {b.label}
                    </span>
                  </TableHead>
                ))}
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {company.subsheets.map((s) => (
                <TableRow key={s.name}>
                  <TableCell className="max-w-[280px]">
                    <span className="block truncate" title={s.name}>
                      {s.name}
                    </span>
                  </TableCell>
                  {SOURCE_BUCKETS.map((b) => (
                    <TableCell key={b.id} className="text-right tabular-nums">
                      {s.buckets.find((x) => x.bucket === b.id)?.count ?? 0}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-medium tabular-nums">{s.total}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      ) : null}

      {/* Candidate table. */}
      <Panel
        flush
        title="Candidates"
        description="Every shared candidate and their source."
        actions={
          hasDetail ? (
            <span className="text-[13px] text-muted-foreground tabular-nums">
              Showing {visible.length} of {candidates.length}
            </span>
          ) : null
        }
      >
        {!hasDetail ? (
          <div className="px-5 pb-5">
            <Notice tone="info" title="Candidate detail isn't stored for this company">
              It was saved before candidate-level detail was added. The source numbers above are still accurate; build the
              company sheet again to capture the candidate table.
            </Notice>
          </div>
        ) : (
          <>
            {/* Toolbar: filter the table by source. */}
            <div role="group" aria-label="Filter by source" className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
              <span className="mr-1 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
                <Filter className="h-3.5 w-3.5" /> Source
              </span>
              {SOURCE_BUCKETS.map((b) => {
                const on = active.size === 0 || active.has(b.id);
                const count = company.buckets.find((x) => x.bucket === b.id)?.count ?? 0;
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => toggle(b.id)}
                    className={cn(
                      "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25",
                      on
                        ? "border-[hsl(222_70%_82%)] bg-accent text-foreground"
                        : "border-input bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                    aria-pressed={active.has(b.id)}
                  >
                    <SourceMark bucket={b.id} className={cn(!on && "opacity-40")} />
                    {b.label}
                    <span className="tabular-nums text-muted-foreground">{count}</span>
                  </button>
                );
              })}
            </div>

            {visible.length === 0 ? (
              <p className="border-t px-5 py-10 text-center text-[13px] text-muted-foreground">
                No candidates match the selected source filter.
              </p>
            ) : (
              <Table containerClassName="max-h-[560px] rounded-b-xl border-t">
                <TableHeader>
                  <TableRow>
                    <TableHead>Subsheet</TableHead>
                    <TableHead>Source</TableHead>
                    {columns.map((label) => (
                      <TableHead key={label}>{label}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{c.subsheet}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5" title={c.sourceTrack || undefined}>
                          <SourceMark bucket={c.bucket} className="h-2 w-2 rounded-[2px]" />
                          {bucketLabel(c.bucket)}
                        </span>
                      </TableCell>
                      {columns.map((label) => {
                        const value = c.fields[label] ?? "";
                        const isLink = /^https?:\/\//i.test(value);
                        return (
                          <TableCell key={label} className="max-w-[220px]">
                            {isLink ? (
                              <a
                                href={value}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-primary hover:underline"
                              >
                                Open <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : (
                              <span className="block truncate" title={value}>
                                {value || <span className="text-muted-foreground">—</span>}
                              </span>
                            )}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
