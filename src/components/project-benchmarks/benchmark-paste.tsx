"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { parseBenchmarkPaste, type ParsedBenchmarkRow, type PasteFormat } from "@/lib/benchmark-parse";
import type { BenchmarkCandidateInput } from "@/lib/benchmark-types";

interface BenchmarkPasteProps {
  batch: number;
  /** IDs already in the run → the batch they came in (skipped as duplicates). */
  existing: Map<string, number>;
  onParsed: (candidates: BenchmarkCandidateInput[]) => void;
  disabled?: boolean;
}

const textareaClass =
  "min-h-[220px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

const FORMAT_LABEL: Record<PasteFormat, string> = {
  table: "read as sheet rows (number + resume link / text)",
  links: "read as one resume link per line",
  text: "read as resume text, split at each number",
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
      <textarea
        className={textareaClass}
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
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="inline-flex items-center gap-1.5 text-emerald-700">
            <CheckCircle2 className="h-4 w-4" /> {valid.length} resume{valid.length === 1 ? "" : "s"} ready
            {linked ? ` (${linked} as links)` : ""}
          </span>
          <span className="text-xs text-muted-foreground">Paste {FORMAT_LABEL[format]}</span>
          {problems.length ? (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-amber-700 hover:underline"
              onClick={() => setShowProblems((v) => !v)}
            >
              <AlertTriangle className="h-4 w-4" /> {problems.length} skipped — {showProblems ? "hide" : "show why"}
            </button>
          ) : null}
        </div>
      ) : null}
      {showProblems && problems.length ? (
        <div className="max-h-56 overflow-auto rounded-md border text-xs">
          <table className="w-full">
            <thead className="sticky top-0 bg-muted text-left">
              <tr>
                <th className="px-2 py-1 font-medium">#</th>
                <th className="px-2 py-1 font-medium">Problem</th>
                <th className="px-2 py-1 font-medium">Content</th>
              </tr>
            </thead>
            <tbody>
              {problems.slice(0, 300).map((p) => (
                <tr key={`${p.row}-${p.preview.slice(0, 20)}`} className="border-t">
                  <td className="px-2 py-1 tabular-nums">{p.row || "—"}</td>
                  <td className="px-2 py-1 text-amber-800">{p.problem}</td>
                  <td className="px-2 py-1 font-mono text-muted-foreground">{p.preview}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
