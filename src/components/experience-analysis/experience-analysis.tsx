"use client";

import * as React from "react";
import { Briefcase, CheckCircle2, FileSpreadsheet, Home, Link2, Loader2, Play, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ExperienceResults } from "@/components/experience-analysis/experience-results";
import { listSubsheets, readSubsheet } from "@/actions/sheets";
import { getExperienceRun, newExperienceRunId, saveExperienceRun } from "@/lib/experience-store";
import type { ExperienceCandidateInput, ExperienceResult, ExperienceRun } from "@/lib/experience-types";
import { cn } from "@/lib/utils";

interface ExperienceAnalysisProps {
  /** Reopen a saved run; omit to start a new one. */
  runId?: string | null;
  onDone: () => void;
}

interface SubConfig {
  name: string;
  headers: string[];
  rowCount: number;
  selected: boolean;
  mobileColumn: string;
  resumeColumn: string;
  nameColumn: string;
}

function findHeader(headers: string[], include: string[], exclude: string[] = []): string {
  const lower = headers.map((h) => h.toLowerCase());
  for (let i = 0; i < lower.length; i++) {
    if (include.some((s) => lower[i].includes(s)) && !exclude.some((e) => lower[i].includes(e))) return headers[i];
  }
  return "";
}

function detectSub(name: string, headers: string[], rowCount: number): SubConfig {
  return {
    name,
    headers,
    rowCount,
    selected: false,
    mobileColumn: findHeader(headers, ["mobile", "phone", "contact", "whatsapp"]),
    resumeColumn: findHeader(headers, ["resume", "cv", "biodata"]),
    nameColumn: findHeader(headers, ["name"], ["college", "company", "file", "institute", "university", "user"]),
  };
}

const fieldClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

/**
 * Experience Analysis — reads every candidate's resume and lists each
 * internship / job with company, role, normalised duration, tech stack (or
 * context), exported in a fixed column order for Google Sheets filters.
 */
export function ExperienceAnalysis({ runId, onDone }: ExperienceAnalysisProps) {
  const [id, setId] = React.useState(() => runId || newExperienceRunId());
  const [createdAt, setCreatedAt] = React.useState(() => new Date().toISOString());
  const [stage, setStage] = React.useState<"setup" | "results">("setup");

  const [runName, setRunName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [sheetTitle, setSheetTitle] = React.useState("");
  const [subs, setSubs] = React.useState<SubConfig[]>([]);
  const [fetching, setFetching] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [concurrency, setConcurrency] = React.useState(4);

  const [candidates, setCandidates] = React.useState<ExperienceCandidateInput[]>([]);
  const [results, setResults] = React.useState<Record<string, ExperienceResult>>({});
  const [running, setRunning] = React.useState(false);
  const [active, setActive] = React.useState<string[]>([]);
  const [storageFull, setStorageFull] = React.useState(false);
  const [subsheetNames, setSubsheetNames] = React.useState<string[]>([]);
  const abortRef = React.useRef(false);

  // Reopen a saved run.
  React.useEffect(() => {
    if (!runId) return;
    const saved = getExperienceRun(runId);
    if (!saved) return;
    setId(saved.id);
    setCreatedAt(saved.createdAt);
    setRunName(saved.name);
    setSheetTitle(saved.sheetTitle);
    setSubsheetNames(saved.subsheets);
    setCandidates(saved.candidates);
    setResults(saved.results);
    setConcurrency(saved.concurrency || 4);
    setStage("results");
  }, [runId]);

  // The run loop outlives renders — it saves through a ref so it always writes
  // the latest run metadata (never a stale closure's).
  const meta = React.useRef({ id, runName, sheetTitle, subsheetNames, createdAt, concurrency });
  meta.current = { id, runName, sheetTitle, subsheetNames, createdAt, concurrency };

  const persist = React.useCallback(
    (over: Pick<ExperienceRun, "candidates" | "results"> & Partial<ExperienceRun>) => {
      const m = meta.current;
      const ok = saveExperienceRun({
        id: m.id,
        name: m.runName.trim() || m.sheetTitle || "Experience analysis",
        sheetTitle: m.sheetTitle,
        subsheets: m.subsheetNames,
        createdAt: m.createdAt,
        updatedAt: new Date().toISOString(),
        concurrency: m.concurrency,
        ...over,
      });
      setStorageFull(!ok);
    },
    [],
  );

  const update = (name: string, partial: Partial<SubConfig>) =>
    setSubs((prev) => prev.map((s) => (s.name === name ? { ...s, ...partial } : s)));

  const fetchTabs = async () => {
    setError("");
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

  /**
   * Analyse `targets` with a rolling window of `concurrency` requests: a new
   * resume starts the moment one finishes, and the run is saved after each.
   */
  const analyze = async (targets: ExperienceCandidateInput[], base: Record<string, ExperienceResult>, list: ExperienceCandidateInput[]) => {
    if (!targets.length) return;
    abortRef.current = false;
    setRunning(true);
    let current = { ...base };
    const queue = [...targets];
    const width = Math.min(8, Math.max(1, concurrency));

    const worker = async () => {
      while (queue.length && !abortRef.current) {
        const c = queue.shift()!;
        setActive((a) => [...a, c.id]);
        let result: ExperienceResult;
        try {
          const res = await fetch("/api/experience/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ candidate: c }),
          });
          const data = (await res.json().catch(() => ({}))) as { result?: ExperienceResult; error?: string };
          if (!res.ok || !data.result) throw new Error(data.error || `Server returned HTTP ${res.status}`);
          result = data.result;
        } catch (err) {
          result = {
            id: c.id,
            mobile: c.mobile,
            name: c.name,
            resumeUrl: c.resumeUrl,
            status: "error",
            error: err instanceof Error ? err.message : "Request failed — re-run this candidate.",
            entries: [],
            totalMonths: null,
            internshipMonths: null,
            model: "",
            durationMs: 0,
            analyzedAt: new Date().toISOString(),
          };
        }
        current = { ...current, [c.id]: result };
        setResults(current);
        persist({ candidates: list, results: current });
        setActive((a) => a.filter((x) => x !== c.id));
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(width, queue.length) }, worker));
    } finally {
      setActive([]);
      setRunning(false);
    }
  };

  const start = async () => {
    setError("");
    setLoading(true);
    try {
      const list: ExperienceCandidateInput[] = [];
      for (const cfg of selected) {
        const res = await readSubsheet(url, cfg.name);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        res.data.rows.forEach((row, i) => {
          const mobile = (row[cfg.mobileColumn] ?? "").trim();
          const resumeUrl = (row[cfg.resumeColumn] ?? "").trim();
          const name = cfg.nameColumn ? (row[cfg.nameColumn] ?? "").trim() : "";
          if (!mobile && !resumeUrl) return;
          // Row-unique id: the same mobile can appear in two subsheets.
          list.push({ id: `${cfg.name}#${i}`, mobile, name, resumeUrl });
        });
      }
      if (!list.length) {
        setError("No rows with a mobile number or resume link in the selected subsheets.");
        return;
      }
      const names = selected.map((s) => s.name);
      meta.current.subsheetNames = names;
      setSubsheetNames(names);
      setCandidates(list);
      setResults({});
      persist({ candidates: list, results: {} });
      setStage("results");
      void analyze(list, {}, list);
    } finally {
      setLoading(false);
    }
  };

  if (stage === "results") {
    return (
      <div className="space-y-4">
        {storageFull ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Browser storage is full, so this run is no longer being saved. Download the CSVs now, then delete older runs
            from the dashboard.
          </p>
        ) : null}
        <ExperienceResults
          title={runName || sheetTitle || "Experience analysis"}
          subtitle={`${sheetTitle}${subsheetNames.length ? ` · ${subsheetNames.join(", ")}` : ""}`}
          candidates={candidates}
          results={results}
          running={running}
          active={active}
          concurrency={concurrency}
          onRun={(targets) => analyze(targets, results, candidates)}
          onStop={() => (abortRef.current = true)}
          onBack={onDone}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="flex items-center gap-4 py-4">
          <Button variant="ghost" size="sm" onClick={onDone} className="shrink-0">
            <Home className="h-4 w-4" /> Dashboard
          </Button>
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Briefcase className="h-4 w-4 text-muted-foreground" /> Experience Analysis
            </h2>
            <p className="text-sm text-muted-foreground">
              Read every resume&apos;s internships &amp; jobs — company, role, duration in months, tech stack (or what
              they did) — in a fixed column format for Google Sheets filters.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileSpreadsheet className="h-4 w-4" /> Candidate sheet
          </CardTitle>
          <CardDescription>
            Paste the sheet link (shared with the service account). Resume files linked in it must be shared too.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ex-name">Run name</Label>
              <Input id="ex-name" placeholder="e.g. Acme — internship screen" value={runName} onChange={(e) => setRunName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ex-conc">Resumes read in parallel</Label>
              <select
                id="ex-conc"
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                className={fieldClass}
              >
                {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                  <option key={n} value={n}>
                    {n} at a time{n === 4 ? " (recommended)" : ""}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Link2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="https://docs.google.com/spreadsheets/d/…"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setSubs([]);
                  setSheetTitle("");
                }}
                onKeyDown={(e) => e.key === "Enter" && url.trim() && !fetching && fetchTabs()}
              />
            </div>
            <Button onClick={fetchTabs} disabled={fetching || !url.trim()}>
              {fetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
              {fetching ? "Reading…" : "Fetch Subsheets"}
            </Button>
          </div>
          {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
          {subs.length ? (
            <span className="inline-flex items-center gap-2 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4" /> {sheetTitle} · {subs.length} subsheet{subs.length === 1 ? "" : "s"} found.
            </span>
          ) : null}
        </CardContent>
      </Card>

      {subs.map((sub) => (
        <Card key={sub.name} className={cn(sub.selected && "border-primary/40")}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <Table2 className="h-4 w-4 text-muted-foreground" /> {sub.name}
                <Badge variant="secondary">{sub.rowCount} rows</Badge>
              </CardTitle>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">{sub.selected ? "Included" : "Excluded"}</span>
                <Switch checked={sub.selected} onCheckedChange={(v) => update(sub.name, { selected: v })} />
              </div>
            </div>
          </CardHeader>
          {sub.selected ? (
            <CardContent className="grid gap-4 sm:grid-cols-3">
              {(
                [
                  ["mobileColumn", "Mobile number column (uuid)"],
                  ["resumeColumn", "Resume link column (required)"],
                  ["nameColumn", "Name column (optional)"],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">{label}</Label>
                  <select value={sub[key]} onChange={(e) => update(sub.name, { [key]: e.target.value })} className={fieldClass}>
                    <option value="">—</option>
                    {sub.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </CardContent>
          ) : null}
        </Card>
      ))}

      {subs.length ? (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {selected.length
              ? `${selected.length} subsheet${selected.length === 1 ? "" : "s"} selected.`
              : "Include at least one subsheet and map its Resume link column."}
          </p>
          <Button size="lg" onClick={start} disabled={!selected.length || !runName.trim() || loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Analyse experience
          </Button>
        </div>
      ) : null}
    </div>
  );
}
