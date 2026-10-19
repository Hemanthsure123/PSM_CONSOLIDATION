"use client";

import * as React from "react";
import { CheckCircle2, FileSpreadsheet, Link2, Loader2, Play, Square, Table2 } from "lucide-react";
import { useReportBusy } from "@/components/busy-context";
import { ActionBar } from "@/components/ui/action-bar";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { Panel } from "@/components/ui/panel";
import { Progress } from "@/components/ui/progress";
import { NativeSelect } from "@/components/ui/select";
import { SettingList, SettingRow } from "@/components/ui/setting-row";
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
      <div className="space-y-6">
        {finished && !running ? (
          <Notice tone="success" title="Done">
            Saved to the dashboard. Download the CSV below, or reopen the run from the dashboard any time.
          </Notice>
        ) : null}

        <DsaResultsView
          results={results}
          title={runName || "DSA Consolidation"}
          subtitle={`${sheetTitle}${selected.length ? " · " + selected.map((s) => s.name).join(", ") : ""}`}
          headerRight={
            running ? null : (
              <Button variant="outline" size="sm" onClick={onDone}>
                Done
              </Button>
            )
          }
        />

        {running ? (
          <ActionBar
            status={
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <span className="inline-flex items-center gap-2 font-medium text-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> Reading solved, contests and rating from each profile
                  </span>
                  <span className="tabular-nums">
                    {progress.total > 0 ? `${progress.done} of ${progress.total} candidates · ${pct}%` : "Reading the subsheets…"}
                  </span>
                </div>
                <Progress value={progress.done} max={progress.total} label="Reading DSA profiles" />
              </div>
            }
          >
            <Button
              variant="outline"
              onClick={() => {
                abortRef.current = true;
              }}
            >
              <Square className="h-4 w-4" /> Stop
            </Button>
          </ActionBar>
        ) : null}
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <Panel
        title="Company sheet"
        icon={<FileSpreadsheet />}
        description="The sheet, and the resume files it links, must be shared with the service account."
      >
        <div className="space-y-4">
          <Field
            label="Sheet link"
            htmlFor="dsa-url"
            info="Profile links come from the sheet's columns, or else from the resume (including links hidden behind icons or text)."
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  id="dsa-url"
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
              <Button variant="outline" onClick={fetchTabs} disabled={fetching || !url.trim()}>
                {fetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
                {fetching ? "Reading…" : "Load sheet"}
              </Button>
            </div>
          </Field>

          <Field label="Run name" htmlFor="dsa-name" hint="Filled in with the sheet's title if left empty.">
            <Input id="dsa-name" placeholder="e.g. Acme Corp — DSA" value={runName} onChange={(e) => setRunName(e.target.value)} />
          </Field>

          {error ? <Notice tone="danger">{error}</Notice> : null}

          {subs.length > 0 ? (
            <p className="inline-flex items-center gap-2 text-[13px] text-success">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              {sheetTitle} · {subs.length} subsheet{subs.length === 1 ? "" : "s"} found.
            </p>
          ) : null}
        </div>
      </Panel>

      {subs.length > 0 ? (
        <Panel title="Subsheets" description="Include the tabs to read, then check which column holds each link.">
          <SettingList>
            {subs.map((sub, i) => (
              <SettingRow
                key={sub.name}
                id={`dsa-sub-${i}`}
                icon={<Table2 />}
                title={sub.name}
                description={`${sub.rowCount} rows`}
                checked={sub.selected}
                onCheckedChange={(v) => update(sub.name, { selected: v })}
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Mobile number column" htmlFor={`dsa-sub-${i}-mobile`} info="The mobile number is the candidate's unique id.">
                    <ColumnSelect
                      id={`dsa-sub-${i}-mobile`}
                      value={sub.mobileColumn}
                      onChange={(v) => update(sub.name, { mobileColumn: v })}
                      options={sub.headers}
                    />
                  </Field>
                  <Field label="Resume link column" htmlFor={`dsa-sub-${i}-resume`}>
                    <ColumnSelect
                      id={`dsa-sub-${i}-resume`}
                      value={sub.resumeColumn}
                      onChange={(v) => update(sub.name, { resumeColumn: v })}
                      options={sub.headers}
                    />
                  </Field>
                  <Field label="LeetCode link column" optional htmlFor={`dsa-sub-${i}-leetcode`}>
                    <ColumnSelect
                      id={`dsa-sub-${i}-leetcode`}
                      value={sub.leetcodeColumn}
                      onChange={(v) => update(sub.name, { leetcodeColumn: v })}
                      options={sub.headers}
                    />
                  </Field>
                  <Field label="Codeforces link column" optional htmlFor={`dsa-sub-${i}-codeforces`}>
                    <ColumnSelect
                      id={`dsa-sub-${i}-codeforces`}
                      value={sub.codeforcesColumn}
                      onChange={(v) => update(sub.name, { codeforcesColumn: v })}
                      options={sub.headers}
                    />
                  </Field>
                  <Field label="CodeChef link column" optional htmlFor={`dsa-sub-${i}-codechef`}>
                    <ColumnSelect
                      id={`dsa-sub-${i}-codechef`}
                      value={sub.codechefColumn}
                      onChange={(v) => update(sub.name, { codechefColumn: v })}
                      options={sub.headers}
                    />
                  </Field>
                </div>
              </SettingRow>
            ))}
          </SettingList>
        </Panel>
      ) : null}

      <ActionBar
        status={
          subs.length === 0
            ? "Load a sheet to choose its subsheets."
            : selected.length === 0
              ? "Include at least one subsheet (map its Mobile or Resume column)."
              : !runName.trim()
                ? "Name the run to start."
                : `${selected.length} subsheet${selected.length === 1 ? "" : "s"} selected. Links come from the columns above, else the resume.`
        }
      >
        <Button size="lg" onClick={run} disabled={!canRun}>
          <Play className="h-4 w-4" /> Fetch DSA stats
        </Button>
      </ActionBar>
    </div>
  );
}

function ColumnSelect({
  id,
  value,
  onChange,
  options,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </NativeSelect>
  );
}
