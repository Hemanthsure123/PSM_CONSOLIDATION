"use client";

import * as React from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, Github, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Notice } from "@/components/ui/notice";
import { Disclosure } from "@/components/ui/disclosure";
import { ActionBar } from "@/components/ui/action-bar";
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
    <div className="max-w-3xl space-y-6">
      <Panel
        title="Candidates"
        description="Paste two columns from a sheet: mobile number and GitHub link."
        icon={<Users />}
      >
        <div className="space-y-4">
          <Field
            label="Mobile number and GitHub link, one candidate per line"
            htmlFor="as-candidates"
            info={
              <>
                The mobile number is used as the candidate&apos;s ID. Repository links,{" "}
                <code className="text-xs">/tree/&lt;branch&gt;/&lt;folder&gt;</code> links and profile links all work.
                For a profile link, the repository matching the assignment is picked and flagged.
              </>
            }
          >
            <Textarea
              id="as-candidates"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={12}
              placeholder={"9876543210\thttps://github.com/user/assignment-repo\n9123456780\thttps://github.com/user2/repo/tree/main/backend"}
              className="text-[13px] tabular-nums"
            />
          </Field>

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="success">
              <CheckCircle2 /> <span className="tabular-nums">{valid.length}</span> ready
            </Badge>
            {problems.length ? (
              <Badge variant="warning">
                <AlertTriangle /> <span className="tabular-nums">{problems.length}</span> skipped
              </Badge>
            ) : null}
          </div>

          {problems.length ? (
            <Notice
              tone="warning"
              title={`${problems.length} line${problems.length === 1 ? "" : "s"} will be skipped`}
            >
              <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto pr-1 text-xs">
                {problems.map((p) => (
                  <li key={p.line} className="min-w-0">
                    <span className="font-medium tabular-nums">Line {p.line}</span>: {p.problem}.{" "}
                    <span className="break-all opacity-80">{p.raw.slice(0, 120)}</span>
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}
        </div>
      </Panel>

      <Disclosure title="Advanced options" summary={`${config.concurrency} reviewed at a time`}>
        <Field
          label="Repositories reviewed in parallel"
          htmlFor="as-conc"
          className="max-w-xs"
          info="Repositories are reviewed in a rolling window: a new one starts the moment one finishes. Higher is faster; when Gemini starts rate-limiting, the overflow is reviewed by Mistral."
        >
          <NativeSelect
            id="as-conc"
            value={config.concurrency}
            onChange={(e) => onConfig({ ...config, concurrency: Number(e.target.value) })}
          >
            {[1, 2, 3, 4, 5, 6, 8].map((n) => (
              <option key={n} value={n}>
                {n} at a time{n === 4 ? " (recommended)" : ""}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </Disclosure>

      <ActionBar
        status={
          valid.length ? (
            <span className="tabular-nums">
              {valid.length} candidate{valid.length === 1 ? "" : "s"} ready
              {problems.length ? `, ${problems.length} skipped` : ""}
            </span>
          ) : (
            "Paste at least one mobile number with its GitHub link."
          )
        }
      >
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Button onClick={() => onUse(valid)} disabled={!valid.length}>
          <Github className="h-4 w-4" /> Use {valid.length} candidate{valid.length === 1 ? "" : "s"}
        </Button>
      </ActionBar>
    </div>
  );
}
