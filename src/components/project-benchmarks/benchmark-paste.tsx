"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, ChevronDown } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { parseBenchmarkPaste, type ParsedBenchmarkRow, type PasteFormat } from "@/lib/benchmark-parse";
import type { BenchmarkCandidateInput } from "@/lib/benchmark-types";

interface BenchmarkPasteProps {
  batch: number;
  /** IDs already in the run → the batch they came in (skipped as duplicates). */
  existing: Map<string, number>;
  onParsed: (candidates: BenchmarkCandidateInput[]) => void;
  disabled?: boolean;
}

const FORMAT_LABEL: Record<PasteFormat, string> = {
  table: "Read as sheet rows (number + resume link or text)",
  links: "Read as one resume link per line",
  text: "Read as resume text, split at each number",
};

/**
 * Paste box for one batch of resumes: the raw text of many resumes separated by
 * their numbers, or rows copied from a sheet (number + resume link or text).
 * Parses as you paste and shows how many resumes were found and what was skipped.
 */
export function BenchmarkPaste({ batch, existing, onParsed, disabled }: BenchmarkPasteProps) {
  const [text, setText] = React.useState("");
  const [rows, setRows] = React.useState<ParsedBenchmarkRow[]>([]);
  const [format, setFormat] = React.useState<PasteFormat>("text");
  const [showProblems, setShowProblems] = React.useState(false);

  React.useEffect(() => {
    const t = setTimeout(() => {
      const parsed = parseBenchmarkPaste(text, batch, existing);
      setRows(parsed.rows);
      setFormat(parsed.format);
      onParsed(parsed.rows.flatMap((r) => (r.candidate ? [r.candidate] : [])));
    }, 250);
    return () => clearTimeout(t);
    // onParsed is a setter from the parent; re-running on its identity is unnecessary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, batch, existing]);

  const valid = rows.filter((r) => r.candidate);
  const problems = rows.filter((r) => !r.candidate);
  const linked = valid.filter((r) => r.candidate?.resumeUrl).length;

  return (
    <div className="space-y-3">
      <Textarea
        aria-label={`Resumes for batch ${batch}`}
        className="min-h-[220px] font-mono text-xs"
        value={text}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          "Paste the resumes, each one starting with its number on its own line:\n\n" +
          "1\nRavi Kumar · ravi@mail.com\nPROJECTS\nDistributed URL shortener — Go, Redis, Kafka …\n\n" +
          "2\nPriya S …\n\n" +
          "The number can be a serial number (1, 2, 3 …) or the candidate's mobile number.\n" +
          "Rows copied from a sheet also work: number <TAB> resume link (or resume text)."
        }
      />
      {rows.length ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]" aria-live="polite">
          <span className="inline-flex items-center gap-1.5 font-medium text-success">
            <CheckCircle2 className="h-4 w-4" />
            <span>
              <span className="tabular-nums">{valid.length}</span> resume{valid.length === 1 ? "" : "s"} ready
              {linked ? (
                <span className="font-normal">
                  {" "}
                  (<span className="tabular-nums">{linked}</span> as links)
                </span>
              ) : null}
            </span>
          </span>
          <span className="text-xs text-muted-foreground">{FORMAT_LABEL[format]}</span>
          {problems.length ? (
            <button
              type="button"
              aria-expanded={showProblems}
              className="inline-flex items-center gap-1.5 rounded-md font-medium text-warning hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
              onClick={() => setShowProblems((v) => !v)}
            >
              <AlertTriangle className="h-4 w-4" />
              <span className="tabular-nums">{problems.length}</span> skipped
              <span className="font-normal text-muted-foreground">· {showProblems ? "Hide" : "Show why"}</span>
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showProblems && "rotate-180")} />
            </button>
          ) : null}
        </div>
      ) : null}
      {showProblems && problems.length ? (
        <div className="overflow-hidden rounded-lg border">
          <Table containerClassName="max-h-56">
            <TableHeader>
              <TableRow>
                <TableHead className="w-16 text-right">#</TableHead>
                <TableHead>Problem</TableHead>
                <TableHead>Content</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {problems.slice(0, 300).map((p) => (
                <TableRow key={`${p.row}-${p.preview.slice(0, 20)}`}>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{p.row || "—"}</TableCell>
                  <TableCell>{p.problem}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <div className="max-w-[360px] truncate" title={p.preview}>
                      {p.preview}
                    </div>
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
