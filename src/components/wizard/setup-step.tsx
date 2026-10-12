"use client";

import * as React from "react";
import { Building2, CheckCircle2, FileSpreadsheet, Link2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { listSubsheets } from "@/actions/sheets";
import {
  companySheetName,
  prettyLabel,
  CANONICAL_LABELS,
  type SubsheetConfig,
  type WizardState,
} from "@/components/wizard/wizard-shared";
import type { IdentifierType } from "@/lib/types";

interface StepProps {
  state: WizardState;
  patch: (partial: Partial<WizardState>) => void;
}

/** Find the first header matching any keyword, optionally excluding others. */
function findHeader(headers: string[], include: string[], exclude: string[] = []): string {
  const lower = headers.map((h) => h.toLowerCase());
  for (let i = 0; i < lower.length; i++) {
    const h = lower[i];
    if (include.some((s) => h.includes(s)) && !exclude.some((e) => h.includes(e))) {
      return headers[i];
    }
  }
  return "";
}

interface Detected {
  identifierColumn: string;
  identifierType: IdentifierType;
  resumeColumn: string;
  selectedColumns: string[];
  columnLabels: Record<string, string>;
}

/**
 * Auto-detect the standard candidate columns (name, email, phone, resume) and
 * the identifier, pre-select them, and give each a clean company-facing label.
 */
function detectColumns(headers: string[]): Detected {
  const nameCol = findHeader(headers, ["name", "full name", "candidate"], ["college", "course", "department", "company", "user", "father", "guardian"]);
  const emailCol = findHeader(headers, ["email", "mail", "e-mail"]);
  const phoneCol = findHeader(headers, ["phone", "mobile", "contact", "whatsapp"]);
  const resumeCol = findHeader(headers, ["resume", "cv", "biodata"]);
  const uuidCol = findHeader(headers, ["user id", "uuid", "nxtwave id", "nxt id", "candidate id", "student id"]);

  // Identifier preference: a stable id → email → phone.
  let identifierColumn = uuidCol;
  let identifierType: IdentifierType = "uuid";
  if (!identifierColumn && emailCol) {
    identifierColumn = emailCol;
    identifierType = "email";
  } else if (!identifierColumn && phoneCol) {
    identifierColumn = phoneCol;
    identifierType = "phone";
  }
  if (!identifierColumn) identifierColumn = headers[0] ?? "";

  // Formatted labels: canonical for detected columns, title-case for the rest.
  const columnLabels: Record<string, string> = {};
  for (const h of headers) columnLabels[h] = prettyLabel(h);
  if (nameCol) columnLabels[nameCol] = CANONICAL_LABELS.name;
  if (phoneCol) columnLabels[phoneCol] = CANONICAL_LABELS.phone;
  if (emailCol) columnLabels[emailCol] = CANONICAL_LABELS.email;
  if (resumeCol) columnLabels[resumeCol] = CANONICAL_LABELS.resume;

  // Pre-select the standard candidate columns (deduped, keep present ones).
  const selectedColumns = [nameCol, phoneCol, emailCol, resumeCol].filter(
    (c, i, arr) => c && arr.indexOf(c) === i,
  );

  return { identifierColumn, identifierType, resumeColumn: resumeCol, selectedColumns, columnLabels };
}

export function SetupStep({ state, patch }: StepProps) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const fetchTabs = () => {
    setError(null);
    startTransition(async () => {
      const res = await listSubsheets(state.spreadsheetUrl);
      if (!res.ok) {
        setError(res.error);
        patch({ subsheets: [], spreadsheetTitle: "" });
        return;
      }
      const subsheets: SubsheetConfig[] = res.data.subsheets.map((s) => {
        const d = detectColumns(s.headers);
        return {
          name: s.name,
          headers: s.headers,
          rowCount: s.rowCount,
          selected: false,
          selectedColumns: d.selectedColumns,
          columnLabels: d.columnLabels,
          identifierColumn: d.identifierColumn,
          identifierType: d.identifierType,
          resumeColumn: d.resumeColumn,
          rows: [],
          loaded: false,
        };
      });
      patch({ spreadsheetTitle: res.data.title, subsheets });
    });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4" /> Company
          </CardTitle>
          <CardDescription>
            Name the company this drive is for. The consolidated sheet will be named{" "}
            <strong>{companySheetName(state.companyName)}</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="company">Company name</Label>
          <Input
            id="company"
            placeholder="e.g. Acme Corp"
            value={state.companyName}
            onChange={(e) => patch({ companyName: e.target.value })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4" /> Internal Sheet
          </CardTitle>
          <CardDescription>
            Paste the Google Sheets link. The sheet must be shared with the service
            account (Viewer). We&apos;ll list its subsheets next.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Link2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="https://docs.google.com/spreadsheets/d/…"
                value={state.spreadsheetUrl}
                onChange={(e) => patch({ spreadsheetUrl: e.target.value, subsheets: [], spreadsheetTitle: "" })}
                onKeyDown={(e) => e.key === "Enter" && state.spreadsheetUrl.trim() && fetchTabs()}
              />
            </div>
            <Button onClick={fetchTabs} disabled={pending || !state.spreadsheetUrl.trim()}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
              {pending ? "Reading…" : "Fetch Subsheets"}
            </Button>
          </div>

          {error ? (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          ) : null}

          {state.subsheets.length > 0 ? (
            <div className="space-y-3">
              <span className="inline-flex items-center gap-2 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                {state.spreadsheetTitle} · {state.subsheets.length} subsheet
                {state.subsheets.length === 1 ? "" : "s"} found.
              </span>
              <div className="flex flex-wrap gap-2">
                {state.subsheets.map((s) => (
                  <Badge key={s.name} variant="secondary">
                    {s.name} · {s.headers.length} cols · {s.rowCount} rows
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
