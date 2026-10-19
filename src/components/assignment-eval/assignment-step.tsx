"use client";

import * as React from "react";
import { FileText, Loader2, Settings2, Sparkles, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Notice } from "@/components/ui/notice";
import { Progress } from "@/components/ui/progress";
import { ActionBar } from "@/components/ui/action-bar";
import { CTC_BANDS, bandThresholds } from "@/lib/assignment-scoring";
import type { AssignmentRunConfig, CtcBand } from "@/lib/assignment-types";

const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** Shared look for the native <select> / <textarea> controls in this flow (design-system field). */
export const fieldClass = "field-control py-2";

interface AssignmentStepProps {
  config: AssignmentRunConfig;
  onConfig: (c: AssignmentRunConfig) => void;
  text: string;
  onText: (t: string) => void;
  file: File | null;
  onFile: (f: File | null) => void;
  analyzing: boolean;
  error: string;
  /** Evaluation already started — the assignment can no longer change. */
  locked: boolean;
  hasSpec: boolean;
  onAnalyze: () => void;
  onNext: () => void;
}

export function AssignmentStep({
  config,
  onConfig,
  text,
  onText,
  file,
  onFile,
  analyzing,
  error,
  locked,
  hasSpec,
  onAnalyze,
  onNext,
}: AssignmentStepProps) {
  const [fileError, setFileError] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const canAnalyze = !analyzing && !locked && (text.trim().length > 40 || Boolean(file));

  const pick = (f: File | null) => {
    setFileError("");
    if (f && f.size > MAX_FILE_BYTES) {
      setFileError("File is larger than 15 MB.");
      return;
    }
    onFile(f);
  };

  const analyseButton = (
    <Button variant={hasSpec ? "outline" : "default"} onClick={onAnalyze} disabled={!canAnalyze}>
      {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
      {analyzing ? "Analysing the assignment…" : hasSpec ? "Re-analyse assignment" : "Analyse assignment"}
    </Button>
  );

  return (
    <div className="max-w-3xl space-y-6">
      {locked ? (
        <Notice tone="info">
          Evaluation has started, so the assignment and its rubric are locked. Start a new run to change them.
        </Notice>
      ) : null}

      <Panel title="Run details" description="Name the run and set the hiring bar." icon={<Settings2 />}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Run name" htmlFor="as-name">
            <Input
              id="as-name"
              value={config.runName}
              onChange={(e) => onConfig({ ...config, runName: e.target.value })}
              placeholder="e.g. Acme backend assignment, batch 14"
            />
          </Field>
          <Field label="Company" htmlFor="as-company">
            <Input
              id="as-company"
              value={config.company}
              onChange={(e) => onConfig({ ...config, company: e.target.value })}
              placeholder="e.g. Acme Technologies"
            />
          </Field>
          <Field
            label="Target CTC band"
            htmlFor="as-band"
            info="The CTC band sets how strict the code review is and the score thresholds for each selection status."
          >
            <NativeSelect
              id="as-band"
              value={config.ctcBand}
              disabled={locked}
              onChange={(e) => {
                const band = e.target.value as CtcBand;
                onConfig({ ...config, ctcBand: band, thresholds: bandThresholds(band) });
              }}
            >
              {CTC_BANDS.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label} · shortlist at {b.thresholds.shortlist}+
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Submission deadline" htmlFor="as-deadline" optional hint="Commits after this date are flagged.">
            <Input
              id="as-deadline"
              type="date"
              value={config.deadline}
              disabled={locked}
              onChange={(e) => onConfig({ ...config, deadline: e.target.value })}
            />
          </Field>
        </div>
      </Panel>

      <Panel
        title="Assignment document"
        description="Paste the full text, upload the PDF, or both."
        icon={<FileText />}
      >
        <div className="space-y-4">
          <Field
            label="Assignment text"
            htmlFor="as-text"
            info="Every requirement criterion must quote this document word for word, so nothing outside it becomes a requirement."
            aside={<span className="tabular-nums">{text.length.toLocaleString("en-IN")} characters</span>}
          >
            <Textarea
              id="as-text"
              value={text}
              onChange={(e) => onText(e.target.value)}
              disabled={locked}
              rows={14}
              placeholder="Paste the full assignment: problem statement, features, APIs, tech stack, restrictions, submission instructions and bonus points."
              className="text-[13px]"
            />
          </Field>

          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
              className="hidden"
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
            />
            <Button variant="outline" type="button" disabled={locked} onClick={() => inputRef.current?.click()}>
              <Upload className="h-4 w-4" /> {file ? "Replace file" : "Upload PDF or text file"}
            </Button>
            {file ? (
              <span className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-lg border bg-muted/50 px-2.5 py-1.5 text-[13px]">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate" title={file.name}>
                  {file.name}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{(file.size / 1024).toFixed(0)} KB</span>
                {!locked ? (
                  <button
                    type="button"
                    onClick={() => {
                      onFile(null);
                      if (inputRef.current) inputRef.current.value = "";
                    }}
                    className="shrink-0 rounded text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
                    aria-label="Remove file"
                  >
                    <X className="h-4 w-4" />
                  </button>
                ) : null}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">PDF, TXT or Markdown, up to 15 MB</span>
            )}
          </div>
          {fileError ? (
            <p className="text-xs text-destructive" role="alert">
              {fileError}
            </p>
          ) : null}
        </div>
      </Panel>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <ActionBar
        status={
          analyzing ? (
            <div className="space-y-2">
              <p>Reading the whole document. This can take up to a minute.</p>
              <Progress label="Analysing the assignment" />
            </div>
          ) : locked ? (
            "The assignment is locked for this run."
          ) : hasSpec ? (
            "Criteria are ready. Re-analyse only if the document changed."
          ) : (
            "The rubric is built from this document only."
          )
        }
      >
        {hasSpec ? (
          <>
            {analyseButton}
            <Button onClick={onNext} disabled={analyzing}>
              Review criteria
            </Button>
          </>
        ) : (
          analyseButton
        )}
      </ActionBar>
    </div>
  );
}
