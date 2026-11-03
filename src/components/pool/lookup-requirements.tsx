"use client";

import * as React from "react";
import { Hash, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Segmented } from "@/components/ui/segmented";
import {
  PICKABLE,
  REQUIREMENT_GROUPS,
  lookupColumns,
  picksAttempts,
  picksInterviews,
  picksMarks,
  textKeys,
  type AttemptChoice,
  type LookupLayout,
  type LookupOptions,
} from "@/lib/pool/lookup";

const flip = (k: "verdict" | "date" | "recording", o: LookupOptions): Partial<LookupOptions> =>
  k === "verdict" ? { verdict: !o.verdict } : k === "date" ? { date: !o.date } : { recording: !o.recording };

const chip = (on: boolean) =>
  cn(
    "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25",
    on ? "border-primary bg-accent font-medium text-accent-foreground" : "bg-card hover:bg-muted",
  );

/**
 * Standing lookup › Requirements — what to add to each row, grouped the way the assessments run:
 * candidate details, the Academy's offline exams, competency interviews and bucket interviews
 * (marks), the Academy pool's status, then Edge 2.0 and Edge 1.0. Marks always get columns of
 * their own; the options under the chips say which columns come with them, and the column list
 * at the bottom shows exactly what the result will hold.
 */
export function LookupRequirements({
  keys,
  options,
  onToggle,
  onSetMany,
  onClear,
  onOption,
}: {
  keys: string[];
  options: LookupOptions;
  onToggle: (key: string) => void;
  onSetMany: (add: string[], remove: string[]) => void;
  onClear: () => void;
  onOption: (patch: Partial<LookupOptions>) => void;
}) {
  const marks = picksMarks(keys);
  const attempts = picksAttempts(keys);
  const interviews = picksInterviews(keys);
  const text = textKeys(keys).length > 0;
  // The result's columns for these choices (an all-attempts set depends on the data: shown as one set).
  const preview = React.useMemo(
    () => lookupColumns([], { phoneColumn: false, keys, options: options.attempts === "all" ? { ...options, attempts: "best" } : options }).filter((c) => c.kind !== "id"),
    [keys, options],
  );

  return (
    <Panel
      icon={<ListChecks />}
      title={
        <>
          Requirements <span className="font-sans text-xs font-normal text-muted-foreground">(optional)</span>
        </>
      }
      description="What to add to each row. Only the results a candidate has are filled in."
      actions={
        keys.length ? (
          <>
            <span className="text-xs text-muted-foreground tabular-nums">{keys.length} picked</span>
            <Button variant="ghost" size="sm" onClick={onClear}>
              Clear
            </Button>
          </>
        ) : null
      }
    >
      <div className="grid gap-4">
        {REQUIREMENT_GROUPS.map(({ group, label, hint }) => {
          const items = PICKABLE.filter((r) => r.group === group);
          const on = items.filter((r) => keys.includes(r.key)).length;
          return (
            <section key={group} aria-label={label} className="grid gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-xs font-medium">
                  {label}
                  {hint ? <span className="ml-1.5 font-normal text-muted-foreground">{hint}</span> : null}
                </p>
                <button
                  type="button"
                  onClick={() => (on === items.length ? onSetMany([], items.map((r) => r.key)) : onSetMany(items.map((r) => r.key), []))}
                  className="rounded text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
                >
                  {on === items.length ? "None" : "All"}
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={`${label} requirements`}>
                {items.map((r) => {
                  const picked = keys.includes(r.key);
                  return (
                    <button key={r.key} type="button" aria-pressed={picked} onClick={() => onToggle(r.key)} className={chip(picked)} title={r.mark ? "Marks — columns of their own" : undefined}>
                      {r.mark ? <Hash className="h-3 w-3 opacity-60" aria-hidden /> : null}
                      {r.label}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {keys.length ? (
        <div className="mt-5 grid gap-3 border-t pt-4">
          {marks && attempts ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-32 shrink-0 text-xs font-medium text-muted-foreground">Repeat attempts</span>
                <Segmented<AttemptChoice>
                  size="sm"
                  ariaLabel="Which attempt of a repeated exam or interview to show"
                  value={options.attempts}
                  onChange={(a) => onOption({ attempts: a })}
                  options={[
                    { value: "best", label: "Best" },
                    { value: "latest", label: "Latest" },
                    { value: "all", label: "All" },
                  ]}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-32 shrink-0 text-xs font-medium text-muted-foreground">With each mark</span>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Columns beside each mark">
                  {(
                    [
                      ["verdict", "Verdict", true],
                      ["date", "Date", true],
                      ["recording", "Recording link", interviews],
                    ] as const
                  )
                    .filter(([, , show]) => show)
                    .map(([k, label]) => (
                      <button key={k} type="button" aria-pressed={options[k]} onClick={() => onOption(flip(k, options))} className={chip(options[k])}>
                        {label}
                      </button>
                    ))}
                </div>
              </div>
            </>
          ) : null}
          {text ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-32 shrink-0 text-xs font-medium text-muted-foreground">Other details</span>
              <Segmented<LookupLayout>
                size="sm"
                ariaLabel="How the other details are laid out"
                value={options.layout}
                onChange={(layout) => onOption({ layout })}
                options={[
                  { value: "cell", label: "One Requirements column" },
                  { value: "columns", label: "A column each" },
                ]}
              />
            </div>
          ) : null}
          <div className="rounded-lg bg-muted/50 px-3 py-2.5">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              Columns of the result{options.attempts === "all" && marks && attempts ? " — with All, each mark's columns repeat per exam date or attempt" : ""}
            </p>
            <div className="flex flex-wrap gap-1">
              {preview.map((c) => (
                <span
                  key={c.header}
                  className={cn(
                    "rounded-md border bg-card px-1.5 py-0.5 text-[11px]",
                    c.kind === "score" ? "border-primary/40 font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {c.header}
                </span>
              ))}
            </div>
            {marks ? <p className="mt-1.5 text-[11px] text-muted-foreground">A marks column holds only the marks obtained; its maximum is in the header.</p> : null}
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
