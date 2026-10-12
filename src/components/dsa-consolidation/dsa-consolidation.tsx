"use client";

import * as React from "react";
import {
  CheckCircle2,
  Code2,
  FileSpreadsheet,
  Home,
  Link2,
  Loader2,
  Play,
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
import { resolveDsaBatch } from "@/actions/dsa";
import { saveDsaRun, newDsaId } from "@/lib/dsa-store";
import { DsaResultsView } from "@/components/dsa-consolidation/dsa-results-view";
import { EMPTY_PLATFORM, type DsaCandidateInput, type DsaResult } from "@/lib/dsa-types";

interface DsaConsolidationProps {
  onDone: () => void;
}

interface SubConfig {
  name: string;
  headers: string[];
  rowCount: number;
  selected: boolean;
  mobileColumn: string;
  resumeColumn: string;
  leetcodeColumn: string;
  codeforcesColumn: string;
  codechefColumn: string;
}

/** How many candidates per server round-trip (server resolves them concurrently). */
const BATCH = 8;

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
    mobileColumn: findHeader(headers, ["mobile", "phone", "contact", "whatsapp"]),
    resumeColumn: findHeader(headers, ["resume", "cv", "biodata"]),
    leetcodeColumn: findHeader(headers, ["leetcode", "leet code"]),
    codeforcesColumn: findHeader(headers, ["codeforces", "code forces", "cf handle", "cf profile"]),
    codechefColumn: findHeader(headers, ["codechef", "code chef", "cc handle", "cc profile"]),
  };
}

export function DsaConsolidation({ onDone }: DsaConsolidationProps) {
  const [runName, setRunName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [sheetTitle, setSheetTitle] = React.useState("");
  const [subs, setSubs] = React.useState<SubConfig[]>([]);
  const [fetching, setFetching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [running, setRunning] = React.useState(false);
  const [finished, setFinished] = React.useState(false);
  const [results, setResults] = React.useState<DsaResult[]>([]);
  const [progress, setProgress] = React.useState({ done: 0, total: 0 });
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

  const selected = subs.filter((s) => s.selected && (s.mobileColumn || s.resumeColumn));
  const canRun = runName.trim().length > 0 && selected.length > 0 && !running;

  const run = async () => {
    setError(null);
    setRunning(true);
    setFinished(false);
    setResults([]);
    abortRef.current = false;

    // One id for the whole run: progress is saved after every batch, so a
    // refresh or a closed tab mid-run still leaves the finished rows on the dashboard.
    const runId = newDsaId();
    const createdAt = new Date().toISOString();
    const save = (rows: DsaResult[], complete: boolean) =>
      saveDsaRun({
        id: runId,
        name: runName.trim(),
        sheetTitle: sheetTitle || "Company sheet",
        createdAt,
        subsheets: selected.map((s) => s.name),
        total: rows.length,
        results: rows,
        complete,
      });

    try {
      // 1. Read every selected subsheet and build the candidate inputs.
      const inputs: DsaCandidateInput[] = [];
      for (const cfg of selected) {
        const res = await readSubsheet(url, cfg.name);
        if (!res.ok) {
          setError(res.error);
          setRunning(false);
          return;
        }
        res.data.rows.forEach((row, i) => {
          const mobile = (row[cfg.mobileColumn] ?? "").trim();
          const resumeUrl = (row[cfg.resumeColumn] ?? "").trim();
          const leetcodeUrl = cfg.leetcodeColumn ? (row[cfg.leetcodeColumn] ?? "").trim() : "";
          const codeforcesUrl = cfg.codeforcesColumn ? (row[cfg.codeforcesColumn] ?? "").trim() : "";
          const codechefUrl = cfg.codechefColumn ? (row[cfg.codechefColumn] ?? "").trim() : "";
          if (!mobile && !resumeUrl && !leetcodeUrl && !codeforcesUrl && !codechefUrl) return; // nothing to work with
          inputs.push({
            // Row-unique id: the same mobile can appear in two subsheets.
            id: `${cfg.name}#${i}`,
            mobile,
            resumeUrl,
            leetcodeUrl,
            codeforcesUrl,
            codechefUrl,
          });
        });
      }

      setProgress({ done: 0, total: inputs.length });

      // 2. Resolve in batches; stream partial results into the table.
      const collected: DsaResult[] = [];
      for (let i = 0; i < inputs.length; i += BATCH) {
        if (abortRef.current) break;
        const batch = inputs.slice(i, i + BATCH);
        const res = await resolveDsaBatch(batch);
        if (res.ok) collected.push(...res.data);
        else {
          // A whole-batch failure still advances — record error rows.
          for (const c of batch) {
            collected.push({
              id: c.id,
              mobile: c.mobile,
              resumeUrl: c.resumeUrl,
              leetcode: { ...EMPTY_PLATFORM, note: res.error },
              codeforces: { ...EMPTY_PLATFORM, note: res.error },
              codechef: { ...EMPTY_PLATFORM, note: res.error },
              totalSolved: null,
              totalContests: null,
              status: "error",
              error: res.error,
            });
          }
        }
        setResults([...collected]);
        setProgress({ done: Math.min(i + BATCH, inputs.length), total: inputs.length });
        save(collected, false);
      }

      // 3. Final save — marked complete only when every candidate was processed.
      save(collected, collected.length === inputs.length);
      setFinished(true);
    } finally {
      setRunning(false);
    }
  };

  // Results / progress view (during and after the run).
  if (running || finished || results.length > 0) {
    const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <div className="space-y-4">
        {running ? (
          <Card>
            <CardContent className="space-y-2 py-4">
              <div className="flex items-center justify-between text-sm">
                <span className="inline-flex items-center gap-2 font-medium">
                  <Loader2 className="h-4 w-4 animate-spin" /> Resolving profiles &amp; reading solved, contests &amp; ratings…
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {progress.done}/{progress.total} ({pct}%)
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
              </div>
            </CardContent>
          </Card>
        ) : finished ? (
          <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            Done — saved to the dashboard. Download the CSV below or reopen it anytime.
          </p>
        ) : null}

        <DsaResultsView
          results={results}
          title={runName || "DSA Consolidation"}
          subtitle={`${sheetTitle}${selected.length ? " · " + selected.map((s) => s.name).join(", ") : ""}`}
          onBack={running ? undefined : onDone}
          backLabel="Done — back to dashboard"
          headerRight={
            running ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  abortRef.current = true;
                }}
              >
                <Square className="h-4 w-4" /> Stop
              </Button>
            ) : null
          }
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
              <Code2 className="h-4 w-4 text-muted-foreground" /> DSA Problems-Solved Consolidation
            </h2>
            <p className="text-sm text-muted-foreground">
              Pull each candidate&apos;s LeetCode, Codeforces &amp; CodeChef solved count, contests
              participated and rating — links from the sheet or their resume (incl. links hidden
              behind icons/text).
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileSpreadsheet className="h-4 w-4" /> Company sheet
          </CardTitle>
          <CardDescription>
            Paste the sheet link (must be shared with the service account). Resume files linked in
            it must be shared too, so they can be read.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="dsa-name">Run name</Label>
              <Input
                id="dsa-name"
                placeholder="e.g. Acme Corp — DSA"
                value={runName}
                onChange={(e) => setRunName(e.target.value)}
              />
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

          {error ? (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          ) : null}

          {subs.length > 0 ? (
            <span className="inline-flex items-center gap-2 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4" />
              {sheetTitle} · {subs.length} subsheet{subs.length === 1 ? "" : "s"} found.
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
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Mobile number column (uuid)">
                <SelectBox value={sub.mobileColumn} onChange={(v) => update(sub.name, { mobileColumn: v })} options={sub.headers} />
              </Field>
              <Field label="Resume link column">
                <SelectBox value={sub.resumeColumn} onChange={(v) => update(sub.name, { resumeColumn: v })} options={sub.headers} />
              </Field>
              <Field label="LeetCode link column (optional)">
                <SelectBox value={sub.leetcodeColumn} onChange={(v) => update(sub.name, { leetcodeColumn: v })} options={sub.headers} />
              </Field>
              <Field label="Codeforces link column (optional)">
                <SelectBox value={sub.codeforcesColumn} onChange={(v) => update(sub.name, { codeforcesColumn: v })} options={sub.headers} />
              </Field>
              <Field label="CodeChef link column (optional)">
                <SelectBox value={sub.codechefColumn} onChange={(v) => update(sub.name, { codechefColumn: v })} options={sub.headers} />
              </Field>
            </CardContent>
          ) : null}
        </Card>
      ))}

      {subs.length > 0 ? (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {selected.length > 0
              ? `${selected.length} subsheet${selected.length === 1 ? "" : "s"} selected. Links come from the columns above, else the resume.`
              : "Include at least one subsheet (map its Mobile or Resume column)."}
          </p>
          <Button size="lg" onClick={run} disabled={!canRun}>
            <Play className="h-4 w-4" /> Fetch DSA stats
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function SelectBox({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
    >
      <option value="">—</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
