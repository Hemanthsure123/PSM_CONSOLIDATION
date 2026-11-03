"use client";

import * as React from "react";
import { ExternalLink, FileUp, GraduationCap, RefreshCw, Upload, X } from "lucide-react";
import { cn, parseCsv } from "@/lib/utils";
import { useReportBusy } from "@/components/busy-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { Panel } from "@/components/ui/panel";
import { Progress } from "@/components/ui/progress";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ago } from "@/components/pool/eligible-pool";
import { fetchScoresSummary, syncScoresSheet, uploadScoresCsv } from "@/lib/pool/client";
import { ASSESSMENTS, assessmentInfo, isAssessmentKey, type ScoreImportResult, type ScoresSummary } from "@/lib/pool/scores/catalogue";
import { parseScores, type ParsedScores } from "@/lib/pool/scores/parse";

const fmt = (n: number) => n.toLocaleString("en-IN");

interface Picked {
  id: string;
  file: File;
  preview: ParsedScores;
  /** YYYY-MM-DD typed in for an offline exam without a date. */
  examDate: string;
  result?: ScoreImportResult;
}

function failed(label: string, error: string): ScoreImportResult {
  return {
    ok: false,
    importId: null,
    label,
    assessment: null,
    sourceKey: "",
    mode: "csv",
    rowsRead: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    skipped: [],
    people: 0,
    eligiblePeople: 0,
    peopleAdded: 0,
    profiles: 0,
    issues: [],
    error,
    ms: 0,
  };
}

/**
 * Eligible pool › Assessment marks — the final score of every assessment (offline exams, competency
 * interviews, Bucket A / B rounds) for the Standing lookup, for everyone the Academy assessed, with
 * how many of them are eligible for job opportunities (in the eligible pool). Import CSV exports
 * (each file is recognised from its headers and previewed before it is sent) or refetch the tabs
 * the service account can read. Each export replaces only its own scores.
 */
export function AssessmentScores() {
  const [summary, setSummary] = React.useState<ScoresSummary | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<Picked[]>([]);
  const [importing, setImporting] = React.useState<string | null>(null);
  const [syncing, setSyncing] = React.useState<string | null>(null);
  const [sheetResults, setSheetResults] = React.useState<Record<string, ScoreImportResult>>({});
  const fileRef = React.useRef<HTMLInputElement>(null);
  const busy = Boolean(importing || syncing);
  useReportBusy(busy);

  const load = React.useCallback(async () => {
    const res = await fetchScoresSummary();
    if (res.ok) {
      setSummary(res.data);
      setLoadError(null);
    } else setLoadError(res.error);
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);

  /** Read each chosen file in the browser and say what it is before anything is sent. */
  const choose = async (files: FileList | null) => {
    if (!files?.length) return;
    const next: Picked[] = [];
    for (const file of Array.from(files)) {
      const text = await file.text();
      const preview = parseScores(parseCsv(text), { fileName: file.name });
      next.push({ id: `${file.name}-${file.size}-${file.lastModified}`, file, preview, examDate: "" });
    }
    setPicked((prev) => [...prev.filter((p) => !next.some((n) => n.id === p.id)), ...next]);
    if (fileRef.current) fileRef.current.value = "";
  };

  const withDate = async (p: Picked, examDate: string) => {
    const text = await p.file.text();
    const preview = parseScores(parseCsv(text), { fileName: p.file.name, examDate });
    setPicked((xs) => xs.map((x) => (x.id === p.id ? { ...x, examDate, preview, result: undefined } : x)));
  };

  const importOne = async (p: Picked, allowShrink = false) => {
    setImporting(p.id);
    const res = await uploadScoresCsv(p.file, { examDate: p.examDate || undefined, allowShrink });
    const result = res.ok ? res.data : failed(p.preview.label || p.file.name, res.error);
    setPicked((xs) => xs.map((x) => (x.id === p.id ? { ...x, result } : x)));
    return result;
  };

  /** Import every ready file, one after another (each is its own short request). */
  const importAll = async () => {
    for (const p of picked.filter((x) => !x.preview.error && !x.result?.ok)) await importOne(p);
    setImporting(null);
    await load();
  };

  const confirmShrink = async (p: Picked) => {
    await importOne(p, true);
    setImporting(null);
    await load();
  };

  const refetch = async (ids: string[]) => {
    setSheetResults({});
    for (const id of ids) {
      setSyncing(id);
      const res = await syncScoresSheet(id);
      const result = res.ok ? res.data : failed(summary?.sheets.find((s) => s.id === id)?.label ?? id, res.error);
      setSheetResults((m) => ({ ...m, [id]: result }));
    }
    setSyncing(null);
    await load();
  };

  const ready = picked.filter((p) => !p.preview.error && !p.result?.ok);
  const totalScores = summary?.assessments.reduce((s, a) => s + a.scores, 0) ?? 0;

  return (
    <Panel
      icon={<GraduationCap />}
      title="Assessment marks"
      description="The final score of every Academy exam and interview — with its verdict, date and recording — for everyone assessed, tagged Eligible when they are in the eligible pool. Never section marks."
    >
      {loadError ? (
        <Notice tone="warning" className="mb-4" title="The marks couldn't be loaded">
          {loadError}
        </Notice>
      ) : null}

      {summary?.configured ? (
        <>
          <StatGrid cols={4}>
            <Stat label="People with marks" value={fmt(summary.people.total)} hint={`everyone assessed · ${fmt(totalScores)} final scores`} />
            <Stat
              label="Eligible for jobs"
              value={fmt(summary.people.eligible)}
              tone="success"
              hint={`${fmt(summary.people.eligibleAcademy)} Academy pool${
                summary.people.eligible > summary.people.eligibleAcademy ? ` + ${fmt(summary.people.eligible - summary.people.eligibleAcademy)} Edge` : ""
              }`}
            />
            <Stat label="Not eligible" value={fmt(summary.people.notEligible)} hint="assessed, not in the eligible pool" />
            <Stat label="With college / year" value={fmt(summary.people.withProfile)} hint={`${fmt(summary.colleges.length)} colleges`} />
          </StatGrid>

          <div className="mt-4 overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Assessment</TableHead>
                  <TableHead className="text-right">Out of</TableHead>
                  <TableHead className="text-right">People</TableHead>
                  <TableHead className="text-right">Eligible</TableHead>
                  <TableHead className="text-right">Scores</TableHead>
                  <TableHead className="text-right">Recordings</TableHead>
                  <TableHead className="text-right">Exports</TableHead>
                  <TableHead>Last import</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.assessments.map((a) => (
                  <TableRow key={a.key} className={cn(!a.scores && "text-muted-foreground")}>
                    <TableCell className="font-medium">{assessmentInfo(a.key).label}</TableCell>
                    <TableCell className="text-right tabular-nums">{assessmentInfo(a.key).max}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(a.people)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(a.eligible)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(a.scores)}</TableCell>
                    <TableCell className="text-right tabular-nums">{assessmentInfo(a.key).kind === "interview" ? fmt(a.recordings) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(a.sources)}</TableCell>
                    <TableCell className="whitespace-nowrap">{a.lastImportAt ? ago(a.lastImportAt) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      ) : summary && !summary.configured ? (
        <Notice tone="warning">The database isn&apos;t configured, so marks can&apos;t be stored.</Notice>
      ) : (
        <Progress label="Loading the assessment marks" />
      )}

      {/* CSV exports */}
      <div className="mt-5 rounded-lg border border-dashed p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-medium">Import CSV exports</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Offline exam results, Bucket A / B interview sheets, the old offline assessment — several at once. Each file is recognised from its
              headers; re-importing an export replaces its scores. Everyone assessed is kept; the eligible pool decides who is tagged Eligible.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <input ref={fileRef} type="file" accept=".csv,text/csv" multiple className="hidden" onChange={(e) => void choose(e.target.files)} />
            <Button variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
              <FileUp /> Choose CSVs
            </Button>
            <Button disabled={busy || !ready.length || ready.some((p) => p.preview.needsDate)} onClick={() => void importAll()}>
              <Upload /> {importing ? "Importing…" : `Import ${ready.length || ""}`.trim()}
            </Button>
          </div>
        </div>

        {picked.length ? (
          <ul className="mt-3 divide-y rounded-lg border bg-card">
            {picked.map((p) => {
              const r = p.result;
              const scores = p.preview.rows.length;
              const skipped = p.preview.skipped.reduce((s, x) => s + x.count, 0);
              return (
                <li key={p.id} className="grid gap-1.5 px-3.5 py-2.5 text-[13px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-medium" title={p.file.name}>
                      {p.preview.label || p.file.name}
                    </span>
                    <span className="flex items-center gap-2">
                      {importing === p.id ? <Badge variant="secondary">Importing…</Badge> : r ? <Badge variant={r.ok ? "success" : r.needsConfirm ? "warning" : "destructive"}>{r.ok ? "Imported" : r.needsConfirm ? "Needs a look" : "Failed"}</Badge> : null}
                      <button
                        type="button"
                        aria-label={`Remove ${p.file.name}`}
                        disabled={busy}
                        onClick={() => setPicked((xs) => xs.filter((x) => x.id !== p.id))}
                        className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground" title={p.file.name}>
                    {p.file.name}
                  </p>
                  {p.preview.needsDate ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-warning">The exam date isn&apos;t in the file or its name:</span>
                      <Input type="date" value={p.examDate} onChange={(e) => void withDate(p, e.target.value)} className="h-8 w-44" aria-label="Exam date" />
                    </div>
                  ) : p.preview.error ? (
                    <p className="text-xs text-destructive">{p.preview.error}</p>
                  ) : !r ? (
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {fmt(scores)} final scores of {fmt(p.preview.rowsRead)} rows
                      {skipped ? ` · ${fmt(skipped)} without one (${p.preview.skipped.map((s) => `${s.reason} ${fmt(s.count)}`).join(", ")})` : ""}
                      {p.preview.rows.some((x) => x.recordingUrl) ? ` · ${fmt(p.preview.rows.filter((x) => x.recordingUrl).length)} recordings` : ""}
                      {p.preview.issues.length ? ` · ${fmt(p.preview.issues.length)} rows need a look` : ""}
                    </p>
                  ) : r.ok ? (
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {fmt(r.inserted)} new · {fmt(r.updated)} updated · {fmt(r.unchanged)} unchanged{r.removed ? ` · ${fmt(r.removed)} removed` : ""}
                      {` · ${fmt(r.people)} people, ${fmt(r.eligiblePeople)} eligible`}
                      {r.peopleAdded ? ` · ${fmt(r.peopleAdded)} added` : ""}
                      {r.profiles ? ` · ${fmt(r.profiles)} profiles` : ""}
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className={r.needsConfirm ? "text-warning" : "text-destructive"}>{r.error}</span>
                      {r.needsConfirm ? (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void confirmShrink(p)}>
                          Replace anyway
                        </Button>
                      ) : null}
                    </div>
                  )}
                  {(r?.issues ?? p.preview.issues).length ? (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer">{fmt((r?.issues ?? p.preview.issues).length)} rows need a look</summary>
                      <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-auto pl-5">
                        {(r?.issues ?? p.preview.issues).slice(0, 100).map((i, k) => (
                          <li key={k}>
                            {i.row ? `Row ${i.row}: ` : ""}
                            {i.problem}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {/* Google Sheets tabs the service account can read */}
      {summary?.sheets.length ? (
        <div className="mt-5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] font-medium">Refetch from Google Sheets</p>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void refetch(summary.sheets.map((s) => s.id))}>
              <RefreshCw className={cn(syncing && "animate-spin motion-reduce:animate-none")} /> Refetch all
            </Button>
          </div>
          <ul className="divide-y rounded-lg border">
            {summary.sheets.map((s) => {
              const r = sheetResults[s.id];
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 text-[13px]">
                  <span className="min-w-0">
                    {s.label} ·{" "}
                    <a href={s.sheetUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      {s.tab} <ExternalLink className="h-3 w-3" />
                    </a>
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {syncing === s.id ? (
                      <span className="text-primary">Refetching…</span>
                    ) : r ? (
                      r.ok ? (
                        <span className="tabular-nums">
                          {fmt(r.inserted)} new · {fmt(r.updated)} updated · {fmt(r.unchanged)} unchanged{r.removed ? ` · ${fmt(r.removed)} removed` : ""}
                        </span>
                      ) : (
                        <span className="text-destructive">{r.error}</span>
                      )
                    ) : null}
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refetch([s.id])}>
                      <RefreshCw /> Refetch
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {summary?.recentImports.length ? (
        <Disclosure title="Import history" summary={`Last ${summary.recentImports.length}`} className="mt-5">
          <Table containerClassName="max-h-[360px]">
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Export</TableHead>
                <TableHead>From</TableHead>
                <TableHead className="text-right">New</TableHead>
                <TableHead className="text-right">Updated</TableHead>
                <TableHead className="text-right">Removed</TableHead>
                <TableHead className="text-right">People added</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.recentImports.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap" title={new Date(r.startedAt).toLocaleString("en-IN")}>
                    {ago(r.startedAt)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{isAssessmentKey(r.assessment) ? assessmentInfo(r.assessment).label : r.assessment} <span className="text-muted-foreground">{r.sourceKey.replace(/^[a-z_]+[@:]/, "")}</span></TableCell>
                  <TableCell className="max-w-[220px] truncate" title={r.sourceRef}>
                    {r.mode === "csv" ? r.sourceRef : "Sheet"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(r.inserted)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(r.updated)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(r.removed)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(r.peopleAdded)}</TableCell>
                  <TableCell>
                    <Badge variant={r.status === "succeeded" ? "success" : r.status === "failed" ? "destructive" : "secondary"} title={r.error ?? undefined}>
                      {r.status === "succeeded" ? "Done" : r.status === "failed" ? "Failed" : "Running"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Disclosure>
      ) : null}

      <p className="mt-4 text-xs text-muted-foreground">
        Recognised exports: {ASSESSMENTS.map((a) => a.label).join(", ")}. Command line: <code>npm run scores:import -- &lt;files&gt;</code> or <code>--sheets</code>.
      </p>
    </Panel>
  );
}
