"use client";

import * as React from "react";
import { Download, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSpreadsheet className="h-4 w-4" /> {sheetName}
        </CardTitle>
        <CardDescription>
          The consolidated company sheet — matches the approved preview exactly, ready to
          send to {state.companyName.trim() || "the company"}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-3">
          <Badge variant="secondary">{state.consolidated.length} candidates</Badge>
          <Badge variant="secondary">{headers.length} columns</Badge>
          {state.generatePdf ? (
            <Badge variant="success">{reportsDone} AI reports linked</Badge>
          ) : (
            <Badge variant="outline">No AI reports</Badge>
          )}
        </div>

        <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          Columns: {headers.join(" · ")}
        </div>

        <Button size="lg" onClick={download} disabled={state.consolidated.length === 0}>
          <Download className="h-4 w-4" /> Export “{sheetName}” as CSV
        </Button>
      </CardContent>
    </Card>
  );
}
