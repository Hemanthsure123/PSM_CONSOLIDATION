"use client";

import * as React from "react";
import {
  AlertTriangle,
  Briefcase,
  CheckCircle2,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  FolderGit2,
  Github,
  Globe,
  Loader2,
  Play,
  ShieldCheck,
  Square,
  Table2,
  Trophy,
  Users,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/select";
import { badgeVariants } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { Field } from "@/components/ui/field";
import { SettingList, SettingRow } from "@/components/ui/setting-row";
import { Segmented } from "@/components/ui/segmented";
import { Disclosure } from "@/components/ui/disclosure";
import { Notice } from "@/components/ui/notice";
import { Progress } from "@/components/ui/progress";
import { Stat, StatGrid } from "@/components/ui/stat";
import { ActionBar } from "@/components/ui/action-bar";
import { useReportBusy } from "@/components/busy-context";
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
  // Leaving from the sidebar mid-run asks first.
  useReportBusy(running);

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

  // Presentation only: what the action bar says and which button is the primary one.
  const selectedRows = selected.reduce((sum, s) => sum + s.rowCount, 0);
  const strictLinks = [priorities.live ? "live demo" : "", priorities.github ? "GitHub" : ""].filter(Boolean).join(" and ") || "selected";

  return (
    <div className="max-w-3xl space-y-6">
      {/* 1 — source sheet */}
      <Panel
        icon={<FileSpreadsheet />}
        title="Resume source"
        description="Any Google Sheet with a column of resume links: a placement drive sheet, a batch roster, anything."
      >
        <div className="grid gap-5">
          <Field label="Google Sheet URL" htmlFor="proj-url">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="proj-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/…"
              />
              <Button
                onClick={fetchTabs}
                disabled={!url.trim() || fetching}
                variant={subs.length ? "outline" : "default"}
                className="shrink-0"
              >
                {fetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Table2 className="h-4 w-4" />}
                {fetching ? "Reading…" : "Load tabs"}
              </Button>
            </div>
          </Field>
          {sheetTitle ? (
            <p className="-mt-2 flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
              <span className="min-w-0">
                Loaded <strong className="font-medium text-foreground">{sheetTitle}</strong>,{" "}
                <span className="tabular-nums">{subs.length}</span> tab{subs.length === 1 ? "" : "s"}
              </span>
            </p>
          ) : null}
          <Field label="Report name" htmlFor="proj-run-name" hint="Filled in from the sheet's title if left empty.">
            <Input
              id="proj-run-name"
              value={runName}
              onChange={(e) => setRunName(e.target.value)}
              placeholder="e.g. GenAI showcase — Batch 12"
            />
          </Field>
        </div>
      </Panel>

      {/* 2 — tabs + column mapping */}
      {subs.length ? (
        <Panel
          icon={<Table2 />}
          title="Tabs to scan"
          description="Turn on the tabs to read. Only the resume link column is required."
        >
          <SettingList>
            {subs.map((s, i) => (
              <SettingRow
                key={s.name}
                id={`proj-tab-${i}`}
                title={
                  <span className="inline-flex flex-wrap items-center gap-2">
                    {s.name}
                    <span className={cn(badgeVariants({ variant: "secondary" }), "tabular-nums")}>{s.rowCount} rows</span>
                  </span>
                }
                description={
                  s.selected && !s.resumeColumn ? (
                    <span className="text-destructive">No resume column found. Pick one below.</span>
                  ) : undefined
                }
                checked={s.selected}
                onCheckedChange={(v) => update(s.name, { selected: v })}
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  {([
                    ["resumeColumn", "Resume link", false],
                    ["nameColumn", "Candidate name", true],
                    ["placedColumn", "Placed company", true],
                    ["ctcColumn", "CTC / pay scale", true],
                  ] as const).map(([key, label, optional]) => (
                    <Field key={key} label={label} optional={optional} htmlFor={`proj-tab-${i}-${key}`}>
                      <NativeSelect
                        id={`proj-tab-${i}-${key}`}
                        value={s[key]}
                        onChange={(e) => update(s.name, { [key]: e.target.value } as Partial<SubConfig>)}
                      >
                        <option value="">None</option>
                        {s.headers.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                  ))}
                </div>
              </SettingRow>
            ))}
          </SettingList>
        </Panel>
      ) : null}

      {/* 3 — the brief */}
      {subs.length ? (
        <Panel
          icon={<FolderGit2 />}
          title="What makes a project worth showcasing?"
          description="Projects must match this brief and stand on their own engineering merit."
        >
          <div className="grid gap-5">
            <Field
              label="Brief"
              htmlFor="proj-brief"
              info="Every project found is scored against this brief and on its own engineering merit. Only projects clearing both bars make the shortlist."
            >
              <Textarea
                id="proj-brief"
                rows={3}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="e.g. Generative AI projects — LLM apps, RAG pipelines, agents or fine-tuning. Prefer deployed work with real users or measurable impact."
              />
            </Field>
            <Field label="Shortlist size">
              <div>
                <Segmented
                  ariaLabel="Shortlist size"
                  value={topN}
                  onChange={setTopN}
                  options={TOP_N_CHOICES.map((n) => ({ value: n, label: `Top ${n}` }))}
                />
              </div>
            </Field>
          </div>
        </Panel>
      ) : null}

      {/* 4 — prioritisation: float the strongest proof to the top */}
      {subs.length ? (
        <Panel
          icon={<ShieldCheck />}
          title="Prioritise the strongest proof"
          description="Projects are ranked on merit first; these push the ones with real proof to the top."
        >
          <SettingList>
            <SettingRow
              id="proj-pri-live"
              icon={<Globe />}
              title="Live demo"
              description="Projects with a working demo rank higher."
              checked={priorities.live}
              onCheckedChange={(v) => setPriority("live", v)}
            />
            <SettingRow
              id="proj-pri-github"
              icon={<Github />}
              title="GitHub repo"
              description="Projects with a public repo rank higher."
              checked={priorities.github}
              onCheckedChange={(v) => setPriority("github", v)}
            />
            <SettingRow
              id="proj-pri-placed"
              icon={<Briefcase />}
              title="Placed candidates"
              description="Projects by candidates who were placed rank higher."
              checked={priorities.placed}
              onCheckedChange={(v) => setPriority("placed", v)}
            />
            <SettingRow
              id="proj-strict"
              icon={<ShieldCheck />}
              title="Strict: links required"
              description={`Only include projects that have the ${strictLinks} link${priorities.live && priorities.github ? "s" : ""}.`}
              info="Off: everything strong is kept, and projects with links just rank higher. Placement is never required, only ever a boost. Needs Live demo or GitHub repo turned on."
              checked={priorities.strict}
              disabled={!priorities.live && !priorities.github}
              onCheckedChange={(v) => setPriority("strict", v)}
            />
          </SettingList>
        </Panel>
      ) : null}

      {/* 5 — what the report may show */}
      {subs.length ? (
        <Panel icon={<Users />} title="Privacy">
          <SettingRow
            id="proj-attrib"
            title="Include candidate names and resume links"
            description="Keep this off when sharing the report with a batch. Turn it on only for internal use."
            info="A resume carries the candidate's phone number and email."
            checked={showCandidates}
            onCheckedChange={setShowCandidates}
          >
            <Notice tone="warning">
              The report will contain other people&apos;s names and resume links. Don&apos;t circulate it outside the team.
            </Notice>
          </SettingRow>
        </Panel>
      ) : null}

      {/* 6 — result */}
      {result ? (
        <section aria-label="Projects report" className="space-y-4">
          <StatGrid cols={4}>
            <Stat icon={<Trophy />} label="Shortlisted" value={result.shortlisted} tone="highlight" />
            <Stat icon={<FolderGit2 />} label="Projects found" value={result.considered} />
            <Stat icon={<FileText />} label="Resumes scanned" value={progress.done} hint={`of ${progress.total}`} />
            <Stat
              icon={<AlertTriangle />}
              label="Resumes skipped"
              value={skipped.length}
              tone={skipped.length ? "warning" : "default"}
            />
          </StatGrid>
          <Panel
            icon={<CheckCircle2 />}
            title="Projects report"
            description={`Shortlisted ${result.shortlisted} of ${result.considered} projects found across ${progress.total} resume${progress.total === 1 ? "" : "s"}.`}
            actions={
              <a href={result.link} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "default" })}>
                <ExternalLink className="h-4 w-4" /> Open the projects report
              </a>
            }
          >
            {result.droppedByStrict > 0 || result.storage === "local" || result.shortlisted === 0 ? (
              <div className="space-y-3">
                {result.droppedByStrict > 0 ? (
                  <p className="text-[13px] text-muted-foreground">
                    Strict mode excluded <span className="tabular-nums">{result.droppedByStrict}</span> otherwise-strong
                    project{result.droppedByStrict === 1 ? "" : "s"} that lacked the required link
                    {priorities.live && priorities.github ? "s" : ""}.
                  </p>
                ) : null}
                {result.storage === "local" ? (
                  <Notice tone="info">Saved locally (Drive storage quota unavailable), served by this app.</Notice>
                ) : null}
                {result.shortlisted === 0 ? (
                  <Notice tone="warning">Nothing cleared the quality bar for this brief. Try widening the wording.</Notice>
                ) : null}
              </div>
            ) : null}
          </Panel>
        </section>
      ) : null}

      {skipped.length ? (
        <Disclosure
          title={`${skipped.length} resume${skipped.length === 1 ? "" : "s"} skipped`}
          summary={skipped.length > 15 ? "First 15 shown" : undefined}
        >
          <ul className="list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-muted-foreground">
            {skipped.slice(0, 15).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </Disclosure>
      ) : null}

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {/* 7 — run */}
      {subs.length ? (
        <ActionBar
          status={
            running ? (
              <div className="space-y-2">
                {progress.total ? (
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span>
                      Scanning <span className="font-medium tabular-nums text-foreground">{progress.done}</span> of{" "}
                      <span className="tabular-nums">{progress.total}</span> resumes
                    </span>
                    <span>
                      <span className="tabular-nums">{progress.found}</span> project{progress.found === 1 ? "" : "s"} found so far
                    </span>
                  </div>
                ) : (
                  <span>Reading the selected tabs…</span>
                )}
                <Progress value={progress.done} max={progress.total} label="Scanning resumes" />
              </div>
            ) : !canRun && subs.some((s) => s.selected) && !brief.trim() ? (
              "Describe the projects you want first."
            ) : !selected.length ? (
              "Turn on at least one tab with a resume column."
            ) : (
              <>
                Ready to scan <span className="tabular-nums">{selected.length}</span> tab{selected.length === 1 ? "" : "s"} (
                <span className="tabular-nums">{selectedRows}</span> rows).
              </>
            )
          }
        >
          {running ? (
            <Button variant="outline" onClick={() => (abortRef.current = true)}>
              <Square className="h-4 w-4" /> Stop
            </Button>
          ) : null}
          <Button
            size="lg"
            className="h-auto min-h-11 whitespace-normal py-2 text-left"
            onClick={run}
            disabled={!canRun}
            variant={result && !running ? "outline" : "default"}
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? `Scanning ${progress.done}/${progress.total}…` : `Build top ${topN} projects report`}
          </Button>
        </ActionBar>
      ) : null}
    </div>
  );
}
