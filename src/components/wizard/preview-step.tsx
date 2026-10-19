"use client";

import * as React from "react";
import {
  CheckCircle2,
  ExternalLink,
  ListChecks,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  Sparkles,
  Target,
  Users,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Panel } from "@/components/ui/panel";
import { Field } from "@/components/ui/field";
import { SettingList, SettingRow } from "@/components/ui/setting-row";
import { InfoHint } from "@/components/ui/info-hint";
import { Notice } from "@/components/ui/notice";
import { Progress } from "@/components/ui/progress";
import { Stat, StatGrid } from "@/components/ui/stat";
import { EmptyState } from "@/components/ui/empty-state";
import { useReportBusy } from "@/components/busy-context";
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
  companySheetName,
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

  // Leaving from the sidebar asks first while the pool is built or reports are generated.
  useReportBusy(consolidating || generating || generatingCols);

  const total = state.consolidated.length;
  const reportsFailed = state.consolidated.filter((r) => state.reports[r.id]?.status === "error").length;
  const colsFailed = state.consolidated.filter((r) => state.screening[r.id]?.status === "error").length;
  const includedSubs = state.subsheets.filter((s) => s.selected).length;
  const statCols = (3 + Number(state.generatePdf) + Number(state.generateColumns)) as 3 | 4 | 5;

  if (consolidating) {
    return (
      <Panel className="max-w-3xl">
        <div className="space-y-3 py-2">
          <p className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-primary" /> Consolidating subsheets and matching against
            BigQuery…
          </p>
          <Progress label="Consolidating subsheets" />
        </div>
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      <StatGrid cols={statCols}>
        <Stat
          label="Candidates"
          value={total}
          hint={`across ${includedSubs} subsheet${includedSubs === 1 ? "" : "s"}`}
        />
        <Stat label="Columns" value={columns.length} hint="in the company sheet" />
        <Stat label="BigQuery matches" value={state.bqMatchedCount} hint={`of ${state.bqQueriedCount} looked up`} />
        {state.generatePdf ? (
          <Stat
            label="Reports ready"
            value={doneCount}
            hint={`of ${total}${reportsFailed > 0 ? ` · ${reportsFailed} failed` : ""}`}
          />
        ) : null}
        {state.generateColumns ? (
          <Stat
            label="Skill set & remarks"
            value={colsDoneCount}
            hint={`of ${total}${colsFailed > 0 ? ` · ${colsFailed} failed` : ""}`}
          />
        ) : null}
      </StatGrid>

      {state.enrichmentNote ? (
        <Notice tone="danger" title="BigQuery lookup failed">
          {state.enrichmentNote}
        </Notice>
      ) : null}

      <div className="max-w-3xl space-y-6">
        <Panel
          title="AI screening"
          icon={<Sparkles />}
          description="Optional. You can continue to Export with or without it."
        >
          <SettingList>
            <SettingRow
              id="pdf-toggle"
              title="Screening reports"
              description="A PDF report per candidate, linked in the sheet."
              info="Reports are best-effort and never block you: you can continue to Export with or without them."
              checked={state.generatePdf}
              onCheckedChange={(v) => patch({ generatePdf: v })}
            >
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <p className="flex items-center gap-1 text-[13px] font-medium">
                    Always included
                    <InfoHint align="start">
                      The core sections are always in the report. Technical work items are added only when the
                      resume has them.
                    </InfoHint>
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {["Top Highlights", "Resume", "Assessment Report", "TR-1 Link", "TR-2 Link"].map((m) => (
                      <Badge key={m} variant="secondary">
                        <Lock /> {m}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <p className="text-[13px] font-medium">Technical work</p>
                  <div className="grid gap-0.5 sm:grid-cols-2">
                    {SECTION_OPTIONS.map((opt) => (
                      <label
                        key={opt.key}
                        className="-mx-2 flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors hover:bg-muted/60"
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
              </div>
            </SettingRow>

            <SettingRow
              id="cols-toggle"
              title="Skill set and evaluation remarks"
              description="Two columns in the sheet. No document is made."
              info={
                <>
                  A core-strengths-first <strong>Skill Set</strong> and an HR-readable{" "}
                  <strong>Evaluation Remarks</strong> column, instead of or alongside PDF reports.
                </>
              }
              checked={state.generateColumns}
              onCheckedChange={(v) => patch({ generateColumns: v })}
            >
              <div className="space-y-1.5">
                <p className="flex items-center gap-1 text-[13px] font-medium">
                  Mention coding profiles in remarks
                  <InfoHint align="start">
                    LeetCode / Codeforces solved counts are added to the remarks only if their combined total
                    exceeds 500.
                  </InfoHint>
                </p>
                <div className="flex flex-wrap gap-x-5 gap-y-1">
                  <label className="flex cursor-pointer items-center gap-2 py-1 text-[13px]">
                    <Checkbox
                      checked={state.columnOptions.leetcode}
                      onCheckedChange={(v) =>
                        patch({ columnOptions: { ...state.columnOptions, leetcode: Boolean(v) } })
                      }
                    />
                    LeetCode
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 py-1 text-[13px]">
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
            </SettingRow>
          </SettingList>
        </Panel>

        {state.generatePdf || state.generateColumns ? (
          <Panel
            title="Screening criteria"
            icon={<Target />}
            description="The role's skills and job description."
            actions={
              <InfoHint align="end" label="About screening criteria">
                Used to pick the most relevant highlights from each resume. The report never mentions the job
                description; it only surfaces matching strengths.
              </InfoHint>
            }
          >
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Mandatory skills" htmlFor="must">
                  <Input
                    id="must"
                    placeholder="e.g. React, Node.js, SQL"
                    value={state.mandatorySkills}
                    onChange={(e) => patch({ mandatorySkills: e.target.value })}
                  />
                </Field>
                <Field label="Good-to-have skills" htmlFor="nice">
                  <Input
                    id="nice"
                    placeholder="e.g. AWS, Docker, GraphQL"
                    value={state.optionalSkills}
                    onChange={(e) => patch({ optionalSkills: e.target.value })}
                  />
                </Field>
              </div>
              <Field label="Job description" htmlFor="jd" optional>
                <Textarea
                  id="jd"
                  rows={4}
                  placeholder="Paste the company's job description…"
                  value={state.jobDescription}
                  onChange={(e) => patch({ jobDescription: e.target.value })}
                />
              </Field>
            </div>
          </Panel>
        ) : null}

        {state.generatePdf || state.generateColumns ? (
          <Panel
            title="Generate"
            icon={<Play />}
            description="One candidate at a time. Results fill the table below as they finish."
          >
            <div className="divide-y">
              {state.generatePdf ? (
                <RunRow
                  title="Screening reports"
                  running={generating}
                  done={doneCount}
                  failed={reportsFailed}
                  total={total}
                  doneWord="ready"
                  action={
                    <Button variant="soft" onClick={generateAll} disabled={generating}>
                      {generating ? <Loader2 className="animate-spin" /> : <Sparkles />}
                      {generating ? "Generating…" : "Generate reports"}
                    </Button>
                  }
                />
              ) : null}
              {state.generateColumns ? (
                <RunRow
                  title="Skill set and remarks"
                  running={generatingCols}
                  done={colsDoneCount}
                  failed={colsFailed}
                  total={total}
                  doneWord="evaluated"
                  action={
                    <Button variant="soft" onClick={generateColumnsAll} disabled={generatingCols}>
                      {generatingCols ? <Loader2 className="animate-spin" /> : <ListChecks />}
                      {generatingCols ? "Evaluating…" : "Generate skill set & remarks"}
                    </Button>
                  }
                />
              ) : null}
            </div>

            {state.generatePdf && localCount > 0 ? (
              <Notice
                tone="warning"
                className="mt-4"
                title={`${localCount} report${localCount === 1 ? "" : "s"} saved locally`}
              >
                The service account can&apos;t write to that Drive folder (My Drive has no service-account
                storage). To upload to Drive, set <code>GOOGLE_DRIVE_FOLDER_ID</code> to a Shared Drive folder,
                or set <code>GOOGLE_DRIVE_IMPERSONATE_USER</code> to a Workspace user with delegation. Then
                generate again.
              </Notice>
            ) : null}
          </Panel>
        ) : null}
      </div>

      <Panel
        flush
        title={companySheetName(state.companyName)}
        description="Consolidated pool across the selected subsheets."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={consolidate}
            title="Rebuild the pool from the loaded subsheets. Generated reports are cleared."
          >
            <RefreshCw /> Re-consolidate
          </Button>
        }
      >
        {state.consolidated.length === 0 ? (
          <div className="border-t p-5">
            <EmptyState
              icon={<Users />}
              title="No candidates consolidated"
              description="Go back and make sure a subsheet is included, mapped and loaded."
            />
          </div>
        ) : (
          <Table containerClassName="max-h-[560px] border-t">
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
                  <TableCell className="max-w-[160px] text-muted-foreground">
                    <span className="block truncate" title={row.subsheet}>
                      {row.subsheet}
                    </span>
                  </TableCell>
                  {columns.map((c) => {
                    const value = cellValue(row, c, state);
                    return (
                      <TableCell key={`${c.source}:${c.key}`} className="max-w-[220px]">
                        {c.isLink && /^https?:\/\//i.test(value) ? (
                          <a
                            href={value}
                            target="_blank"
                            rel="noreferrer"
                            title={value}
                            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
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
                    <TableCell className="whitespace-nowrap">
                      <ReportCell report={state.reports[row.id]} />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  );
}

/** One generator: what it has done so far, its progress while running, and its run button. */
function RunRow({
  title,
  running,
  done,
  failed,
  total,
  doneWord,
  action,
}: {
  title: string;
  running: boolean;
  done: number;
  failed: number;
  total: number;
  doneWord: string;
  action: React.ReactNode;
}) {
  const processed = done + failed;
  return (
    <div className="space-y-2.5 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-[13px] tabular-nums text-muted-foreground">
            {running ? (
              <>
                {processed} of {total} done
              </>
            ) : processed > 0 ? (
              <>
                {done} of {total} {doneWord}
                {failed > 0 ? <span className="text-destructive"> · {failed} failed</span> : null}
              </>
            ) : (
              <>Not run yet</>
            )}
          </p>
        </div>
        {action}
      </div>
      {(running || processed > 0) && total > 0 ? (
        <Progress
          value={processed}
          max={total}
          tone={!running && failed > 0 ? "warning" : !running ? "success" : "primary"}
          label={`${title} progress`}
        />
      ) : null}
    </div>
  );
}

function ReportCell({ report }: { report?: ReportState }) {
  if (!report || report.status === "idle") {
    return <span className="text-muted-foreground">Not generated</span>;
  }
  if (report.status === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating…
      </span>
    );
  }
  if (report.status === "error") {
    return (
      <Badge variant="destructive" title={report.error}>
        <XCircle /> Failed
      </Badge>
    );
  }
  return (
    <a
      href={report.link}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 font-medium text-success hover:underline"
    >
      <CheckCircle2 className="h-3.5 w-3.5" /> View report
      {report.storage === "local" ? <span className="text-xs font-normal text-warning">(local)</span> : null}
    </a>
  );
}
