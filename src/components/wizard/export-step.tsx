"use client";

import * as React from "react";
import { CheckCircle2, Download, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/empty-state";
import { toCsv, slugify } from "@/lib/utils";
import {
  cellValue,
  companySheetName,
  exportColumns,
  type WizardState,
} from "@/components/wizard/wizard-shared";

interface ExportStepProps {
  state: WizardState;
}

export function ExportStep({ state }: ExportStepProps) {
  const columns = React.useMemo(() => exportColumns(state), [state]);
  const sheetName = companySheetName(state.companyName);

  const headers = React.useMemo(() => columns.map((c) => c.label), [columns]);

  const rows = React.useMemo(
    () =>
      state.consolidated.map((row) => {
        const rec: Record<string, string> = {};
        columns.forEach((c) => {
          rec[c.label] = cellValue(row, c, state);
        });
        return rec;
      }),
    [columns, state.consolidated, state.reports],
  );

  const download = () => {
    const csv = toCsv(headers, rows);
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugify(sheetName)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const reportsDone = state.consolidated.filter(
    (r) => state.reports[r.id]?.status === "done",
  ).length;

  const total = state.consolidated.length;
  const reportsFailed = state.consolidated.filter((r) => state.reports[r.id]?.status === "error").length;
  const evaluated = state.consolidated.filter((r) => state.screening[r.id]?.status === "done").length;
  const fileName = `${slugify(sheetName)}.csv`;
  const statCols = (3 + Number(state.generateColumns)) as 3 | 4;

  if (total === 0) {
    return (
      <div className="max-w-3xl">
        <EmptyState
          icon={<FileSpreadsheet />}
          title="Nothing to export yet"
          description="Go back to Preview and consolidate the candidates first."
        />
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <Panel>
        <div className="flex items-start gap-3.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-success-soft text-success">
            <CheckCircle2 className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-success">Company sheet ready</p>
            <h2 className="mt-0.5 break-words font-display text-[20px] font-semibold leading-tight tracking-[-0.015em]">
              {sheetName}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              Matches the approved preview and is ready to send to {state.companyName.trim() || "the company"}.
            </p>
          </div>
        </div>
      </Panel>

      <StatGrid cols={statCols}>
        <Stat label="Candidates" value={total} />
        <Stat label="Columns" value={headers.length} />
        {state.generatePdf ? (
          <Stat
            label="AI reports linked"
            value={reportsDone}
            hint={`of ${total}${reportsFailed > 0 ? ` · ${reportsFailed} failed` : ""}`}
          />
        ) : (
          <Stat label="AI reports" value="None" hint="Reports were turned off" />
        )}
        {state.generateColumns ? <Stat label="Skill set & remarks" value={evaluated} hint={`of ${total}`} /> : null}
      </StatGrid>

      <Panel title="Download" icon={<Download />} description="One file with every candidate and column.">
        <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <FileSpreadsheet className="h-5 w-5 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium" title={fileName}>
                {fileName}
              </p>
              <p className="text-xs tabular-nums text-muted-foreground">
                CSV · {total} rows · {headers.length} columns
              </p>
            </div>
          </div>
          <Button variant="soft" onClick={download} disabled={state.consolidated.length === 0} className="shrink-0">
            <Download /> Download CSV
          </Button>
        </div>
      </Panel>

      <Disclosure title="Columns in the sheet" summary={<span className="tabular-nums">{headers.length} columns</span>}>
        <ol className="flex flex-wrap gap-1.5">
          {headers.map((h, i) => (
            <li key={`${i}:${h}`}>
              <Badge variant="outline" className="font-normal">
                {h}
              </Badge>
            </li>
          ))}
        </ol>
      </Disclosure>
    </div>
  );
}
