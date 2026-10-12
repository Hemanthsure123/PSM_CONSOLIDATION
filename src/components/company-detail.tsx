"use client";

import * as React from "react";
import {
  ArrowLeft,
  Building2,
  Download,
  ExternalLink,
  Filter,
  Send,
  Sparkles,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DonutChart, FunnelChart, Legend, StatTile, type Slice } from "@/components/charts";
import { SOURCE_BUCKETS, bucketColor, bucketLabel, type SourceBucket } from "@/lib/source-track";
import { toCsv, slugify } from "@/lib/utils";
import type { BucketCount, CandidateDetail, CompanySummary } from "@/lib/types";

interface CompanyDetailProps {
  company: CompanySummary;
  onBack: () => void;
}

const SOURCE_COLUMN = "Source";

function toSlices(buckets: BucketCount[]): Slice[] {
  return buckets.map((b) => ({ label: bucketLabel(b.bucket), value: b.count, color: bucketColor(b.bucket) }));
}

/** Re-derive the per-bucket counts from the visible (possibly filtered) rows. */
function bucketsOf(candidates: CandidateDetail[]): BucketCount[] {
  const counts: Record<SourceBucket, number> = { edge: 0, academy: 0, external: 0 };
  for (const c of candidates) counts[c.bucket]++;
  return SOURCE_BUCKETS.map((b) => ({ bucket: b.id, count: counts[b.id] }));
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Building2 className="h-4 w-4 text-muted-foreground" /> {company.sheetName}
            </h2>
            <p className="text-sm text-muted-foreground">
              Candidate-level source funnel &amp; detail.
            </p>
          </div>
        </div>
        <Button onClick={download} disabled={!hasDetail}>
          <Download className="h-4 w-4" /> Download candidates CSV
        </Button>
      </div>

      {/* Source funnel — how many candidates were shared from each source. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Source funnel</CardTitle>
          <CardDescription>
            How many of the {company.total} shared candidates came from Edge, Academy, and External.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-[1fr_1fr_1fr]">
          <div className="grid gap-4">
            <StatTile icon={<Send className="h-5 w-5" />} label="Candidates shared" value={company.total} accent="#4f46e5" />
            <StatTile icon={<Users className="h-5 w-5" />} label="BigQuery matched" value={company.matched} accent="#10b981" />
            <StatTile icon={<Sparkles className="h-5 w-5" />} label="Reports generated" value={company.reportsGenerated} accent="#f59e0b" />
          </div>
          <div className="flex items-center justify-center rounded-xl border p-4">
            <FunnelChart data={fullSlices} />
          </div>
          <div className="flex flex-col items-center gap-4 rounded-xl border p-4 sm:flex-row">
            <DonutChart data={fullSlices} total={company.total} />
            <Legend data={fullSlices} total={company.total} />
          </div>
        </CardContent>
      </Card>

      {/* Candidate table. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Candidates</CardTitle>
          <CardDescription>
            Every shared candidate and their source. Filter by source below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!hasDetail ? (
            <p className="rounded-md bg-muted/40 px-3 py-4 text-sm text-muted-foreground">
              Candidate-level detail isn&apos;t stored for this consolidation (it was saved before
              this feature was added). The source funnel above is still accurate — re-run the
              consolidation to capture the per-candidate table.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-1 inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <Filter className="h-3.5 w-3.5" /> Source
                </span>
                {SOURCE_BUCKETS.map((b) => {
                  const on = active.size === 0 || active.has(b.id);
                  const count = company.buckets.find((x) => x.bucket === b.id)?.count ?? 0;
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
                      <span className="tabular-nums opacity-90">{count}</span>
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
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {c.subsheet}
                        </TableCell>
                        <TableCell>
                          <span
                            className="inline-block rounded px-2 py-0.5 text-[11px] font-semibold text-white"
                            style={{ background: bucketColor(c.bucket) }}
                            title={c.sourceTrack || undefined}
                          >
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
              </div>

              {visible.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No candidates match the selected source filter.
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
