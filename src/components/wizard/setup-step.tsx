"use client";

import * as React from "react";
import { Building2, FileSpreadsheet, Link2, Loader2, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Field } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
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
    <div className="max-w-3xl space-y-6">
      <Panel title="Company" icon={<Building2 />}>
        <Field
          label="Company name"
          htmlFor="company"
          hint={
            <>
              The company sheet will be named{" "}
              <span className="font-medium text-foreground">{companySheetName(state.companyName)}</span>.
            </>
          }
        >
          <Input
            id="company"
            placeholder="e.g. Acme Corp"
            value={state.companyName}
            onChange={(e) => patch({ companyName: e.target.value })}
          />
        </Field>
      </Panel>

      <Panel
        title="Internal sheet"
        icon={<FileSpreadsheet />}
        description="The Google Sheet that holds the candidates. Its subsheets are listed next."
      >
        <div className="space-y-4">
          <Field
            label="Google Sheets link"
            htmlFor="sheet-url"
            info="Share the sheet with the service account as a Viewer first, or it can't be read."
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="sheet-url"
                  className="pl-9"
                  placeholder="https://docs.google.com/spreadsheets/d/…"
                  value={state.spreadsheetUrl}
                  onChange={(e) => patch({ spreadsheetUrl: e.target.value, subsheets: [], spreadsheetTitle: "" })}
                  onKeyDown={(e) => e.key === "Enter" && state.spreadsheetUrl.trim() && fetchTabs()}
                />
              </div>
              <Button variant="soft" onClick={fetchTabs} disabled={pending || !state.spreadsheetUrl.trim()}>
                {pending ? <Loader2 className="animate-spin" /> : <FileSpreadsheet />}
                {pending ? "Reading…" : "Fetch subsheets"}
              </Button>
            </div>
          </Field>

          {error ? (
            <Notice tone="danger" title="Couldn't read the sheet">
              {error}
            </Notice>
          ) : null}

          {state.subsheets.length > 0 ? (
            <div className="space-y-2">
              <Notice tone="success" title={state.spreadsheetTitle || undefined}>
                <span className="tabular-nums">{state.subsheets.length}</span> subsheet
                {state.subsheets.length === 1 ? "" : "s"} found.
              </Notice>
              <ul className="divide-y rounded-lg border">
                {state.subsheets.map((s) => (
                  <li key={s.name} className="flex items-center justify-between gap-3 px-3.5 py-2 text-[13px]">
                    <span className="flex min-w-0 items-center gap-2">
                      <Table2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate" title={s.name}>
                        {s.name}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {s.headers.length} columns · {s.rowCount} rows
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
