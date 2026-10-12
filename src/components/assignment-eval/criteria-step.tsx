"use client";

import * as React from "react";
import { ArrowLeft, ArrowRight, ListChecks, Lock, Plus, ShieldCheck, SlidersHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fieldClass } from "@/components/assignment-eval/assignment-step";
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
  return <Badge className="border-transparent bg-amber-100 text-amber-800">Not found in document</Badge>;
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
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ListChecks className="h-4 w-4" /> {spec.title}
            {locked ? (
              <Badge variant="secondary" className="gap-1">
                <Lock className="h-3 w-3" /> Locked — evaluation started
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>{spec.summary}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge variant="secondary">{counts.mandatory} mandatory</Badge>
            <Badge variant="secondary">{counts.good} good to have</Badge>
            <Badge variant="secondary">{counts.excellence} excellence</Badge>
            <Badge variant="outline">Extracted by {spec.model}</Badge>
            {counts.unquoted ? (
              <Badge className="border-transparent bg-amber-100 text-amber-800">
                {counts.unquoted} requirement{counts.unquoted === 1 ? "" : "s"} not found in the document — off by default
              </Badge>
            ) : null}
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {(
              [
                ["requiredStack", "Required stack"],
                ["restrictions", "Restrictions (violations are flagged)"],
                ["deliverables", "Deliverables"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="grid gap-1.5">
                <Label className="text-xs text-muted-foreground">{label} — one per line</Label>
                <textarea
                  rows={5}
                  disabled={locked}
                  defaultValue={spec[key].join("\n")}
                  onBlur={(e) => setList(key, e.target.value)}
                  className={fieldClass}
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" /> Shortlisting criteria
          </CardTitle>
          <CardDescription>
            Requirements come only from the assignment and carry the sentence they were taken from. Excellence
            criteria are the quality bar for {bandLabel(config.ctcBand)} and can be switched off individually. Every
            mandatory criterion must be met in full for a candidate to be shortlisted.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">On</TableHead>
                <TableHead className="w-12">ID</TableHead>
                <TableHead>Criterion</TableHead>
                <TableHead className="w-44">Type</TableHead>
                <TableHead className="w-24">Weight</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {spec.criteria.map((c) => (
                <TableRow key={c.id} className={cn(!c.enabled && "opacity-50")}>
                  <TableCell className="align-top">
                    <Checkbox
                      checked={c.enabled}
                      disabled={locked}
                      onCheckedChange={(v) => setCriterion(c.id, { enabled: v })}
                    />
                  </TableCell>
                  <TableCell className="align-top font-mono text-xs">{c.id}</TableCell>
                  <TableCell className="space-y-1 align-top">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{c.title}</span>
                      <QuoteBadge c={c} />
                      <span className="text-xs text-muted-foreground">{c.category}</span>
                    </div>
                    {c.description ? <p className="text-sm text-muted-foreground">{c.description}</p> : null}
                    {c.sourceQuote ? (
                      <p className="border-l-2 pl-2 text-xs italic text-muted-foreground">“{c.sourceQuote}”</p>
                    ) : null}
                    {c.howToVerify ? <p className="text-xs text-muted-foreground">Verify: {c.howToVerify}</p> : null}
                  </TableCell>
                  <TableCell className="align-top">
                    <select
                      value={c.type}
                      disabled={locked}
                      onChange={(e) => setCriterion(c.id, { type: e.target.value as CriterionType })}
                      className={fieldClass}
                    >
                      {(Object.keys(TYPE_LABEL) as CriterionType[]).map((t) => (
                        <option key={t} value={t}>
                          {TYPE_LABEL[t]}
                        </option>
                      ))}
                    </select>
                  </TableCell>
                  <TableCell className="align-top">
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      value={c.weight}
                      disabled={locked}
                      onChange={(e) => setCriterion(c.id, { weight: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    {!locked ? (
                      <button
                        type="button"
                        onClick={() => onSpec({ ...spec, criteria: spec.criteria.filter((x) => x.id !== c.id) })}
                        className="mt-2 text-muted-foreground hover:text-destructive"
                        aria-label={`Delete ${c.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
        {!locked ? (
          <CardContent className="grid gap-3 border-t pt-4 md:grid-cols-[2fr_3fr_1fr_auto_auto] md:items-end">
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">Add a criterion</Label>
              <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Title" />
            </div>
            <Input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="What exactly must the code do?"
            />
            <select
              value={draft.type}
              onChange={(e) => setDraft({ ...draft, type: e.target.value as CriterionType })}
              className={fieldClass}
            >
              {(Object.keys(TYPE_LABEL) as CriterionType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <Input
              type="number"
              min={1}
              max={10}
              value={draft.weight}
              onChange={(e) => setDraft({ ...draft, weight: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
              className="w-20"
            />
            <Button variant="outline" onClick={addCriterion} disabled={!draft.title.trim()}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <SlidersHorizontal className="h-4 w-4" /> Selection thresholds · {bandLabel(config.ctcBand)}
          </CardTitle>
          <CardDescription>
            Overall score (0–100) needed for each status. Changing these re-grades finished candidates instantly —
            no re-evaluation needed.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4">
          {(
            [
              ["strong", "Strongly Shortlisted ≥"],
              ["shortlist", "Shortlisted ≥"],
              ["borderline", "Borderline (manual review) ≥"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">{label}</Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={config.thresholds[key]}
                onChange={(e) => setThreshold(key, e.target.value)}
                className="w-28"
              />
            </div>
          ))}
          <Button variant="ghost" onClick={() => onConfig({ ...config, thresholds: bandThresholds(config.ctcBand) })}>
            Reset to band defaults
          </Button>
        </CardContent>
      </Card>

      <div className="flex flex-wrap justify-between gap-3">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Assignment
        </Button>
        <Button onClick={onNext} disabled={!enabled.length}>
          Candidates <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
