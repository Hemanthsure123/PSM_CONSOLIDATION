"use client";

import * as React from "react";
import { CheckCircle2, Download, Loader2, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Panel } from "@/components/ui/panel";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/select";
import { Notice } from "@/components/ui/notice";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { readSubsheet } from "@/actions/sheets";
import type { SubsheetConfig, WizardState } from "@/components/wizard/wizard-shared";
import type { IdentifierType } from "@/lib/types";

interface StepProps {
  state: WizardState;
  patch: (partial: Partial<WizardState>) => void;
}

const ID_TYPES: { value: IdentifierType; label: string }[] = [
  { value: "uuid", label: "User ID" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
];

export function SubsheetStep({ state, patch }: StepProps) {
  const update = (name: string, partial: Partial<SubsheetConfig>) =>
    patch({
      subsheets: state.subsheets.map((s) => (s.name === name ? { ...s, ...partial } : s)),
    });

  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Include the subsheets that hold candidates. For each one, pick the columns, map the identifier and
        resume link, then load its rows.
      </p>

      {state.subsheets.length === 0 ? (
        <EmptyState
          icon={<Table2 />}
          title="No subsheets yet"
          description="Go back to Setup and fetch the sheet's subsheets."
        />
      ) : null}

      {state.subsheets.map((sub) => (
        <SubsheetCard key={sub.name} sub={sub} url={state.spreadsheetUrl} update={update} />
      ))}
    </div>
  );
}

function SubsheetCard({
  sub,
  url,
  update,
}: {
  sub: SubsheetConfig;
  url: string;
  update: (name: string, partial: Partial<SubsheetConfig>) => void;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const uid = React.useId();

  const toggleColumn = (header: string) => {
    const next = new Set(sub.selectedColumns);
    if (next.has(header)) next.delete(header);
    else next.add(header);
    update(sub.name, { selectedColumns: [...next], loaded: false });
  };

  const selectAll = () =>
    update(sub.name, { selectedColumns: [...sub.headers], loaded: false });
  const clearAll = () => update(sub.name, { selectedColumns: [], loaded: false });

  const load = () => {
    setError(null);
    startTransition(async () => {
      const res = await readSubsheet(url, sub.name);
      if (!res.ok) {
        setError(res.error);
        update(sub.name, { rows: [], loaded: false });
        return;
      }
      update(sub.name, { rows: res.data.rows, loaded: true });
    });
  };

  const selected = new Set(sub.selectedColumns);

  return (
    <Panel
      icon={<Table2 />}
      title={<span className="break-words">{sub.name}</span>}
      description={
        <span className="tabular-nums">
          {sub.rowCount} rows · {sub.headers.length} columns
        </span>
      }
      actions={
        <div className="flex items-center gap-2.5">
          <label htmlFor={`${uid}-include`} className="cursor-pointer text-[13px] text-muted-foreground">
            {sub.selected ? "Included" : "Excluded"}
          </label>
          <Switch
            id={`${uid}-include`}
            checked={sub.selected}
            onCheckedChange={(v) => update(sub.name, { selected: v })}
          />
        </div>
      }
      flush={!sub.selected}
      className={cn("transition-colors", sub.selected && "border-primary/40")}
      footer={
        sub.selected ? (
          <>
            <span className="min-w-0 flex-1 text-[13px]">
              {sub.loaded ? (
                <span className="inline-flex items-center gap-1.5 font-medium text-success">
                  <CheckCircle2 className="h-4 w-4" /> Loaded <span className="tabular-nums">{sub.rows.length}</span> rows.
                </span>
              ) : (
                <span className="text-muted-foreground">Load this subsheet&apos;s rows to continue.</span>
              )}
            </span>
            <Button
              variant={sub.loaded ? "outline" : "soft"}
              size="sm"
              onClick={load}
              disabled={pending || sub.selectedColumns.length === 0 || !sub.identifierColumn || !sub.resumeColumn}
            >
              {pending ? <Loader2 className="animate-spin" /> : <Download />}
              {pending ? "Loading…" : sub.loaded ? "Reload rows" : "Load rows"}
            </Button>
          </>
        ) : undefined
      }
    >
      {sub.selected ? (
        <div className="space-y-5">
          {/* Column picker */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p id={`${uid}-cols`} className="text-[13px] font-medium">
                Columns to include{" "}
                <span className="font-normal tabular-nums text-muted-foreground">
                  ({sub.selectedColumns.length} of {sub.headers.length})
                </span>
              </p>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={selectAll}>
                  Select all
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={clearAll}>
                  Clear
                </Button>
              </div>
            </div>
            <div role="group" aria-labelledby={`${uid}-cols`} className="grid gap-1.5 sm:grid-cols-2">
              {sub.headers.map((h) => {
                const label = sub.columnLabels?.[h];
                const renamed = Boolean(label && label !== h);
                return (
                  <label
                    key={h}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-[13px] transition-colors hover:bg-muted/60",
                      selected.has(h) && "border-primary/30 bg-accent/40",
                    )}
                  >
                    <Checkbox checked={selected.has(h)} onCheckedChange={() => toggleColumn(h)} />
                    <span className="min-w-0 flex-1 truncate" title={renamed ? `${h} (shown as ${label})` : h}>
                      {h}
                      {renamed ? <span className="text-muted-foreground"> as {label}</span> : null}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Mapping */}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Identifier column"
              htmlFor={`${uid}-id`}
              info="Each candidate is matched in BigQuery by this value."
            >
              <SelectBox
                id={`${uid}-id`}
                value={sub.identifierColumn}
                onChange={(v) => update(sub.name, { identifierColumn: v, loaded: false })}
                options={sub.headers}
              />
            </Field>
            <Field label="Identifier type" htmlFor={`${uid}-type`}>
              <NativeSelect
                id={`${uid}-type`}
                value={sub.identifierType}
                onChange={(e) => update(sub.name, { identifierType: e.target.value as IdentifierType, loaded: false })}
              >
                {ID_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Resume link column" htmlFor={`${uid}-resume`}>
              <SelectBox
                id={`${uid}-resume`}
                value={sub.resumeColumn}
                onChange={(v) => update(sub.name, { resumeColumn: v, loaded: false })}
                options={sub.headers}
              />
            </Field>
          </div>

          {!sub.loaded && error ? (
            <Notice tone="danger" title="Couldn't load the rows">
              {error}
            </Notice>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

function SelectBox({
  id,
  value,
  onChange,
  options,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose a column</option>
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </NativeSelect>
  );
}
