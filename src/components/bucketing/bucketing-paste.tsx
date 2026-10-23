"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, FileUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { Notice } from "@/components/ui/notice";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { TIER_LABEL, TIERS } from "@/lib/bucketing/config";
import {
  inspectInterviewExport,
  parseBucketingInput,
  readResumeSheet,
  type ExportCheck,
  type ParsedBucketingRow,
  type ResumeSheet,
} from "@/lib/bucketing/parse";
import { hireTrackBuckets, journeyClosed, tierOf, type BucketingCandidateInput } from "@/lib/bucketing/types";
import { cn } from "@/lib/utils";

export interface ParsedInput {
  /** Every usable row — with or without a resume link (a TR-2 hire without one is placed by the interview alone). */
  candidates: BucketingCandidateInput[];
  /** The export's column check; null until something is loaded. */
  check: ExportCheck | null;
  /** Where the rows came from: the file name, or "pasted rows". */
  source: string;
}

export const EMPTY_INPUT: ParsedInput = { candidates: [], check: null, source: "" };

interface BucketingPasteProps {
  batch: number;
  /** Phones already in the run → their batch; those rows are skipped. Pass an empty map to read every row (a refresh). */
  existing: Map<string, number>;
  onParsed: (input: ParsedInput) => void;
  disabled?: boolean;
}

interface Loaded {
  name: string;
  text: string;
}

/**
 * The run's input: the drive's interview export — uploaded as CSV, or its rows
 * pasted from the sheet with the header row — read by column name (order never
 * matters), plus an optional resume sheet matched by phone. Shows which of the
 * export's columns were found, the priority mix that will run and every row that can't.
 */
export function BucketingPaste({ batch, existing, onParsed, disabled }: BucketingPasteProps) {
  const [text, setText] = React.useState("");
  const [file, setFile] = React.useState<Loaded | null>(null);
  const [resumeFile, setResumeFile] = React.useState<Loaded | null>(null);
  const [rows, setRows] = React.useState<ParsedBucketingRow[]>([]);
  const [check, setCheck] = React.useState<ExportCheck | null>(null);
  const [showProblems, setShowProblems] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const resumeRef = React.useRef<HTMLInputElement>(null);

  const resumes = React.useMemo<ResumeSheet | null>(() => (resumeFile ? readResumeSheet(resumeFile.text) : null), [resumeFile]);

  React.useEffect(() => {
    const t = setTimeout(() => {
      const src = file?.text ?? text;
      if (!src.trim()) {
        setRows([]);
        setCheck(null);
        onParsed(EMPTY_INPUT);
        return;
      }
      const csv = file ? !file.text.split(/\r?\n/, 1)[0].includes("\t") : undefined;
      const c = inspectInterviewExport(src, csv);
      const parsed = c.ok
        ? parseBucketingInput(src, {
            batch,
            existing,
            defaultStage: "ASSESSMENT",
            csv: csv ?? false,
            resumes: resumes?.links,
            requireExport: true,
          })
        : [];
      setCheck(c);
      setRows(parsed);
      onParsed({ candidates: parsed.flatMap((r) => (r.candidate ? [r.candidate] : [])), check: c, source: file?.name ?? "pasted rows" });
    }, 250);
    return () => clearTimeout(t);
    // onParsed is a setter from the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, file, batch, existing, resumes]);

  const valid = rows.flatMap((r) => (r.candidate ? [r.candidate] : []));
  const problems = rows.filter((r) => !r.candidate);
  const byTier = TIERS.map((t) => ({ t, n: valid.filter((c) => tierOf(c) === t).length })).filter((x) => x.n);
  const closed = valid.filter(journeyClosed).length;
  const open = valid.filter((c) => !journeyClosed(c));
  const withResume = open.filter((c) => c.resumeUrl).length;
  const noResume = open.filter((c) => !c.resumeUrl);
  const interviewOnly = noResume.filter((c) => hireTrackBuckets(c).length).length;
  const gaps = check?.groups.filter((g) => g.missing.length) ?? [];

  const pick = (ref: React.RefObject<HTMLInputElement>, set: (f: Loaded) => void, accept: string) => (
    <input
      ref={ref}
      type="file"
      accept={accept}
      className="hidden"
      onChange={async (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        set({ name: f.name, text: await f.text() });
        e.target.value = "";
      }}
    />
  );
  const chip = (f: Loaded, label: string, clear: () => void) => (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-secondary px-2 py-1 text-[13px]">
      <span className="truncate" title={f.name}>
        {f.name}
      </span>
      <button
        type="button"
        aria-label={label}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
        onClick={clear}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </span>
  );

  return (
    <div className="space-y-4">
      {/* 1. The interview export */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {pick(fileRef, setFile, ".csv,.tsv,.txt,text/csv,text/tab-separated-values")}
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => fileRef.current?.click()}>
            <FileUp className="h-4 w-4" /> Upload interview export
          </Button>
          {file ? chip(file, "Remove the interview export", () => setFile(null)) : <span className="text-[13px] text-muted-foreground">or paste its rows below</span>}
          <InfoHint label="The interview export" align="start">
            <span className="block">The drive&apos;s export (candidates_all-colleges_….csv), read by column name — the order of the columns never matters.</span>
            <span className="mt-1 block">
              Used: phone, id, name, email, college · TR2 &lt;track&gt; State / Verdict · combinedInterview… · tr1Status and the tr1… ratings ·
              dsaInterviewQualifyingStatus and the DSA-interview scores · offlineOverallScore, dsaCodingScore, csFundamentalsScore, sqlMcqScore,
              sqlCodingScore · currentStage, journeyStatus.
            </span>
          </InfoHint>
        </div>
        {!file ? (
          <Textarea
            aria-label="Interview export rows"
            className="min-h-[150px] text-[13px]"
            value={text}
            disabled={disabled}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            placeholder={"Paste the interview export's rows here — copy them from the sheet together with the header row:\nid  name  email  phone  college  event  currentStage  …  TR2 python fullstack Verdict  …"}
          />
        ) : null}
        {check && !check.ok ? <Notice tone="danger">{check.error}</Notice> : null}
        {check?.ok ? (
          <div className="flex flex-wrap gap-1.5" aria-label="Columns found">
            {check.groups.map((g) => (
              <span
                key={g.label}
                title={g.missing.length ? `Missing: ${g.missing.join(", ")}` : "All columns found"}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs tabular-nums",
                  g.missing.length ? "border-transparent bg-warning-soft text-warning" : "text-muted-foreground",
                )}
              >
                {g.missing.length ? <AlertTriangle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3 text-success" />}
                {g.label} {g.found}/{g.total}
              </span>
            ))}
          </div>
        ) : null}
        {gaps.length ? (
          <p className="text-xs text-warning">
            Missing columns are read as empty: {gaps.flatMap((g) => g.missing).slice(0, 8).join(", ")}
            {gaps.flatMap((g) => g.missing).length > 8 ? " …" : ""}
          </p>
        ) : null}
      </div>

      {/* 2. The resume sheet */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {pick(resumeRef, setResumeFile, ".csv,.tsv,.txt,text/csv,text/tab-separated-values")}
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => resumeRef.current?.click()}>
            <FileUp className="h-4 w-4" /> Add resume sheet
          </Button>
          {resumeFile ? (
            chip(resumeFile, "Remove the resume sheet", () => setResumeFile(null))
          ) : (
            <span className="text-[13px] text-muted-foreground">Optional — Phone Number + Resume Link (e.g. the PII sheet), matched by phone.</span>
          )}
        </div>
        {resumes?.error ? <Notice tone="danger">{resumes.error}</Notice> : null}
        {resumes && !resumes.error ? (
          <p className="text-xs text-muted-foreground tabular-nums">
            {resumes.links.size} resume links read{valid.length ? ` · ${valid.filter((c) => resumes.links.has(c.id)).length} of ${valid.length} candidates matched` : ""}
          </p>
        ) : null}
      </div>

      {/* 3. What will run */}
      {rows.length ? (
        <div className="space-y-2 text-[13px]">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1.5 font-medium text-success">
              <CheckCircle2 className="h-4 w-4" /> <span className="tabular-nums">{valid.length}</span> candidate{valid.length === 1 ? "" : "s"} ready
            </span>
            {byTier.map(({ t, n }) => (
              <span key={t} className="text-muted-foreground">
                {TIER_LABEL[t]}: <span className="font-medium tabular-nums text-foreground">{n}</span>
              </span>
            ))}
          </div>
          <p className="text-muted-foreground tabular-nums">
            {withResume} of {open.length} have a resume link.
            {interviewOnly ? ` ${interviewOnly} TR-2 hire(s) without one are placed by the interview alone and flagged.` : ""}
            {noResume.length - interviewOnly ? ` ${noResume.length - interviewOnly} other(s) are listed as "No resume link".` : ""}
            {closed ? ` ${closed} with a closed journey are listed as not bucketed, without any checks.` : ""}
          </p>
          {!resumeFile && noResume.length > interviewOnly ? (
            <Notice tone="warning" title="No resume sheet added">
              The export has no resume column, so without the resume sheet only the {interviewOnly} TR-2 track hire(s) can be bucketed (on the
              interview alone). The other {noResume.length - interviewOnly} — TR-1, Assessment, combined-interview and Product hires — need a
              resume: add the sheet with Phone Number + Resume Link (e.g. the PII sheet) before running.
            </Notice>
          ) : null}
          {problems.length ? (
            <button
              type="button"
              aria-expanded={showProblems}
              className="inline-flex items-center gap-1.5 rounded text-warning hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
              onClick={() => setShowProblems((v) => !v)}
            >
              <AlertTriangle className="h-4 w-4" /> {problems.length} row(s) skipped · {showProblems ? "hide" : "show why"}
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
              {problems.slice(0, 300).map((p) => (
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
