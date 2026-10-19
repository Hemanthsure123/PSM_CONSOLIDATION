"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, FileUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { Notice } from "@/components/ui/notice";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { STAGE_LABEL, STAGE_TIER, type Stage } from "@/lib/bucketing/config";
import { parseBucketingInput, type ParsedBucketingRow } from "@/lib/bucketing/parse";
import type { BucketingCandidateInput } from "@/lib/bucketing/types";

export interface ParsedInput {
  candidates: BucketingCandidateInput[];
  /** Rows with a mobile but no resume link — listed as "no resume", never sent to the models. */
  noResume: BucketingCandidateInput[];
}

interface BucketingPasteProps {
  batch: number;
  existing: Map<string, number>;
  defaultStage: Stage;
  onParsed: (input: ParsedInput) => void;
  disabled?: boolean;
}

/**
 * Paste rows from the sheet (header row included) or upload its CSV export.
 * Shows the stage mix that will run (TR-2 first) and every row that can't.
 */
export function BucketingPaste({ batch, existing, defaultStage, onParsed, disabled }: BucketingPasteProps) {
  const [text, setText] = React.useState("");
  const [file, setFile] = React.useState<{ name: string; text: string } | null>(null);
  const [rows, setRows] = React.useState<ParsedBucketingRow[]>([]);
  const [showProblems, setShowProblems] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const t = setTimeout(() => {
      const src = file?.text ?? text;
      const parsed = src.trim() ? parseBucketingInput(src, { batch, existing, defaultStage, csv: Boolean(file) }) : [];
      setRows(parsed);
      onParsed({
        candidates: parsed.flatMap((r) => (r.candidate ? [r.candidate] : [])),
        noResume: parsed.flatMap((r) => (r.stub ? [r.stub] : [])),
      });
    }, 250);
    return () => clearTimeout(t);
    // onParsed is a setter from the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, file, batch, existing, defaultStage]);

  const valid = rows.filter((r) => r.candidate);
  const problems = rows.filter((r) => !r.candidate);
  const warnings = rows.filter((r) => r.warning);
  const noResume = rows.filter((r) => r.stub).length;
  const byStage = (Object.keys(STAGE_TIER) as Stage[]).map((s) => ({ s, n: valid.filter((r) => r.candidate?.stage === s).length }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setFile({ name: f.name, text: await f.text() });
            e.target.value = "";
          }}
        />
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => fileRef.current?.click()}>
          <FileUp className="h-4 w-4" /> Upload sheet CSV
        </Button>
        {file ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-secondary px-2 py-1 text-[13px]">
            <span className="truncate" title={file.name}>
              {file.name}
            </span>
            <button
              type="button"
              aria-label="Remove file"
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
              onClick={() => setFile(null)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : (
          <span className="text-[13px] text-muted-foreground">or paste rows below</span>
        )}
        <InfoHint label="Recognised columns" align="start">
          <span className="block">Copy the rows with the header row. Recognised columns:</span>
          <span className="mt-1 block">
            Number / Mobile, Resume, Name, TR 1 Status, TR 2 Status (&quot;Cleared&quot;) or a Stage column, Track (for TR-2).
          </span>
          <span className="mt-1 block">Optional: GitHub, LeetCode, CodeChef, Codeforces.</span>
          <span className="mt-1 block">
            Without a header, each row is read by content, e.g. 9876543210, a resume link, &quot;TR-2 cleared&quot;, MERN.
          </span>
        </InfoHint>
      </div>
      {!file ? (
        <Textarea
          aria-label="Candidate rows"
          className="min-h-[170px] text-[13px]"
          value={text}
          disabled={disabled}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Paste the sheet's rows here, header row included.\nExample without a header:  9876543210   https://drive.google.com/…   TR-2 cleared   MERN"}
        />
      ) : null}
      {rows.length ? (
        <div className="space-y-2 text-[13px]">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1.5 font-medium text-success">
              <CheckCircle2 className="h-4 w-4" /> <span className="tabular-nums">{valid.length}</span> candidate{valid.length === 1 ? "" : "s"} ready
            </span>
            {byStage.map(({ s, n }) => (
              <span key={s} className="text-muted-foreground">
                {STAGE_LABEL[s]}: <span className="font-medium tabular-nums text-foreground">{n}</span>
              </span>
            ))}
          </div>
          {noResume ? (
            <p className="text-muted-foreground">
              {noResume} row{noResume === 1 ? " has" : "s have"} no resume link. They are listed as &quot;No resume link&quot; and not sent to the models.
            </p>
          ) : null}
          {warnings.length ? (
            <Notice tone="warning">
              {warnings.length} TR-2 row{warnings.length === 1 ? " has" : "s have"} no track. They are bucketed from the resume and flagged for review. Add a
              Track column (MERN / Python FS / Java FS / GenAI / AI-ML / DA) to apply the TR-2 rule.
            </Notice>
          ) : null}
          {problems.length - noResume > 0 ? (
            <button
              type="button"
              aria-expanded={showProblems}
              className="inline-flex items-center gap-1.5 rounded text-warning hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
              onClick={() => setShowProblems((v) => !v)}
            >
              <AlertTriangle className="h-4 w-4" /> {problems.length - noResume} row(s) skipped · {showProblems ? "hide" : "show why"}
            </button>
          ) : null}
        </div>
      ) : null}
      {showProblems ? (
        <div className="overflow-hidden rounded-lg border">
          <Table containerClassName="max-h-56" className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="w-14 text-right">Row</TableHead>
                <TableHead>Problem</TableHead>
                <TableHead>Row content</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {problems
                .filter((p) => !p.stub)
                .slice(0, 300)
                .map((p) => (
                  <TableRow key={p.row}>
                    <TableCell className="py-1.5 text-right tabular-nums">{p.row}</TableCell>
                    <TableCell className="py-1.5 text-warning">{p.problem}</TableCell>
                    <TableCell className="max-w-[320px] truncate py-1.5 text-muted-foreground" title={p.preview}>
                      {p.preview}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}
