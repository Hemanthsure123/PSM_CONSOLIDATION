"use client";

import * as React from "react";
import { ArrowLeft, ListChecks, Lock, Plus, ShieldCheck, SlidersHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Notice } from "@/components/ui/notice";
import { InfoHint } from "@/components/ui/info-hint";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionBar } from "@/components/ui/action-bar";
import { bandLabel, bandThresholds } from "@/lib/assignment-scoring";
import type {
  AssignmentCriterion,
  AssignmentRunConfig,
  AssignmentSpec,
  CriterionType,
  Thresholds,
} from "@/lib/assignment-types";
import { cn } from "@/lib/utils";

const TYPE_LABEL: Record<CriterionType, string> = {
  mandatory: "Mandatory",
  good: "Good to have",
  excellence: "Excellence",
};

function QuoteBadge({ c }: { c: AssignmentCriterion }) {
  if (c.type === "excellence") return <Badge variant="outline">Quality bar</Badge>;
  if (c.quoteCheck === "exact") return <Badge variant="success">Quoted</Badge>;
  if (c.quoteCheck === "approx") return <Badge variant="secondary">Close match</Badge>;
  if (c.quoteCheck === "skipped") return <Badge variant="outline">Not verifiable (scanned PDF)</Badge>;
  return <Badge variant="warning">Not found in document</Badge>;
}

interface CriteriaStepProps {
  spec: AssignmentSpec;
  config: AssignmentRunConfig;
  locked: boolean;
  onSpec: (s: AssignmentSpec) => void;
  onConfig: (c: AssignmentRunConfig) => void;
  onBack: () => void;
  onNext: () => void;
}

export function CriteriaStep({ spec, config, locked, onSpec, onConfig, onBack, onNext }: CriteriaStepProps) {
  const [draft, setDraft] = React.useState({ title: "", description: "", type: "mandatory" as CriterionType, weight: 6 });

  const setCriterion = (id: string, patch: Partial<AssignmentCriterion>) =>
    onSpec({ ...spec, criteria: spec.criteria.map((c) => (c.id === id ? { ...c, ...patch } : c)) });

  const setList = (key: "requiredStack" | "restrictions" | "deliverables", value: string) =>
    onSpec({ ...spec, [key]: value.split("\n").map((s) => s.trim()).filter(Boolean) });

  const addCriterion = () => {
    if (!draft.title.trim()) return;
    const next = Math.max(0, ...spec.criteria.map((c) => Number(c.id.replace(/\D/g, "")) || 0)) + 1;
    onSpec({
      ...spec,
      criteria: [
        ...spec.criteria,
        {
          id: `C${next}`,
          title: draft.title.trim(),
          description: draft.description.trim(),
          category: "functional",
          type: draft.type,
          weight: draft.weight,
          sourceQuote: "",
          quoteCheck: "skipped",
          howToVerify: "",
          enabled: true,
        },
      ],
    });
    setDraft({ title: "", description: "", type: "mandatory", weight: 6 });
  };

  const setThreshold = (key: keyof Thresholds, v: string) => {
    const n = Math.max(0, Math.min(100, Number(v) || 0));
    onConfig({ ...config, thresholds: { ...config.thresholds, [key]: n } });
  };

  const enabled = spec.criteria.filter((c) => c.enabled);
  const counts = {
    mandatory: enabled.filter((c) => c.type === "mandatory").length,
    good: enabled.filter((c) => c.type === "good").length,
    excellence: enabled.filter((c) => c.type === "excellence").length,
    unquoted: spec.criteria.filter((c) => c.type !== "excellence" && c.quoteCheck === "missing").length,
  };

  return (
    <div className="max-w-3xl space-y-6">
      {/* What the rubric was built from. */}
      <Panel
        title={spec.title}
        icon={<ListChecks />}
        actions={
          locked ? (
            <Badge variant="secondary">
              <Lock /> Locked, evaluation started
            </Badge>
          ) : null
        }
      >
        <div className="space-y-4">
          {spec.summary ? <p className="text-[13px] leading-relaxed text-muted-foreground">{spec.summary}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">
              <span className="tabular-nums">{counts.mandatory}</span> mandatory
            </Badge>
            <Badge variant="secondary">
              <span className="tabular-nums">{counts.good}</span> good to have
            </Badge>
            <Badge variant="secondary">
              <span className="tabular-nums">{counts.excellence}</span> excellence
            </Badge>
            <span className="text-xs text-muted-foreground">Extracted by {spec.model}</span>
          </div>
          {counts.unquoted ? (
            <Notice tone="warning">
              <span className="tabular-nums">{counts.unquoted}</span> requirement{counts.unquoted === 1 ? "" : "s"} not
              found in the document. {counts.unquoted === 1 ? "It is" : "They are"} off by default.
            </Notice>
          ) : null}
        </div>
      </Panel>

      <Disclosure
        title="Stack, restrictions and deliverables"
        summary={`${spec.requiredStack.length} stack items · ${spec.restrictions.length} restrictions · ${spec.deliverables.length} deliverables`}
      >
        <div className="grid gap-4 md:grid-cols-3">
          {(
            [
              ["requiredStack", "Required stack", ""],
              ["restrictions", "Restrictions", "Violations are flagged in the results."],
              ["deliverables", "Deliverables", ""],
            ] as const
          ).map(([key, label, info]) => (
            <Field key={key} label={label} htmlFor={`as-list-${key}`} hint="One per line" info={info || undefined}>
              <Textarea
                id={`as-list-${key}`}
                rows={5}
                disabled={locked}
                defaultValue={spec[key].join("\n")}
                onBlur={(e) => setList(key, e.target.value)}
                className="text-[13px]"
              />
            </Field>
          ))}
        </div>
      </Disclosure>

      {/* The rubric itself. */}
      <Panel
        title={
          <span className="inline-flex items-center gap-1">
            Shortlisting criteria
            <InfoHint className="font-sans tracking-normal">
              Requirements come only from the assignment and carry the sentence they were taken from. Excellence
              criteria are the quality bar for {bandLabel(config.ctcBand)} and can be switched off individually. Every
              mandatory criterion must be met in full for a candidate to be shortlisted.
            </InfoHint>
          </span>
        }
        description="Switch off anything that should not count. Weight is 1 to 10."
        icon={<ShieldCheck />}
        flush
      >
        {spec.criteria.length === 0 ? (
          <div className="px-5 pb-5">
            <EmptyState
              title="No criteria"
              description="Add one below, or go back and re-analyse the assignment."
              className="py-8"
            />
          </div>
        ) : (
          <ul className="divide-y border-t">
            {spec.criteria.map((c) => (
              <li key={c.id} className={cn("px-5 py-4", !c.enabled && "bg-muted/40")}>
                <div className="flex items-start gap-3">
                  <Checkbox
                    checked={c.enabled}
                    disabled={locked}
                    onCheckedChange={(v) => setCriterion(c.id, { enabled: v })}
                    aria-label={`Use ${c.id}: ${c.title}`}
                    className="mt-0.5"
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className={cn("min-w-0 space-y-1.5", !c.enabled && "opacity-60")}>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-xs font-medium tabular-nums text-muted-foreground">{c.id}</span>
                        <span className="font-medium">{c.title}</span>
                        <QuoteBadge c={c} />
                        <span className="text-xs text-muted-foreground">{c.category}</span>
                      </div>
                      {c.description ? (
                        <p className="text-[13px] leading-relaxed text-muted-foreground">{c.description}</p>
                      ) : null}
                      {c.sourceQuote ? (
                        <p className="border-l-2 pl-2.5 text-xs italic leading-relaxed text-muted-foreground">
                          “{c.sourceQuote}”
                        </p>
                      ) : null}
                      {c.howToVerify ? (
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          <span className="font-medium text-foreground">Verify:</span> {c.howToVerify}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <NativeSelect
                        aria-label={`Type of ${c.id}`}
                        value={c.type}
                        disabled={locked}
                        onChange={(e) => setCriterion(c.id, { type: e.target.value as CriterionType })}
                        wrapperClassName="w-40"
                        className="h-9 text-[13px]"
                      >
                        {(Object.keys(TYPE_LABEL) as CriterionType[]).map((t) => (
                          <option key={t} value={t}>
                            {TYPE_LABEL[t]}
                          </option>
                        ))}
                      </NativeSelect>
                      <Input
                        type="number"
                        aria-label={`Weight of ${c.id}`}
                        title="Weight (1–10)"
                        min={1}
                        max={10}
                        value={c.weight}
                        disabled={locked}
                        onChange={(e) =>
                          setCriterion(c.id, { weight: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })
                        }
                        className="h-9 w-16 tabular-nums"
                      />
                      {!locked ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onSpec({ ...spec, criteria: spec.criteria.filter((x) => x.id !== c.id) })}
                          className="hover:bg-destructive-soft hover:text-destructive"
                          aria-label={`Delete ${c.id}`}
                        >
                          <Trash2 />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {!locked ? (
          <div className="space-y-3 rounded-b-xl border-t bg-muted/40 px-5 py-4">
            <p className="text-sm font-medium">Add a criterion</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Title" htmlFor="as-new-title">
                <Input
                  id="as-new-title"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder="e.g. Paginated list API"
                />
              </Field>
              <Field label="Description" htmlFor="as-new-desc" optional>
                <Input
                  id="as-new-desc"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="What exactly must the code do?"
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Type" htmlFor="as-new-type" className="w-44">
                <NativeSelect
                  id="as-new-type"
                  value={draft.type}
                  onChange={(e) => setDraft({ ...draft, type: e.target.value as CriterionType })}
                >
                  {(Object.keys(TYPE_LABEL) as CriterionType[]).map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABEL[t]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Weight" htmlFor="as-new-weight" className="w-24">
                <Input
                  id="as-new-weight"
                  type="number"
                  min={1}
                  max={10}
                  value={draft.weight}
                  onChange={(e) => setDraft({ ...draft, weight: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
                  className="tabular-nums"
                />
              </Field>
              <Button variant="outline" onClick={addCriterion} disabled={!draft.title.trim()}>
                <Plus className="h-4 w-4" /> Add criterion
              </Button>
            </div>
          </div>
        ) : null}
      </Panel>

      <Panel
        title="Selection thresholds"
        description={
          <>
            {bandLabel(config.ctcBand)}. Overall score (0–100) needed for each status.{" "}
            <InfoHint>Changing these re-grades finished candidates instantly. No re-evaluation is needed.</InfoHint>
          </>
        }
        icon={<SlidersHorizontal />}
        actions={
          <Button variant="ghost" size="sm" onClick={() => onConfig({ ...config, thresholds: bandThresholds(config.ctcBand) })}>
            Reset to band defaults
          </Button>
        }
      >
        <div className="grid gap-4 sm:grid-cols-3">
          {(
            [
              ["strong", "Strongly shortlisted ≥"],
              ["shortlist", "Shortlisted ≥"],
              ["borderline", "Borderline (manual review) ≥"],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label} htmlFor={`as-th-${key}`}>
              <Input
                id={`as-th-${key}`}
                type="number"
                min={0}
                max={100}
                value={config.thresholds[key]}
                onChange={(e) => setThreshold(key, e.target.value)}
                className="tabular-nums"
              />
            </Field>
          ))}
        </div>
      </Panel>

      <ActionBar
        status={
          enabled.length ? (
            <span className="tabular-nums">
              {enabled.length} criteri{enabled.length === 1 ? "on" : "a"} on: {counts.mandatory} mandatory, {counts.good}{" "}
              good to have, {counts.excellence} excellence
            </span>
          ) : (
            "Switch on at least one criterion to continue."
          )
        }
      >
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Button onClick={onNext} disabled={!enabled.length}>
          Continue to candidates
        </Button>
      </ActionBar>
    </div>
  );
}
