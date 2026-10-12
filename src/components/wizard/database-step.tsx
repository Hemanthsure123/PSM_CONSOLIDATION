"use client";

import * as React from "react";
import { Database, Info, Link2, Sheet as SheetIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { ReviewLinkSource, ReviewValues } from "@/lib/types";
import {
  BQ_COLUMNS,
  REVIEW_FIELDS,
  availableHeaders,
  detectReviewColumns,
  type WizardState,
} from "@/components/wizard/wizard-shared";

interface StepProps {
  state: WizardState;
  patch: (partial: Partial<WizardState>) => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  identity: "Identity",
  academic: "Academic",
  assessment: "Assessment",
  interview: "Interview",
};

export function DatabaseStep({ state, patch }: StepProps) {
  const selected = new Set(state.selectedBqColumnIds);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    patch({ selectedBqColumnIds: [...next] });
  };

  const grouped = React.useMemo(() => {
    const map = new Map<string, typeof BQ_COLUMNS>();
    for (const c of BQ_COLUMNS) {
      const list = map.get(c.category) ?? [];
      list.push(c);
      map.set(c.category, list);
    }
    return [...map.entries()];
  }, []);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" /> BigQuery Enrichment
          </CardTitle>
          <CardDescription>
            Do you need any columns from the BigQuery <code>student_profiles</code> database?
            If yes, tick them — they&apos;ll be matched to each candidate by their identifier
            and merged into the company sheet.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="bq-toggle" className="text-base">Pull columns from BigQuery?</Label>
              <p className="text-sm text-muted-foreground">
                {state.useBigQuery
                  ? "Selected columns below will be added to the sheet."
                  : "Skip enrichment — the sheet uses internal-sheet columns only."}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-muted-foreground">
                {state.useBigQuery ? "YES" : "NO"}
              </span>
              <Switch id="bq-toggle" checked={state.useBigQuery} onCheckedChange={(v) => patch({ useBigQuery: v })} />
            </div>
          </div>
        </CardContent>
      </Card>

      <ReviewLinksCard state={state} patch={patch} />

      <Card className="border-amber-200 bg-amber-50/40">
        <CardContent className="flex items-start gap-3 py-3 text-sm text-amber-900">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>source_track</strong> is always read from BigQuery (even if unticked) to
            power the Edge / Academy / External split on the Dashboard.
          </span>
        </CardContent>
      </Card>

      {state.useBigQuery ? (
        <div className="grid gap-4 md:grid-cols-2" data-testid="bq-columns">
          {grouped.map(([category, cols]) => (
            <Card key={category}>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">{CATEGORY_LABELS[category] ?? category}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {cols.map((c) => (
                  <label
                    key={c.id}
                    className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent"
                  >
                    <Checkbox checked={selected.has(c.id)} onCheckedChange={() => toggle(c.id)} />
                    <span>{c.label}</span>
                  </label>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Chooses where the report's TR/assessment links come from, and maps the sheet
 * columns that hold them. Panel names are always mapped from the sheet — they
 * only exist there — and are shown on the report's recording cards.
 */
function ReviewLinksCard({ state, patch }: StepProps) {
  const headers = React.useMemo(() => availableHeaders(state), [state.subsheets]); // eslint-disable-line react-hooks/exhaustive-deps
  const map = state.reviewColumns;
  const fromSheet = state.reviewLinkSource === "sheet";
  const mapped = REVIEW_FIELDS.some((f) => map[f.key]);

  // Prefill the mapping from the sheet headers the first time they're known.
  React.useEffect(() => {
    if (headers.length === 0 || mapped) return;
    const detected = detectReviewColumns(headers);
    if (Object.values(detected).some(Boolean)) patch({ reviewColumns: detected });
  }, [headers, mapped]); // eslint-disable-line react-hooks/exhaustive-deps

  const setField = (key: keyof ReviewValues, value: string) =>
    patch({ reviewColumns: { ...map, [key]: value } });

  const linkFields = REVIEW_FIELDS.filter((f) => f.group === "links");
  const panelFields = REVIEW_FIELDS.filter((f) => f.group === "panel");

  const options: { value: ReviewLinkSource; title: string; body: string; icon: React.ReactNode }[] = [
    {
      value: "bigquery",
      title: "From BigQuery",
      body: "Fetch the recording & report links from student_profiles.",
      icon: <Database className="h-4 w-4" />,
    },
    {
      value: "sheet",
      title: "From the uploaded sheet",
      body: "Use the links already in your sheet — nothing is fetched.",
      icon: <SheetIcon className="h-4 w-4" />,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-4 w-4" /> Interview &amp; Assessment Records
        </CardTitle>
        <CardDescription>
          Where should the TR-1 / TR-2 recordings and the assessment report link come from?
          These appear as the record cards at the bottom of each screening report.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {options.map((o) => {
            const active = state.reviewLinkSource === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => patch({ reviewLinkSource: o.value })}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-4 text-left transition-colors",
                  active ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-accent",
                )}
              >
                <span className={cn("mt-0.5", active ? "text-primary" : "text-muted-foreground")}>
                  {o.icon}
                </span>
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">{o.title}</span>
                  <span className="block text-xs text-muted-foreground">{o.body}</span>
                </span>
              </button>
            );
          })}
        </div>

        {headers.length === 0 ? (
          <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
            Select subsheets in the previous step to map their columns here.
          </p>
        ) : (
          <>
            {fromSheet ? (
              <div className="space-y-3 rounded-lg border p-4">
                <p className="text-sm font-medium">Sheet columns holding the links</p>
                {linkFields.map((f) => (
                  <HeaderSelect
                    key={f.key}
                    label={f.label}
                    hint={f.hint}
                    headers={headers}
                    value={map[f.key]}
                    onChange={(v) => setField(f.key, v)}
                  />
                ))}
              </div>
            ) : null}

            <div className="space-y-3 rounded-lg border p-4">
              <div>
                <p className="text-sm font-medium">Interview panel &amp; profiles</p>
                <p className="text-xs text-muted-foreground">
                  Always read from the uploaded sheet. Each TR recording card then shows who
                  screened the candidate — with the interviewer&apos;s LinkedIn linked — under a
                  &ldquo;screened by senior developers from top-tier product companies&rdquo; line.
                </p>
              </div>
              {panelFields.map((f) => (
                <HeaderSelect
                  key={f.key}
                  label={f.label}
                  hint={f.hint}
                  headers={headers}
                  value={map[f.key]}
                  onChange={(v) => setField(f.key, v)}
                />
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function HeaderSelect({
  label,
  hint,
  headers,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  headers: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  // Keep a stale mapping visible (e.g. after changing subsheets) instead of
  // silently resetting the field to "not mapped".
  const options = value && !headers.includes(value) ? [value, ...headers] : headers;
  return (
    <div className="grid gap-1.5 sm:grid-cols-[220px_1fr] sm:items-center sm:gap-3">
      <div>
        <Label className="text-sm">{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
      >
        <option value="">— Not mapped —</option>
        {options.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
    </div>
  );
}
