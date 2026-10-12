"use client";

import * as React from "react";
import { CheckCircle2, Download, Loader2, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
    <div className="space-y-6">
      <Card className="border-indigo-200 bg-indigo-50/40">
        <CardContent className="py-4 text-sm text-indigo-900">
          Select which subsheet(s) hold candidates. For each, choose the columns to
          pull, point to the <strong>identifier</strong> and <strong>resume link</strong>{" "}
          columns, then load the rows.
        </CardContent>
      </Card>

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
    <Card className={cn(sub.selected && "border-primary/40")}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Table2 className="h-4 w-4 text-muted-foreground" /> {sub.name}
            <Badge variant="secondary">{sub.rowCount} rows</Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{sub.selected ? "Included" : "Excluded"}</span>
            <Switch
              checked={sub.selected}
              onCheckedChange={(v) => update(sub.name, { selected: v })}
            />
          </div>
        </div>
        {sub.selected ? (
          <CardDescription>
            Pick columns and map the identifier + resume columns.
          </CardDescription>
        ) : null}
      </CardHeader>

      {sub.selected ? (
        <CardContent className="space-y-5">
          {/* Column picker */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Columns to include ({sub.selectedColumns.length})</Label>
              <div className="flex gap-2 text-xs">
                <button onClick={selectAll} className="text-primary hover:underline">All</button>
                <button onClick={clearAll} className="text-muted-foreground hover:underline">None</button>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {sub.headers.map((h) => (
                <label
                  key={h}
                  className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent"
                >
                  <Checkbox checked={selected.has(h)} onCheckedChange={() => toggleColumn(h)} />
                  <span className="min-w-0 flex-1 truncate" title={h}>
                    {h}
                    {sub.columnLabels?.[h] && sub.columnLabels[h] !== h ? (
                      <span className="text-muted-foreground"> → {sub.columnLabels[h]}</span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Mapping */}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Identifier column">
              <SelectBox
                value={sub.identifierColumn}
                onChange={(v) => update(sub.name, { identifierColumn: v, loaded: false })}
                options={sub.headers}
              />
            </Field>
            <Field label="Identifier type">
              <select
                value={sub.identifierType}
                onChange={(e) => update(sub.name, { identifierType: e.target.value as IdentifierType, loaded: false })}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {ID_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Resume link column">
              <SelectBox
                value={sub.resumeColumn}
                onChange={(v) => update(sub.name, { resumeColumn: v, loaded: false })}
                options={sub.headers}
              />
            </Field>
          </div>

          <div className="flex items-center justify-between">
            {sub.loaded ? (
              <span className="inline-flex items-center gap-2 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4" /> Loaded {sub.rows.length} rows.
              </span>
            ) : error ? (
              <span className="text-sm text-destructive">{error}</span>
            ) : (
              <span className="text-sm text-muted-foreground">Load this subsheet&apos;s rows to continue.</span>
            )}
            <Button
              onClick={load}
              disabled={pending || sub.selectedColumns.length === 0 || !sub.identifierColumn || !sub.resumeColumn}
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {pending ? "Loading…" : sub.loaded ? "Reload rows" : "Load rows"}
            </Button>
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function SelectBox({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
    >
      <option value="">—</option>
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}
