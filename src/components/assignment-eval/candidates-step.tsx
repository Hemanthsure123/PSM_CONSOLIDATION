"use client";

import * as React from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, Github, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { fieldClass } from "@/components/assignment-eval/assignment-step";
import { parseCandidateRows } from "@/lib/assignment-parse";
import type { AssignmentRunConfig, CandidateInput } from "@/lib/assignment-types";

interface CandidatesStepProps {
  initial: CandidateInput[];
  config: AssignmentRunConfig;
  onConfig: (c: AssignmentRunConfig) => void;
  onBack: () => void;
  onUse: (list: CandidateInput[]) => void;
}

export function CandidatesStep({ initial, config, onConfig, onBack, onUse }: CandidatesStepProps) {
  const [text, setText] = React.useState(() => initial.map((c) => `${c.id}\t${c.githubUrl}`).join("\n"));
  const parsed = React.useMemo(() => parseCandidateRows(text), [text]);
  const valid = parsed.filter((r) => r.candidate).map((r) => r.candidate!);
  const problems = parsed.filter((r) => !r.candidate);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4" /> 3 · Candidates
          </CardTitle>
          <CardDescription>
            Paste two columns straight from a sheet — <strong>mobile number</strong> (used as the candidate&apos;s ID)
            and <strong>GitHub link</strong>. Repo links, <code>/tree/&lt;branch&gt;/&lt;folder&gt;</code> links and
            profile links all work; for a profile link the repo matching the assignment is picked and flagged.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={12}
            placeholder={"9876543210\thttps://github.com/user/assignment-repo\n9123456780\thttps://github.com/user2/repo/tree/main/backend"}
            className={`${fieldClass} font-mono text-xs`}
          />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="success" className="gap-1">
              <CheckCircle2 className="h-3 w-3" /> {valid.length} ready
            </Badge>
            {problems.length ? (
              <Badge className="gap-1 border-transparent bg-amber-100 text-amber-800">
                <AlertTriangle className="h-3 w-3" /> {problems.length} skipped
              </Badge>
            ) : null}
          </div>
          {problems.length ? (
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-muted/30 p-3 text-xs">
              {problems.map((p) => (
                <li key={p.line}>
                  <span className="font-mono">Line {p.line}</span> — {p.problem}:{" "}
                  <span className="text-muted-foreground">{p.raw.slice(0, 120)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 py-4">
          <div className="grid gap-1.5">
            <Label htmlFor="as-conc" className="text-xs text-muted-foreground">
              Repositories reviewed in parallel
            </Label>
            <select
              id="as-conc"
              value={config.concurrency}
              onChange={(e) => onConfig({ ...config, concurrency: Number(e.target.value) })}
              className={`${fieldClass} w-48`}
            >
              {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                <option key={n} value={n}>
                  {n} at a time{n === 4 ? " (recommended)" : ""}
                </option>
              ))}
            </select>
          </div>
          <p className="max-w-md text-xs text-muted-foreground">
            Repositories are reviewed in a rolling window — a new one starts the moment one finishes. Higher is
            faster; when Gemini starts rate-limiting, the overflow is reviewed by Mistral.
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap justify-between gap-3">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Criteria
        </Button>
        <Button onClick={() => onUse(valid)} disabled={!valid.length}>
          <Github className="h-4 w-4" /> Use {valid.length} candidate{valid.length === 1 ? "" : "s"}
        </Button>
      </div>
    </div>
  );
}
