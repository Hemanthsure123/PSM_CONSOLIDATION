"use client";

import * as React from "react";
import {
  CheckCircle2,
  ExternalLink,
  ListChecks,
  Loader2,
  Lock,
  RefreshCw,
  Sparkles,
  Target,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { ReportSections } from "@/lib/types";

const SECTION_OPTIONS: { key: keyof ReportSections; label: string }[] = [
  { key: "skills", label: "Skills (matching role)" },
  { key: "github", label: "GitHub projects" },
  { key: "leetcode", label: "LeetCode profile" },
  { key: "portfolio", label: "Portfolio" },
  { key: "otherLinks", label: "Other links" },
];
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enrichFromBigQuery, type EnrichedRow } from "@/actions/bigquery";
import { generateScreeningReport, generateScreeningColumns } from "@/actions/report";
import {
  assembleConsolidated,
  cellValue,
  exportColumns,
  identifiersByType,
  type ReportState,
  type ScreeningState,
  type WizardState,
} from "@/components/wizard/wizard-shared";
import type { IdentifierType } from "@/lib/types";

interface StepProps {
  state: WizardState;
  patch: (partial: Partial<WizardState>) => void;
}

export function PreviewStep({ state, patch }: StepProps) {
  const [consolidating, setConsolidating] = React.useState(false);
  const [generating, setGenerating] = React.useState(false);
  const columns = React.useMemo(() => exportColumns(state), [state]);

  const consolidate = React.useCallback(async () => {
    setConsolidating(true);
    const byType = identifiersByType(state);
    const matchesByType: Partial<Record<IdentifierType, Record<string, EnrichedRow>>> = {};
    let matched = 0;
    let queried = 0;
    const notes: string[] = [];

    // Always fetch source_track for the dashboard; add chosen columns only if
    // BigQuery enrichment is enabled. The TR/assessment link columns are skipped
    // entirely when those links come from the uploaded sheet.
    const wanted = state.useBigQuery ? state.selectedBqColumnIds : [];
    const needBqReportLinks = state.reviewLinkSource !== "sheet";
    for (const [type, ids] of Object.entries(byType) as [IdentifierType, string[]][]) {
      if (!ids || ids.length === 0) continue;
      const res = await enrichFromBigQuery(ids, type, wanted, needBqReportLinks);
      if (res.ok) {
        matchesByType[type] = res.data.matches;
        matched += res.data.matchedCount;
        queried += res.data.queriedCount;
      } else {
        notes.push(res.error);
      }
    }

    const rows = assembleConsolidated(state, matchesByType);
    patch({
      consolidated: rows,
      bqMatchedCount: matched,
      bqQueriedCount: queried,
      enrichmentNote: notes.join(" "),
      reports: {},
    });
    setConsolidating(false);
  }, [state, patch]);

  // Build the pool once on entry.
  React.useEffect(() => {
    if (state.consolidated.length === 0 && !consolidating) consolidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generateAll = async () => {
    setGenerating(true);
    const working: Record<string, ReportState> = {};
    for (const r of state.consolidated) working[r.id] = { status: "pending" };
    patch({ reports: { ...working } });

    const criteria = {
      jobDescription: state.jobDescription,
      mandatorySkills: state.mandatorySkills,
      optionalSkills: state.optionalSkills,
    };

    // Sequential — Puppeteer + resume fetch + LLM are heavy; one at a time.
    for (const row of state.consolidated) {
      const res = await generateScreeningReport(row, criteria, state.reportSections, state.reviewLinkSource);
      working[row.id] = res.ok
        ? { status: "done", link: res.data.webViewLink, storage: res.data.storage }
        : { status: "error", error: res.error };
      patch({ reports: { ...working } });
    }
    setGenerating(false);
  };

  const doneCount = state.consolidated.filter((r) => state.reports[r.id]?.status === "done").length;
  const localCount = state.consolidated.filter((r) => state.reports[r.id]?.storage === "local").length;

  const [generatingCols, setGeneratingCols] = React.useState(false);

  const generateColumnsAll = async () => {
    setGeneratingCols(true);
    const working: Record<string, ScreeningState> = {};
    for (const r of state.consolidated) working[r.id] = { status: "pending" };
    patch({ screening: { ...working } });

    const criteria = {
      jobDescription: state.jobDescription,
      mandatorySkills: state.mandatorySkills,
      optionalSkills: state.optionalSkills,
    };

    // Sequential — each candidate is an LLM (+ optional platform) call.
    for (const row of state.consolidated) {
      const res = await generateScreeningColumns(row, criteria, state.columnOptions);
      working[row.id] = res.ok
        ? { status: "done", skillSet: res.data.skillSet, remarks: res.data.remarks }
        : { status: "error", error: res.error };
      patch({ screening: { ...working } });
    }
    setGeneratingCols(false);
  };

  const colsDoneCount = state.consolidated.filter((r) => state.screening[r.id]?.status === "done").length;

  if (consolidating) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" /> Consolidating subsheets and matching against BigQuery…
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="pdf-toggle" className="text-base">
              Generate screening reports?
            </Label>
            <p className="text-sm text-muted-foreground">
              Optional. You can continue to Export with or without reports — they&apos;re
              best-effort and never block you.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-muted-foreground">
              {state.generatePdf ? "YES" : "NO"}
            </span>
            <Switch
              id="pdf-toggle"
              checked={state.generatePdf}
              onCheckedChange={(v) => patch({ generatePdf: v })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="cols-toggle" className="text-base">
                Generate Skill Set &amp; Evaluation Remarks?
              </Label>
              <p className="text-sm text-muted-foreground">
                Adds two columns — a core-strengths-first <strong>Skill Set</strong> and an
                HR-readable <strong>Evaluation Remarks</strong> — instead of (or alongside) PDF
                reports. No document is generated.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-muted-foreground">
                {state.generateColumns ? "YES" : "NO"}
              </span>
              <Switch
                id="cols-toggle"
                checked={state.generateColumns}
                onCheckedChange={(v) => patch({ generateColumns: v })}
              />
            </div>
          </div>

          {state.generateColumns ? (
            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Mention coding profiles in remarks
              </p>
              <p className="text-xs text-muted-foreground">
                When enabled, LeetCode / Codeforces solved counts are added to the remarks
                <strong> only if their combined total exceeds 500</strong>.
              </p>
              <div className="flex flex-wrap gap-4 pt-1">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    checked={state.columnOptions.leetcode}
                    onCheckedChange={(v) =>
                      patch({ columnOptions: { ...state.columnOptions, leetcode: Boolean(v) } })
                    }
                  />
                  LeetCode
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    checked={state.columnOptions.codeforces}
                    onCheckedChange={(v) =>
                      patch({ columnOptions: { ...state.columnOptions, codeforces: Boolean(v) } })
                    }
                  />
                  Codeforces
                </label>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {state.generatePdf || state.generateColumns ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Target className="h-4 w-4" /> Screening Criteria
            </CardTitle>
            <CardDescription>
              Used to pick the most relevant highlights from each resume. Provide the role&apos;s
              skills and/or paste the job description — the report never mentions the JD, it just
              surfaces matching strengths.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="must">Mandatory skills</Label>
                <Input
                  id="must"
                  placeholder="e.g. React, Node.js, SQL"
                  value={state.mandatorySkills}
                  onChange={(e) => patch({ mandatorySkills: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nice">Optional / good-to-have skills</Label>
                <Input
                  id="nice"
                  placeholder="e.g. AWS, Docker, GraphQL"
                  value={state.optionalSkills}
                  onChange={(e) => patch({ optionalSkills: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="jd">Job description (optional)</Label>
              <textarea
                id="jd"
                rows={4}
                placeholder="Paste the company's job description…"
                value={state.jobDescription}
                onChange={(e) => patch({ jobDescription: e.target.value })}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {state.generatePdf ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ListChecks className="h-4 w-4" /> Report Sections
            </CardTitle>
            <CardDescription>
              What each report includes. The core sections are always on; pick which
              Technical Work items to add (only shown when present in the resume).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Always included
              </p>
              <div className="flex flex-wrap gap-2">
                {["Top Highlights", "Resume", "Assessment Report", "TR-1 Link", "TR-2 Link"].map((m) => (
                  <span
                    key={m}
                    className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1 text-sm"
                  >
                    <Lock className="h-3 w-3 text-muted-foreground" /> {m}
                  </span>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Technical Work (optional)
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {SECTION_OPTIONS.map((opt) => (
                  <label
                    key={opt.key}
                    className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 text-sm transition-colors hover:bg-accent"
                  >
                    <Checkbox
                      checked={state.reportSections[opt.key]}
                      onCheckedChange={(v) =>
                        patch({ reportSections: { ...state.reportSections, [opt.key]: Boolean(v) } })
                      }
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Badge variant="secondary">{state.consolidated.length} candidates</Badge>
        <Badge variant="secondary">{columns.length} columns</Badge>
        <Badge variant="outline">
          BigQuery matched {state.bqMatchedCount}/{state.bqQueriedCount}
        </Badge>
        {state.generatePdf && doneCount > 0 ? (
          <Badge variant="success">{doneCount} reports ready</Badge>
        ) : null}
        {state.generateColumns && colsDoneCount > 0 ? (
          <Badge variant="success">{colsDoneCount} evaluated</Badge>
        ) : null}
        <Button variant="outline" size="sm" onClick={consolidate}>
          <RefreshCw className="h-4 w-4" /> Re-consolidate
        </Button>
        {state.generatePdf ? (
          <Button onClick={generateAll} disabled={generating} className="ml-auto">
            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {generating ? "Generating…" : "Generate Reports"}
          </Button>
        ) : null}
        {state.generateColumns ? (
          <Button
            onClick={generateColumnsAll}
            disabled={generatingCols}
            variant={state.generatePdf ? "outline" : "default"}
            className={state.generatePdf ? "" : "ml-auto"}
          >
            {generatingCols ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListChecks className="h-4 w-4" />}
            {generatingCols ? "Evaluating…" : "Generate Skill Set & Remarks"}
          </Button>
        ) : null}
      </div>

      {state.generatePdf && localCount > 0 ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {localCount} report{localCount === 1 ? "" : "s"} saved locally because the service
          account can&apos;t write to that Drive folder (My Drive has no service-account storage).
          To upload to Drive, either set <code>GOOGLE_DRIVE_FOLDER_ID</code> to a <strong>Shared
          Drive</strong> folder, or set <code>GOOGLE_DRIVE_IMPERSONATE_USER</code> to a Workspace
          user with delegation. Then re-generate.
        </p>
      ) : null}

      {state.enrichmentNote ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.enrichmentNote}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{state.companyName.trim()} || Nxtwave</CardTitle>
          <CardDescription>Consolidated pool across selected subsheets.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subsheet</TableHead>
                  {columns.map((c) => (
                    <TableHead key={`${c.source}:${c.key}`}>{c.label}</TableHead>
                  ))}
                  {state.generatePdf ? <TableHead>Report</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.consolidated.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-xs text-muted-foreground">{row.subsheet}</TableCell>
                    {columns.map((c) => {
                      const value = cellValue(row, c, state);
                      return (
                        <TableCell key={`${c.source}:${c.key}`} className="max-w-[220px]">
                          {c.isLink && /^https?:\/\//i.test(value) ? (
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
                    {state.generatePdf ? (
                      <TableCell>
                        <ReportCell report={state.reports[row.id]} />
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {state.consolidated.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No rows consolidated. Go back and ensure a subsheet is selected, configured, and loaded.
        </p>
      ) : null}
    </div>
  );
}

function ReportCell({ report }: { report?: ReportState }) {
  if (!report || report.status === "idle") {
    return <span className="text-sm text-muted-foreground">Not generated</span>;
  }
  if (report.status === "pending") {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating…
      </span>
    );
  }
  if (report.status === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-destructive" title={report.error}>
        <XCircle className="h-3.5 w-3.5" /> Failed
      </span>
    );
  }
  return (
    <a
      href={report.link}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-sm text-emerald-700 hover:underline"
    >
      <CheckCircle2 className="h-3.5 w-3.5" /> View report
      {report.storage === "local" ? (
        <span className="text-xs text-amber-600">(local)</span>
      ) : null}
    </a>
  );
}
