"use client";

import * as React from "react";
import { ArrowRight, FileText, Loader2, Sparkles, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CTC_BANDS, bandThresholds } from "@/lib/assignment-scoring";
import type { AssignmentRunConfig, CtcBand } from "@/lib/assignment-types";

const MAX_FILE_BYTES = 15 * 1024 * 1024;

export const fieldClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60";

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

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4" /> 1 · Assignment &amp; hiring bar
          </CardTitle>
          <CardDescription>
            The CTC band sets how strict the code review is and the score thresholds for each selection status.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="as-name">Run name</Label>
              <Input
                id="as-name"
                value={config.runName}
                onChange={(e) => onConfig({ ...config, runName: e.target.value })}
                placeholder="e.g. Acme — Backend assignment, Batch 14"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="as-company">Company</Label>
              <Input
                id="as-company"
                value={config.company}
                onChange={(e) => onConfig({ ...config, company: e.target.value })}
                placeholder="e.g. Acme Technologies"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="as-band">Target CTC band</Label>
              <select
                id="as-band"
                value={config.ctcBand}
                disabled={locked}
                onChange={(e) => {
                  const band = e.target.value as CtcBand;
                  onConfig({ ...config, ctcBand: band, thresholds: bandThresholds(band) });
                }}
                className={fieldClass}
              >
                {CTC_BANDS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label} — shortlist at {b.thresholds.shortlist}+
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="as-deadline">
                Submission deadline <span className="text-muted-foreground">(optional — flags later commits)</span>
              </Label>
              <Input
                id="as-deadline"
                type="date"
                value={config.deadline}
                disabled={locked}
                onChange={(e) => onConfig({ ...config, deadline: e.target.value })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4" /> 2 · Assignment document
          </CardTitle>
          <CardDescription>
            Paste the complete assignment text, upload the PDF, or both. Every requirement criterion must quote this
            document verbatim — nothing outside it becomes a requirement.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <textarea
            value={text}
            onChange={(e) => onText(e.target.value)}
            disabled={locked}
            rows={14}
            placeholder="Paste the full assignment here — problem statement, features, APIs, tech stack, restrictions, submission instructions, bonus points…"
            className={`${fieldClass} font-mono text-xs leading-relaxed`}
          />
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
              className="hidden"
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
            />
            <Button variant="outline" type="button" disabled={locked} onClick={() => inputRef.current?.click()}>
              <Upload className="h-4 w-4" /> {file ? "Replace document" : "Upload PDF / text"}
            </Button>
            {file ? (
              <span className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1 text-sm">
                <FileText className="h-4 w-4 text-muted-foreground" />
                {file.name} · {(file.size / 1024).toFixed(0)} KB
                {!locked ? (
                  <button
                    type="button"
                    onClick={() => {
                      onFile(null);
                      if (inputRef.current) inputRef.current.value = "";
                    }}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label="Remove file"
                  >
                    <X className="h-4 w-4" />
                  </button>
                ) : null}
              </span>
            ) : null}
            <span className="text-xs text-muted-foreground">{text.length.toLocaleString("en-IN")} characters pasted</span>
          </div>
          {fileError ? <p className="text-sm text-destructive">{fileError}</p> : null}
          {locked ? (
            <p className="text-sm text-muted-foreground">
              Evaluation has started, so the assignment and its rubric are locked. Start a new run to change them.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 py-4">
          <Button onClick={onAnalyze} disabled={!canAnalyze}>
            {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {analyzing ? "Analysing the assignment…" : hasSpec ? "Re-analyse assignment" : "Analyse assignment"}
          </Button>
          {hasSpec ? (
            <Button variant="outline" onClick={onNext} disabled={analyzing}>
              Review criteria <ArrowRight className="h-4 w-4" />
            </Button>
          ) : null}
          {analyzing ? (
            <span className="text-sm text-muted-foreground">Reading the whole document — this can take up to a minute.</span>
          ) : null}
          {error ? <p className="w-full text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
