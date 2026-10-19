"use client";

import * as React from "react";
import { Database, Link2, Sheet as SheetIcon } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { SettingList, SettingRow } from "@/components/ui/setting-row";
import { Segmented } from "@/components/ui/segmented";
import { NativeSelect } from "@/components/ui/select";
import { Disclosure } from "@/components/ui/disclosure";
import { InfoHint } from "@/components/ui/info-hint";
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
    <div className="max-w-3xl space-y-6">
      <Panel
        title="BigQuery enrichment"
        icon={<Database />}
        description={
          <>
            Add columns from the <code className="rounded bg-muted px-1 py-0.5 text-[12px]">student_profiles</code>{" "}
            table, matched to each candidate by identifier.
          </>
        }
        actions={
          state.useBigQuery ? (
            <Badge variant="secondary" className="tabular-nums">
              {state.selectedBqColumnIds.length} selected
            </Badge>
          ) : null
        }
      >
        <SettingList>
          <SettingRow
            id="bq-toggle"
            title="Pull columns from BigQuery"
            description={
              state.useBigQuery
                ? "The columns you tick are added to the company sheet."
                : "Off. The sheet uses the internal sheet's columns only."
            }
            info={
              <>
                <span className="font-medium">source_track</span> is always read from BigQuery, even when it
                isn&apos;t ticked, to power the Edge / Academy / External split on the dashboard.
              </>
            }
            checked={state.useBigQuery}
            onCheckedChange={(v) => patch({ useBigQuery: v })}
          >
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2" data-testid="bq-columns">
              {grouped.map(([category, cols]) => (
                <fieldset key={category} className="min-w-0">
                  <legend className="mb-1.5 text-[13px] font-medium">{CATEGORY_LABELS[category] ?? category}</legend>
                  <div className="space-y-0.5">
                    {cols.map((c) => (
                      <label
                        key={c.id}
                        className="-mx-2 flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors hover:bg-muted/60"
                      >
                        <Checkbox checked={selected.has(c.id)} onCheckedChange={() => toggle(c.id)} />
                        <span className="min-w-0 truncate" title={c.label}>
                          {c.label}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
          </SettingRow>
        </SettingList>
      </Panel>

      <ReviewLinksCard state={state} patch={patch} />
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
  const panelMapped = panelFields.filter((f) => map[f.key]).length;

  const options: { value: ReviewLinkSource; title: string; body: string; icon: React.ReactNode }[] = [
    {
      value: "bigquery",
      title: "From BigQuery",
      body: "The recording and report links are fetched from student_profiles.",
      icon: <Database className="h-3.5 w-3.5" />,
    },
    {
      value: "sheet",
      title: "From the sheet",
      body: "The links already in your sheet are used. Nothing is fetched.",
      icon: <SheetIcon className="h-3.5 w-3.5" />,
    },
  ];
  const activeOption = options.find((o) => o.value === state.reviewLinkSource);

  return (
    <>
      <Panel
        title="Interview and assessment records"
        icon={<Link2 />}
        description="Where the TR-1 and TR-2 recordings and the assessment report link come from."
        actions={
          <InfoHint align="end" label="About interview and assessment records">
            These links appear as the record cards at the bottom of each screening report.
          </InfoHint>
        }
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Segmented
              ariaLabel="Where the record links come from"
              value={state.reviewLinkSource}
              onChange={(v) => patch({ reviewLinkSource: v })}
              options={options.map((o) => ({
                value: o.value,
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    {o.icon}
                    {o.title}
                  </span>
                ),
              }))}
            />
            {activeOption ? <p className="text-xs text-muted-foreground">{activeOption.body}</p> : null}
          </div>

          {headers.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3.5 py-3 text-[13px] text-muted-foreground">
              Include a subsheet in the previous step to map its columns here.
            </p>
          ) : fromSheet ? (
            <div className="space-y-3 border-t pt-4">
              <p className="text-[13px] font-medium">Sheet columns holding the links</p>
              {linkFields.map((f) => (
                <HeaderSelect
                  key={f.key}
                  id={`review-${f.key}`}
                  label={f.label}
                  hint={f.hint}
                  headers={headers}
                  value={map[f.key]}
                  onChange={(v) => setField(f.key, v)}
                />
              ))}
            </div>
          ) : null}
        </div>
      </Panel>

      {headers.length > 0 ? (
        <Disclosure
          title="Interview panel columns"
          summary={
            <span className="tabular-nums">
              {panelMapped} of {panelFields.length} mapped
            </span>
          }
        >
          <div className="space-y-3">
            <p className="flex items-center gap-1 text-[13px] text-muted-foreground">
              Always read from the sheet, whichever source is chosen above.
              <InfoHint align="end">
                Each TR recording card shows who screened the candidate, with the interviewer&apos;s LinkedIn
                linked, under a &ldquo;screened by senior developers from top-tier product companies&rdquo; line.
              </InfoHint>
            </p>
            {panelFields.map((f) => (
              <HeaderSelect
                key={f.key}
                id={`review-${f.key}`}
                label={f.label}
                hint={f.hint}
                headers={headers}
                value={map[f.key]}
                onChange={(v) => setField(f.key, v)}
              />
            ))}
          </div>
        </Disclosure>
      ) : null}
    </>
  );
}

function HeaderSelect({
  id,
  label,
  hint,
  headers,
  value,
  onChange,
}: {
  id: string;
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
    <div className="grid gap-1.5 sm:grid-cols-[200px_minmax(0,1fr)] sm:items-center sm:gap-4">
      <div className="min-w-0">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <NativeSelect
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Not mapped</option>
        {options.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
