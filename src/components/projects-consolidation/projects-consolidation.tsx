"use client";

import * as React from "react";
import {
  AlertTriangle,
  Briefcase,
  CheckCircle2,
  ExternalLink,
  FileSpreadsheet,
  FolderGit2,
  Github,
  Globe,
  Home,
  Loader2,
  Play,
  ShieldCheck,
  Square,
  Table2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { listSubsheets, readSubsheet } from "@/actions/sheets";
import { extractCandidateProjects, buildProjectsReport } from "@/actions/projects";
import type { CandidateProject, ProjectPriorities, ProjectSourceRow } from "@/lib/types";

interface ProjectsConsolidationProps {
  onDone: () => void;
}

interface SubConfig {
  name: string;
  headers: string[];
  rowCount: number;
  selected: boolean;
  /** Header holding the resume link — the only truly required mapping. */
  resumeColumn: string;
  nameColumn: string;
  /** Header holding the company the candidate was placed in (optional). */
  placedColumn: string;
  /** Header holding the placement CTC / pay scale (optional). */
  ctcColumn: string;
}

const TOP_N_CHOICES = [5, 10, 15, 20];

function findHeader(headers: string[], include: string[], exclude: string[] = []): string {
  const lower = headers.map((h) => h.toLowerCase());
  for (let i = 0; i < lower.length; i++) {
    const h = lower[i];
    if (include.some((s) => h.includes(s)) && !exclude.some((e) => h.includes(e))) return headers[i];
  }
  return "";
}

function detectSub(name: string, headers: string[], rowCount: number): SubConfig {
  return {
    name,
    headers,
    rowCount,
    selected: false,
    resumeColumn: findHeader(headers, ["resume", "cv", "biodata"]),
    nameColumn: findHeader(headers, ["name"], ["college", "company", "project", "panel", "user"]),
    placedColumn: findHeader(headers, ["placed", "offer", "placement company", "company placed", "company"], ["ctc", "package"]),
    ctcColumn: findHeader(headers, ["ctc", "package", "salary", "lpa", "pay", "stipend"]),
  };
}

/**
 * Projects Consolidation — a standalone feature (not part of the company
 * consolidation wizard).
 *
 * Goal: mine every resume in a sheet for the strongest projects matching a
 * brief, and publish ONE ranked report. Its main use is showing an upcoming
 * batch what real-world projects actually look like, so the report defaults to
 * being shareable — candidate names and resume links are opt-in.
 */
export function ProjectsConsolidation({ onDone }: ProjectsConsolidationProps) {
  const [runName, setRunName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [sheetTitle, setSheetTitle] = React.useState("");
  const [subs, setSubs] = React.useState<SubConfig[]>([]);
  const [fetching, setFetching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [brief, setBrief] = React.useState("");
  const [topN, setTopN] = React.useState(10);
  const [showCandidates, setShowCandidates] = React.useState(false);
  const [priorities, setPriorities] = React.useState<ProjectPriorities>({
    live: true,
    github: true,
    placed: true,
    strict: false,
  });
  const setPriority = (key: keyof ProjectPriorities, value: boolean) =>
    setPriorities((prev) => ({ ...prev, [key]: value }));

  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState({ done: 0, total: 0, found: 0 });
  const [skipped, setSkipped] = React.useState<string[]>([]);
  const [result, setResult] = React.useState<{
    link: string;
    storage: "drive" | "local";
    shortlisted: number;
    considered: number;
    droppedByStrict: number;
  } | null>(null);
  const abortRef = React.useRef(false);

  const update = (name: string, partial: Partial<SubConfig>) =>
    setSubs((prev) => prev.map((s) => (s.name === name ? { ...s, ...partial } : s)));

  const fetchTabs = async () => {
    setError(null);
    setFetching(true);
    const res = await listSubsheets(url);
    setFetching(false);
    if (!res.ok) {
      setError(res.error);
      setSubs([]);
      setSheetTitle("");
      return;
    }
    setSheetTitle(res.data.title);
    const detected = res.data.subsheets.map((s) => detectSub(s.name, s.headers, s.rowCount));
    if (detected.length === 1) detected[0].selected = true;
    setSubs(detected);
    if (!runName.trim()) setRunName(res.data.title);
  };

  const selected = subs.filter((s) => s.selected && s.resumeColumn);
  const canRun = brief.trim().length > 0 && selected.length > 0 && !running;

  const run = async () => {
    setError(null);
    setRunning(true);
    setResult(null);
    setSkipped([]);
    abortRef.current = false;

    try {
      // 1. Read the selected subsheets into the minimal per-candidate shape.
      const rows: ProjectSourceRow[] = [];
      for (const cfg of selected) {
        const res = await readSubsheet(url, cfg.name);
        if (!res.ok) {
          setError(res.error);
          setRunning(false);
          return;
        }
        res.data.rows.forEach((row, i) => {
          const resumeUrl = (row[cfg.resumeColumn] ?? "").trim();
          if (!/^https?:\/\//i.test(resumeUrl)) return; // no resume, nothing to read
          rows.push({
            id: `${cfg.name}-${i}`,
            candidate: (row[cfg.nameColumn] ?? "").trim(),
            resumeUrl,
            placedCompany: (row[cfg.placedColumn] ?? "").trim(),
            ctc: (row[cfg.ctcColumn] ?? "").trim(),
          });
        });
      }

      if (rows.length === 0) {
        setError("No rows with a usable resume link were found in the selected tabs.");
        setRunning(false);
        return;
      }

      setProgress({ done: 0, total: rows.length, found: 0 });

      // 2. One resume at a time — each is an LLM call. A failure is recorded and
      //    the run continues, so one bad file never costs the whole scan.
      const collected: CandidateProject[] = [];
      const failures: string[] = [];
      let scanned = 0;
      for (let i = 0; i < rows.length; i++) {
        if (abortRef.current) break;
        const res = await extractCandidateProjects(rows[i], brief);
        if (res.ok) collected.push(...res.data);
        else failures.push(`${rows[i].candidate || rows[i].id}: ${res.error}`);
        scanned = i + 1;
        setProgress({ done: scanned, total: rows.length, found: collected.length });
        setSkipped([...failures]);
      }

      // 3. Rank the whole pool and publish one report. A stopped run still
      //    reports on what it actually read.
      const built = await buildProjectsReport(collected, {
        brief,
        topN,
        runName: runName.trim() || sheetTitle,
        resumesScanned: scanned,
        showCandidates,
        priorities,
      });
      if (built.ok) setResult(built.data);
      else setError(built.error);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Projects Consolidation</h2>
          <p className="text-sm text-muted-foreground">
            Mine every resume for the strongest projects matching your brief, and publish one
            ranked report.
          </p>
        </div>
        <Button variant="outline" onClick={onDone}>
          <Home className="h-4 w-4" /> Dashboard
        </Button>
      </div>

      {/* 1 — source sheet */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileSpreadsheet className="h-4 w-4" /> Resume source
          </CardTitle>
          <CardDescription>
            Any Google Sheet with a column of resume links — a placement drive sheet, a batch
            roster, anything.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="proj-run-name">Report name</Label>
            <Input
              id="proj-run-name"
              value={runName}
              onChange={(e) => setRunName(e.target.value)}
              placeholder="e.g. GenAI showcase — Batch 12"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="proj-url">Google Sheet URL</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="proj-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/…"
              />
              <Button onClick={fetchTabs} disabled={!url.trim() || fetching} variant="secondary">
                {fetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Table2 className="h-4 w-4" />}
                {fetching ? "Reading…" : "Load tabs"}
              </Button>
            </div>
          </div>
          {sheetTitle ? (
            <p className="text-sm text-muted-foreground">
              Loaded <strong>{sheetTitle}</strong> — {subs.length} tab{subs.length === 1 ? "" : "s"}
            </p>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>

      {/* 2 — tabs + column mapping */}
      {subs.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tabs to scan</CardTitle>
            <CardDescription>
              Only the <strong>Resume</strong> column is required. Name and college are used for
              attribution when you enable it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {subs.map((s) => (
              <div
                key={s.name}
                className={cn("rounded-lg border p-3 transition-colors", s.selected ? "border-primary bg-primary/5" : "")}
              >
                <label className="flex cursor-pointer items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {s.name}
                    <Badge variant="secondary">{s.rowCount} rows</Badge>
                    {s.selected && !s.resumeColumn ? (
                      <span className="text-xs font-normal text-destructive">no resume column found</span>
                    ) : null}
                  </span>
                  <Switch checked={s.selected} onCheckedChange={(v) => update(s.name, { selected: v })} />
                </label>

                {s.selected ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {([
                      ["resumeColumn", "Resume link *"],
                      ["nameColumn", "Candidate name"],
                      ["placedColumn", "Placed company"],
                      ["ctcColumn", "CTC / pay scale"],
                    ] as const).map(([key, label]) => (
                      <div key={key} className="grid gap-1.5">
                        <Label className="text-xs text-muted-foreground">{label}</Label>
                        <select
                          value={s[key]}
                          onChange={(e) => update(s.name, { [key]: e.target.value } as Partial<SubConfig>)}
                          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                        >
                          <option value="">— none —</option>
                          {s.headers.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {/* 3 — the brief */}
      {subs.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FolderGit2 className="h-4 w-4" /> What makes a project worth showcasing?
            </CardTitle>
            <CardDescription>
              Every project found is scored against this brief and on its own engineering merit —
              only projects clearing both bars make the shortlist.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <textarea
              rows={3}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="e.g. Generative AI projects — LLM apps, RAG pipelines, agents or fine-tuning. Prefer deployed work with real users or measurable impact."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Shortlist size
              </span>
              {TOP_N_CHOICES.map((n) => (
                <Button
                  key={n}
                  type="button"
                  size="sm"
                  variant={topN === n ? "default" : "outline"}
                  onClick={() => setTopN(n)}
                >
                  Top {n}
                </Button>
              ))}
            </div>

            {/* Prioritisation — float the strongest proof to the top. */}
            <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">Prioritise the strongest proof</p>
                <p className="text-xs text-muted-foreground">
                  All best projects are ranked on merit first; these push the ones carrying real
                  proof — a working demo, a public repo, a placed author — to the top.
                </p>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                {([
                  ["live", "Live demo", <Globe key="l" className="h-4 w-4" />],
                  ["github", "GitHub repo", <Github key="g" className="h-4 w-4" />],
                  ["placed", "Placed candidates", <Briefcase key="p" className="h-4 w-4" />],
                ] as const).map(([key, label, icon]) => {
                  const active = priorities[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setPriority(key, !active)}
                      className={cn(
                        "flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                        active ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-accent",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className={active ? "text-primary" : "text-muted-foreground"}>{icon}</span>
                        {label}
                      </span>
                      <Switch checked={active} onCheckedChange={(v) => setPriority(key, v)} />
                    </button>
                  );
                })}
              </div>

              <div
                className={cn(
                  "flex items-start justify-between gap-3 rounded-md border p-3",
                  !priorities.live && !priorities.github ? "opacity-50" : "",
                )}
              >
                <div className="space-y-0.5">
                  <Label htmlFor="proj-strict" className="flex items-center gap-2 text-sm">
                    <ShieldCheck className="h-4 w-4" /> Strict — links required
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Only include projects that actually have the{" "}
                    {[priorities.live ? "live demo" : "", priorities.github ? "GitHub" : ""]
                      .filter(Boolean)
                      .join(" and ") || "selected"}{" "}
                    link{priorities.live && priorities.github ? "s" : ""}. Off: everything strong is
                    kept, link-carrying projects just rank higher. (Placement is never required —
                    only ever a boost.)
                  </p>
                </div>
                <Switch
                  id="proj-strict"
                  checked={priorities.strict}
                  disabled={!priorities.live && !priorities.github}
                  onCheckedChange={(v) => setPriority("strict", v)}
                />
              </div>
            </div>

            <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="proj-attrib" className="text-sm">
                  Include candidate names &amp; resume links
                </Label>
                <p className="text-xs text-muted-foreground">
                  Keep this <strong>off</strong> when sharing the report with a batch — a resume
                  carries the candidate&apos;s phone number and email. Turn it on only for internal
                  use.
                </p>
              </div>
              <Switch id="proj-attrib" checked={showCandidates} onCheckedChange={setShowCandidates} />
            </div>

            {showCandidates ? (
              <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50/60 p-2.5 text-xs text-amber-900">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                The report will contain other people&apos;s names and resume links — don&apos;t
                circulate it outside the team.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* 4 — run */}
      {subs.length ? (
        <Card>
          <CardContent className="space-y-3 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={run} disabled={!canRun}>
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {running ? `Scanning ${progress.done}/${progress.total}…` : `Build top ${topN} projects report`}
              </Button>
              {running ? (
                <>
                  <Button variant="outline" onClick={() => (abortRef.current = true)}>
                    <Square className="h-4 w-4" /> Stop
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    {progress.found} project{progress.found === 1 ? "" : "s"} found so far
                  </span>
                </>
              ) : null}
            </div>

            {!canRun && !running && subs.some((s) => s.selected) && !brief.trim() ? (
              <p className="text-xs text-muted-foreground">Describe the projects you want first.</p>
            ) : null}

            {result ? (
              <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
                <p className="flex items-center gap-2 text-sm font-medium text-emerald-900">
                  <CheckCircle2 className="h-4 w-4" />
                  Shortlisted {result.shortlisted} of {result.considered} projects found across{" "}
                  {progress.total} resume{progress.total === 1 ? "" : "s"}
                </p>
                {result.droppedByStrict > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Strict mode excluded {result.droppedByStrict} otherwise-strong project
                    {result.droppedByStrict === 1 ? "" : "s"} that lacked the required link
                    {priorities.live && priorities.github ? "s" : ""}.
                  </p>
                ) : null}
                <a
                  href={result.link}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
                >
                  <ExternalLink className="h-4 w-4" /> Open the projects report
                </a>
                {result.storage === "local" ? (
                  <p className="text-xs text-amber-700">
                    Saved locally (Drive storage quota unavailable) — served by this app.
                  </p>
                ) : null}
                {result.shortlisted === 0 ? (
                  <p className="text-xs text-amber-700">
                    Nothing cleared the quality bar for this brief — try widening the wording.
                  </p>
                ) : null}
              </div>
            ) : null}

            {skipped.length ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">
                  {skipped.length} resume{skipped.length === 1 ? "" : "s"} skipped
                </summary>
                <ul className="mt-1 space-y-0.5 pl-4">
                  {skipped.slice(0, 15).map((s) => (
                    <li key={s} className="list-disc">
                      {s}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
