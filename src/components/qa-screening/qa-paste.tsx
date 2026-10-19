"use client";

import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { parseQaPaste, type ParsedQaRow } from "@/lib/qa-parse";
import type { QaCandidateInput } from "@/lib/qa-types";
import { cn } from "@/lib/utils";

interface QaPasteProps {
  batch: number;
  /** Mobile numbers already in the run → the batch they came in (skipped as duplicates). */
  existing: Map<string, number>;
  onParsed: (candidates: QaCandidateInput[]) => void;
  disabled?: boolean;
}

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
      <Textarea
        aria-label={`Candidate rows for batch ${batch}`}
        className="min-h-[180px] text-[13px] tabular-nums"
        value={text}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          "Paste rows copied from your sheet, one candidate per row:\n" +
          "9876543210\thttps://drive.google.com/file/d/…/view\n" +
          "9123456780\thttps://drive.google.com/file/d/…/view\n\n" +
          "Columns: mobile number (the candidate's ID) and resume link, in any order. A name column is optional.\n" +
          "The resume column may also hold the resume text itself."
        }
      />

      {rows.length ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]" aria-live="polite">
          <span className={cn("inline-flex items-center gap-1.5 font-medium", valid.length ? "text-success" : "text-muted-foreground")}>
            <CheckCircle2 className="h-4 w-4" />
            <span>
              <span className="tabular-nums">{valid.length}</span> candidate{valid.length === 1 ? "" : "s"} ready
            </span>
          </span>
          {pasted ? (
            <span className="text-muted-foreground">
              <span className="tabular-nums">{pasted}</span> with pasted resume text
            </span>
          ) : null}
        </div>
      ) : null}

      {problems.length ? (
        <Notice
          tone="warning"
          title={
            <>
              <span className="tabular-nums">{problems.length}</span> row{problems.length === 1 ? "" : "s"} skipped
            </>
          }
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => setShowProblems((v) => !v)}>
              {showProblems ? "Hide" : "Show why"}
            </Button>
          }
        >
          These rows can&apos;t be screened as pasted. Fix them in the sheet and paste again.
        </Notice>
      ) : null}

      {showProblems && problems.length ? (
        <div className="overflow-hidden rounded-lg border">
          <Table containerClassName="max-h-56">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-16 text-right">Row</TableHead>
                <TableHead>Problem</TableHead>
                <TableHead>Row content</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {problems.slice(0, 300).map((p) => (
                <TableRow key={p.row}>
                  <TableCell className="py-2 text-right tabular-nums text-muted-foreground">{p.row}</TableCell>
                  <TableCell className="py-2 text-warning">{p.problem}</TableCell>
                  <TableCell className="max-w-[280px] truncate py-2 text-muted-foreground" title={p.preview}>
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
