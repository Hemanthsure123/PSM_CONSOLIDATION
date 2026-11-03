"use client";

import * as React from "react";
import { Filter, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Segmented } from "@/components/ui/segmented";
import { NativeSelect } from "@/components/ui/select";
import { fetchScoresSummary } from "@/lib/pool/client";
import { ASSESSMENTS, assessmentInfo, isAssessmentKey, type AssessmentKey, type EligibilityFilter, type ScoresSummary } from "@/lib/pool/scores/catalogue";

const fmt = (n: number) => n.toLocaleString("en-IN");

export interface FindFilter {
  colleges: string[];
  yogs: number[];
  assessment?: AssessmentKey;
  minScore?: number;
  eligibility: EligibilityFilter;
}

/**
 * Standing lookup › Find — everyone assessed, by job eligibility (in the eligible pool or not), a
 * college, a year of graduation, or at least a given mark. The filter is lifted to the screen,
 * which runs it and looks the people up.
 */
export function LookupFind({ onChange, note }: { onChange: (f: FindFilter, ready: boolean) => void; note: string | null }) {
  const [info, setInfo] = React.useState<ScoresSummary | null>(null);
  const [colleges, setColleges] = React.useState<string[]>([]);
  const [draft, setDraft] = React.useState("");
  const [yogs, setYogs] = React.useState<number[]>([]);
  const [assessment, setAssessment] = React.useState<AssessmentKey | "">("");
  const [minScore, setMinScore] = React.useState("");
  const [eligibility, setEligibility] = React.useState<EligibilityFilter>("all");

  React.useEffect(() => {
    let live = true;
    fetchScoresSummary().then((res) => {
      if (live && res.ok) setInfo(res.data);
    });
    return () => {
      live = false;
    };
  }, []);

  // A college typed but not added yet still counts.
  React.useEffect(() => {
    const all = draft.trim() && !colleges.some((c) => c.toLowerCase() === draft.trim().toLowerCase()) ? [...colleges, draft.trim()] : colleges;
    const min = minScore.trim() === "" ? undefined : Number(minScore);
    onChange(
      { colleges: all, yogs, assessment: assessment || undefined, minScore: assessment && min !== undefined && Number.isFinite(min) ? min : undefined, eligibility },
      all.length > 0 || yogs.length > 0 || Boolean(assessment) || eligibility !== "all",
    );
  }, [colleges, draft, yogs, assessment, minScore, eligibility, onChange]);

  const add = () => {
    const c = draft.trim();
    if (!c) return;
    setColleges((xs) => (xs.some((x) => x.toLowerCase() === c.toLowerCase()) ? xs : [...xs, c].slice(0, 50)));
    setDraft("");
  };
  const max = assessment ? assessmentInfo(assessment).max : null;

  return (
    <Panel
      icon={<Filter />}
      title="Find candidates"
      description="Everyone assessed — by job eligibility, college, year of graduation or a minimum mark. The filters you set apply together."
    >
      <div className="grid gap-5">
        <Field
          label="Job eligibility"
          hint={
            info
              ? `Eligible = in the eligible pool (${fmt(info.people.eligible)} with marks); Not eligible = assessed, not in the pool (${fmt(info.people.notEligible)}).`
              : "Eligible = in the eligible pool; Not eligible = assessed, not in the pool."
          }
        >
          <Segmented<EligibilityFilter>
            ariaLabel="Job eligibility"
            value={eligibility}
            onChange={setEligibility}
            options={[
              { value: "all", label: "Everyone" },
              { value: "eligible", label: "Eligible" },
              { value: "not-eligible", label: "Not eligible" },
            ]}
            className="justify-self-start"
          />
        </Field>

        <Field label="College" htmlFor="sl-college" optional hint={colleges.length ? "Any of these colleges." : "Part of the name is enough (e.g. VIT, Vignan). Add several to include each."}>
          <div className="flex gap-2">
            <Input
              id="sl-college"
              list="sl-colleges"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder={info ? `${fmt(info.colleges.length)} colleges — start typing…` : "Start typing a college…"}
              autoComplete="off"
            />
            <Button variant="outline" onClick={add} disabled={!draft.trim()}>
              Add
            </Button>
          </div>
          <datalist id="sl-colleges">
            {(info?.colleges ?? []).map((x) => (
              <option key={x.college} value={x.college}>
                {`${fmt(x.people)} people`}
              </option>
            ))}
          </datalist>
          {colleges.length ? (
            <div className="flex flex-wrap gap-1.5">
              {colleges.map((x) => (
                <span key={x} className="inline-flex items-center gap-1 rounded-full border border-primary bg-accent py-0.5 pl-2.5 pr-1 text-xs text-accent-foreground">
                  {x}
                  <button
                    type="button"
                    aria-label={`Remove ${x}`}
                    onClick={() => setColleges((xs) => xs.filter((y) => y !== x))}
                    className="rounded-full p-0.5 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </Field>

        <Field label="Year of graduation" optional hint={yogs.length ? "Any of the years picked." : "Pick one or more."}>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Years of graduation">
            {(info?.yogs ?? []).map((y) => {
              const on = yogs.includes(y.yog);
              return (
                <button
                  key={y.yog}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setYogs((xs) => (on ? xs.filter((v) => v !== y.yog) : [...xs, y.yog]))}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25",
                    on ? "border-primary bg-accent font-medium text-accent-foreground" : "bg-card hover:bg-muted",
                  )}
                >
                  {y.yog} <span className="text-muted-foreground">{fmt(y.people)}</span>
                </button>
              );
            })}
            {!info ? <span className="text-xs text-muted-foreground">Loading…</span> : null}
          </div>
        </Field>

        <Field label="Minimum marks" htmlFor="sl-min-assessment" optional hint="Any attempt counts; the list comes best mark first.">
          <div className="flex flex-col gap-2 sm:flex-row">
            <NativeSelect
              id="sl-min-assessment"
              value={assessment}
              onChange={(e) => setAssessment(isAssessmentKey(e.target.value) ? e.target.value : "")}
              wrapperClassName="min-w-0 flex-1"
            >
              <option value="">No minimum</option>
              {ASSESSMENTS.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.label} ({a.max})
                </option>
              ))}
            </NativeSelect>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              max={max ?? undefined}
              step="any"
              value={minScore}
              onChange={(e) => setMinScore(e.target.value)}
              disabled={!assessment}
              placeholder={max ? `out of ${max}` : "marks"}
              aria-label="Minimum marks"
              className="sm:w-36"
            />
          </div>
        </Field>
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      </div>
    </Panel>
  );
}
