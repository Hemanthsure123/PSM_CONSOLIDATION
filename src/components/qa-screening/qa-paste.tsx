"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { parseQaPaste, type ParsedQaRow } from "@/lib/qa-parse";
import type { QaCandidateInput } from "@/lib/qa-types";

interface QaPasteProps {
  batch: number;
  /** Mobile numbers already in the run → the batch they came in (skipped as duplicates). */
  existing: Map<string, number>;
  onParsed: (candidates: QaCandidateInput[]) => void;
  disabled?: boolean;
}

const textareaClass =
  "min-h-[180px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

/**
 * Paste box for one batch: rows copied from a sheet (mobile + resume link, or
 * mobile + resume text). Parses as you paste and shows what will be screened
 * and which rows can't be (with the reason).
 */
export function QaPaste({ batch, existing, onParsed, disabled }: QaPasteProps) {
  const [text, setText] = React.useState("");
  const [rows, setRows] = React.useState<ParsedQaRow[]>([]);
  const [showProblems, setShowProblems] = React.useState(false);

  // Parse after typing pauses — a 1,000-row paste parses in well under a frame.
  React.useEffect(() => {
    const t = setTimeout(() => {
      const parsed = text.trim() ? parseQaPaste(text, batch, existing) : [];
      setRows(parsed);
      onParsed(parsed.flatMap((r) => (r.candidate ? [r.candidate] : [])));
    }, 250);
    return () => clearTimeout(t);
    // onParsed is a setter from the parent; re-running on its identity is unnecessary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, batch, existing]);

  const valid = rows.filter((r) => r.candidate);
  const problems = rows.filter((r) => !r.candidate);
  const pasted = valid.filter((r) => r.candidate?.resumeText).length;

  return (
    <div className="space-y-3">
      <textarea
        className={textareaClass}
        value={text}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          "Paste rows copied from your sheet — one candidate per row:\n" +
          "9876543210\thttps://drive.google.com/file/d/…/view\n" +
          "9123456780\thttps://drive.google.com/file/d/…/view\n\n" +
          "Columns: mobile number (the candidate's ID) and resume link — any order; a name column is optional.\n" +
          "The resume column may also hold the resume text itself."
        }
      />
      {rows.length ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="inline-flex items-center gap-1.5 text-emerald-700">
            <CheckCircle2 className="h-4 w-4" /> {valid.length} candidate{valid.length === 1 ? "" : "s"} ready
            {pasted ? ` (${pasted} with pasted resume text)` : ""}
          </span>
          {problems.length ? (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-amber-700 hover:underline"
              onClick={() => setShowProblems((v) => !v)}
            >
              <AlertTriangle className="h-4 w-4" /> {problems.length} row{problems.length === 1 ? "" : "s"} skipped —{" "}
              {showProblems ? "hide" : "show why"}
            </button>
          ) : null}
        </div>
      ) : null}
      {showProblems && problems.length ? (
        <div className="max-h-56 overflow-auto rounded-md border text-xs">
          <table className="w-full">
            <thead className="sticky top-0 bg-muted text-left">
              <tr>
                <th className="px-2 py-1 font-medium">Row</th>
                <th className="px-2 py-1 font-medium">Problem</th>
                <th className="px-2 py-1 font-medium">Row content</th>
              </tr>
            </thead>
            <tbody>
              {problems.slice(0, 300).map((p) => (
                <tr key={p.row} className="border-t">
                  <td className="px-2 py-1 tabular-nums">{p.row}</td>
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
