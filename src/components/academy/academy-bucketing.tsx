"use client";

import * as React from "react";
import { FileSpreadsheet, Layers, Loader2, Play, Users } from "lucide-react";
import { useReportBusy } from "@/components/busy-context";
import { ActionBar } from "@/components/ui/action-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Disclosure } from "@/components/ui/disclosure";
import { Field } from "@/components/ui/field";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { Panel } from "@/components/ui/panel";
import { NativeSelect } from "@/components/ui/select";
import { Stat, StatGrid } from "@/components/ui/stat";
import { AcNudgePanel, AcRulesCard, AcSignalsPanel } from "@/components/academy/academy-rules";
import { AC_CONCURRENCY_OPTIONS, AcademyResults } from "@/components/academy/academy-results";
import { previewAcademySheet, readAcademyTabs, type AcademySheetPreview } from "@/actions/academy";
import { runQueue } from "@/lib/parallel-queue";
import { buildDataset, pickCompetencyTabs, pickMasterTab, pickOldProcessTab } from "@/lib/academy/parse";
import { needsRead, rankAcademy, summarizeAcademy } from "@/lib/academy/scoring";
import { getAcRun, lastAcLinks, newAcRunId, rememberAcLinks, saveAcDataset, saveAcResult, saveAcRunMeta } from "@/lib/academy/store";
import { DEFAULT_AC_RULES, failedAcEvaluation, withDefaultRules, type AcCandidate, type AcDataset, type AcEvalRequest, type AcEvaluation, type AcRules, type AcRunMeta } from "@/lib/academy/types";

interface Props {
  /** Reopen a saved run; omit to start a new one. */
  runId?: string | null;
  onDone: () => void;
}

type SheetKey = "s1" | "s2" | "s3";
type Links = Record<SheetKey, string>;
interface Tabs {
  s1: string;
  s2: string[];
  s3: string;
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 30_000;
const NETWORK_RETRY_MS = 4_000;
const NETWORK_PREFIX = "Network error";
const UI_FLUSH_MS = 400;
const META_SAVE_MS = 3_000;
const DEFAULT_CONCURRENCY = 6;
const EMPTY_LINKS: Links = { s1: "", s2: "", s3: "" };

const SHEETS: { key: SheetKey; label: string; hint: string; placeholder: string }[] = [
  {
    key: "s1",
    label: "Sheet 1 — assessed pool",
    hint: "Eligibility, Active Pool, placement, preference and resume links are read from this sheet only.",
    placeholder: "Assessed Pool (Sahana Working New Criteria)",
  },
  { key: "s2", label: "Sheet 2 — competency interviews", hint: "Frontend / DSA / Backend / SE interview detail, joined by UID.", placeholder: "Post Offline Competency Interview Evaluation" },
  { key: "s3", label: "Sheet 3 — old process", hint: "Bucket A–D and the section scores, joined by UID (then mobile).", placeholder: "Offline Attended - Old Process" },
];

/** Read the three sheets (view only) and join them. Tabs are recognised unless chosen. */
async function loadSheets(
  links: Links,
  chosen: Partial<Tabs> = {},
): Promise<{ ok: true; dataset: AcDataset; previews: Partial<Record<SheetKey, AcademySheetPreview>>; tabs: Tabs } | { ok: false; error: string }> {
  const previews: Partial<Record<SheetKey, AcademySheetPreview>> = {};
  const keys = (["s1", "s2", "s3"] as SheetKey[]).filter((k) => links[k].trim());
  const res = await Promise.all(keys.map((k) => previewAcademySheet(links[k].trim())));
  for (let i = 0; i < keys.length; i++) {
    const r = res[i];
    if (!r.ok) return { ok: false, error: `${SHEETS.find((s) => s.key === keys[i])!.label}: ${r.error}` };
    previews[keys[i]] = r.data;
  }
  const tabsOf = (k: SheetKey) => previews[k]?.tabs ?? [];
  const tabs: Tabs = {
    s1: chosen.s1 && tabsOf("s1").some((t) => t.name === chosen.s1) ? chosen.s1 : pickMasterTab(tabsOf("s1")),
    s2: chosen.s2 ? chosen.s2.filter((n) => tabsOf("s2").some((t) => t.name === n)) : pickCompetencyTabs(tabsOf("s2")),
    s3: chosen.s3 !== undefined && (chosen.s3 === "" || tabsOf("s3").some((t) => t.name === chosen.s3)) ? chosen.s3 : pickOldProcessTab(tabsOf("s3")),
  };
  if (!tabs.s1) return { ok: false, error: "Sheet 1 has no tabs." };
  const [r1, r2, r3] = await Promise.all([
    readAcademyTabs(links.s1.trim(), [tabs.s1]),
    previews.s2 && tabs.s2.length ? readAcademyTabs(links.s2.trim(), tabs.s2) : Promise.resolve({ ok: true as const, data: { title: previews.s2?.title ?? "", grids: [] } }),
    previews.s3 && tabs.s3 ? readAcademyTabs(links.s3.trim(), [tabs.s3]) : Promise.resolve({ ok: true as const, data: { title: previews.s3?.title ?? "", grids: [] } }),
  ]);
  if (!r1.ok) return { ok: false, error: `Sheet 1: ${r1.error}` };
  if (!r2.ok) return { ok: false, error: `Sheet 2: ${r2.error}` };
  if (!r3.ok) return { ok: false, error: `Sheet 3: ${r3.error}` };
  const dataset = buildDataset({
    s1: { url: links.s1.trim(), title: r1.data.title, tab: r1.data.grids[0] },
    s2: { url: links.s2.trim(), title: r2.data.title, tabs: r2.data.grids },
    s3: { url: links.s3.trim(), title: r3.data.title, tab: r3.data.grids[0] ?? null },
  });
  if (!dataset.candidates.length) return { ok: false, error: `Sheet 1 › ${tabs.s1} has no candidate rows (no UID / email column found).` };
  return { ok: true, dataset, previews, tabs };
}

/**
 * Academy bucketing — sort the academy-assessed pool into Frontend, Backend,
 * AI-ML and Full Stack (Mixed when two are nearly equal) for mentor assignment.
 * Load the three sheets, check what was found, start; every in-scope resume is
 * read (with GitHub and coding profiles) and the buckets fill in as it goes.
 */
export function AcademyBucketing({ runId, onDone }: Props) {
  const [id] = React.useState(() => runId || newAcRunId());
  const [loading, setLoading] = React.useState(Boolean(runId));
  const [stage, setStage] = React.useState<"setup" | "results">("setup");
  const [name, setName] = React.useState("");
  const [createdAt, setCreatedAt] = React.useState(() => new Date().toISOString());
  const [links, setLinks] = React.useState<Links>(EMPTY_LINKS);
  const [tabs, setTabs] = React.useState<Tabs | null>(null);
  const [previews, setPreviews] = React.useState<Partial<Record<SheetKey, AcademySheetPreview>>>({});
  const [dataset, setDataset] = React.useState<AcDataset | null>(null);
  const [rules, setRules] = React.useState<AcRules>(DEFAULT_AC_RULES);
  const [concurrency, setConcurrency] = React.useState(DEFAULT_CONCURRENCY);
  const [results, setResults] = React.useState<Record<string, AcEvaluation>>({});
  const [running, setRunning] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [retrying, setRetrying] = React.useState(0);
  const [sheetsBusy, setSheetsBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [reloadError, setReloadError] = React.useState("");
  const [storageError, setStorageError] = React.useState("");
  useReportBusy(running);

  const resultsRef = React.useRef<Record<string, AcEvaluation>>({});
  const abortRef = React.useRef(false);
  const runningRef = React.useRef(false);
  const counters = React.useRef({ active: 0, retrying: 0 });
  const meta = React.useRef({ name, createdAt, rules, concurrency, dataset, links, tabs });
  meta.current = { name, createdAt, rules, concurrency, dataset, links, tabs };

  // New run: start from the links used last time.
  React.useEffect(() => {
    if (runId) return;
    const last = lastAcLinks();
    if (last) setLinks(last);
  }, [runId]);

  React.useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    getAcRun(runId)
      .then((saved) => {
        if (cancelled || !saved) return;
        const m = saved.meta;
        setName(m.name);
        setCreatedAt(m.createdAt);
        setRules(withDefaultRules(m.rules));
        setConcurrency(m.concurrency || DEFAULT_CONCURRENCY);
        resultsRef.current = saved.results;
        setResults(saved.results);
        if (saved.dataset) {
          setDataset(saved.dataset);
          const d = saved.dataset.sources;
          setLinks({ s1: d.s1.url, s2: d.s2.url, s3: d.s3.url });
          setTabs({ s1: d.s1.tabs[0] ?? "", s2: d.s2.tabs, s3: d.s3.tabs[0] ?? "" });
          setStage("results");
        } else {
          setError("This run's sheets were not saved — load them again.");
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not open the saved run."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const saveMeta = React.useCallback(async () => {
    const m = meta.current;
    if (!m.dataset) return;
    const rows = rankAcademy(m.dataset.candidates, resultsRef.current, m.rules);
    const s = summarizeAcademy(rows);
    const record: AcRunMeta = {
      id,
      name: m.name.trim() || "Academy bucketing",
      createdAt: m.createdAt,
      updatedAt: new Date().toISOString(),
      rules: m.rules,
      concurrency: m.concurrency,
      loadedAt: m.dataset.loadedAt,
      sheetTitle: m.dataset.sources.s1.title,
      stats: {
        candidates: s.candidates,
        inScope: s.inScope,
        evaluated: s.evaluated,
        toRead: needsRead(rows, m.rules).length,
        errors: s.errors,
        unreadable: s.unreadable,
        byPlacement: s.byPlacement,
        needsEvidence: s.needsEvidence,
        nudged: s.nudged,
        lowTrust: s.trust.Low,
      },
    };
    if (!(await saveAcRunMeta(record))) setStorageError("The browser refused to save this run (storage full or private mode). Download the workbook now.");
  }, [id]);

  const flushTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleFlush = React.useCallback(() => {
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      setResults({ ...resultsRef.current });
      setActive(counters.current.active);
      setRetrying(counters.current.retrying);
    }, UI_FLUSH_MS);
  }, []);

  const metaTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleMeta = React.useCallback(() => {
    if (metaTimer.current) return;
    metaTimer.current = setTimeout(() => {
      metaTimer.current = null;
      void saveMeta();
    }, META_SAVE_MS);
  }, [saveMeta]);

  const readOne = async (c: AcCandidate): Promise<AcEvaluation> => {
    const r = meta.current.rules;
    const req: AcEvalRequest = {
      id: c.id,
      name: c.name,
      email: c.email,
      mobile: c.mobile,
      resumeUrl: c.resumeUrl,
      github: r.signals.github,
      dsa: r.signals.dsa,
      trust: r.trust.enabled,
      // What the sheets say, for the trust agent to cross-check against the resume.
      context: { competencies: c.competencies.map((k) => ({ name: k.name, level: k.level, score: k.score })), interviews: c.interviews ?? [] },
    };
    try {
      const res = await fetch("/api/academy/evaluate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ candidate: req }) });
      const text = await res.text();
      let data: { result?: AcEvaluation; error?: string } = {};
      try {
        data = JSON.parse(text);
      } catch {
        return failedAcEvaluation(req, `${NETWORK_PREFIX}: unreadable reply from the server (HTTP ${res.status}) — re-run this candidate.`, true);
      }
      if (!res.ok || !data.result) return failedAcEvaluation(req, data.error || `Server returned HTTP ${res.status}`, res.status >= 500);
      return data.result;
    } catch (err) {
      return failedAcEvaluation(req, `${NETWORK_PREFIX}: ${err instanceof Error ? err.message : "request failed"} — re-run this candidate.`, true);
    }
  };

  /** Rolling window of `concurrency` reads; each result saved as it arrives; rate-limited ones retried later. */
  const read = React.useCallback(
    async (targets: AcCandidate[]) => {
      if (!targets.length || runningRef.current) return;
      runningRef.current = true;
      abortRef.current = false;
      setRunning(true);
      try {
        await runQueue({
          items: targets,
          concurrency: () => Math.min(12, Math.max(1, meta.current.concurrency)),
          run: readOne,
          retryAfter: (r, attempt) =>
            r.status === "error" && r.retryable && attempt <= MAX_RETRIES ? (r.error.startsWith(NETWORK_PREFIX) ? NETWORK_RETRY_MS : RETRY_DELAY_MS * attempt) : null,
          stopped: () => abortRef.current,
          onDone: (c, r) => {
            resultsRef.current[c.id] = r;
            void saveAcResult(id, r).then((ok) => {
              if (!ok) setStorageError("The browser refused to save results (storage full?). Download the workbook now.");
            });
            scheduleFlush();
            scheduleMeta();
          },
          onActivity: (run, wait) => {
            counters.current = { active: run, retrying: wait };
            scheduleFlush();
          },
        });
      } finally {
        counters.current = { active: 0, retrying: 0 };
        runningRef.current = false;
        setRunning(false);
        setActive(0);
        setRetrying(0);
        setResults({ ...resultsRef.current });
        void saveMeta();
      }
    },
    // readOne only uses stable values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, scheduleFlush, scheduleMeta, saveMeta],
  );

  const load = async (chosen: Partial<Tabs> = {}) => {
    setError("");
    if (!links.s1.trim()) {
      setError("Paste the sheet 1 link first.");
      return;
    }
    setSheetsBusy(true);
    try {
      const r = await loadSheets(links, chosen);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setDataset(r.dataset);
      setPreviews(r.previews);
      setTabs(r.tabs);
      rememberAcLinks(links);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the sheets.");
    } finally {
      setSheetsBusy(false);
    }
  };

  const reload = async () => {
    const m = meta.current;
    setReloadError("");
    setSheetsBusy(true);
    try {
      const r = await loadSheets(m.links, m.tabs ?? {});
      if (!r.ok) {
        setReloadError(`Sheets not reloaded — ${r.error}`);
        return;
      }
      meta.current = { ...meta.current, dataset: r.dataset };
      setDataset(r.dataset);
      setTabs(r.tabs);
      if (!(await saveAcDataset(id, r.dataset))) setStorageError("The browser refused to save the reloaded sheets (storage full?).");
      await saveMeta();
    } catch (err) {
      setReloadError(err instanceof Error ? err.message : "Could not reload the sheets.");
    } finally {
      setSheetsBusy(false);
    }
  };

  const start = async () => {
    if (!dataset) return;
    const now = new Date().toISOString();
    meta.current = { ...meta.current, createdAt: now };
    setCreatedAt(now);
    if (!(await saveAcDataset(id, dataset))) setStorageError("The browser refused to save the sheets (storage full or private mode). Download the workbook when done.");
    await saveMeta();
    setStage("results");
    const rows = rankAcademy(dataset.candidates, resultsRef.current, rules);
    void read(needsRead(rows, rules).map((r) => r.candidate));
  };

  const changeRules = (next: AcRules) => {
    meta.current = { ...meta.current, rules: next };
    setRules(next);
    scheduleMeta();
  };

  const changeConcurrency = (n: number) => {
    meta.current = { ...meta.current, concurrency: n };
    setConcurrency(n);
    scheduleMeta();
  };

  const preview = React.useMemo(() => {
    if (!dataset) return null;
    const rows = rankAcademy(dataset.candidates, {}, rules);
    const s = summarizeAcademy(rows);
    const scope = dataset.candidates.filter((c) => c.eligibility.eligible && c.activePool && (rules.includePlaced || c.placement !== "placed"));
    return {
      s,
      withResume: scope.filter((c) => c.resumeUrl).length,
      noResume: scope.filter((c) => !c.resumeUrl).length,
      s2: scope.filter((c) => c.s2Tabs.length).length,
      s3: scope.filter((c) => c.s3Match).length,
      toRead: needsRead(rows, rules).length,
    };
  }, [dataset, rules]);

  if (loading) {
    return (
      <div role="status" className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-primary" /> Opening the saved run…
      </div>
    );
  }

  if (stage === "results" && dataset) {
    return (
      <AcademyResults
        title={name || "Academy bucketing"}
        dataset={dataset}
        results={results}
        rules={rules}
        onRulesChange={changeRules}
        running={running}
        active={active}
        retrying={retrying}
        concurrency={concurrency}
        onConcurrencyChange={changeConcurrency}
        onRead={(targets) => void read(targets)}
        onStop={() => {
          abortRef.current = true;
        }}
        onReload={() => void reload()}
        reloading={sheetsBusy}
        reloadError={reloadError}
        storageError={storageError}
      />
    );
  }

  const setLink = (k: SheetKey, v: string) => {
    setLinks((l) => ({ ...l, [k]: v }));
    setDataset(null);
    setTabs(null);
  };

  return (
    <div className="max-w-3xl space-y-6">
      <Panel icon={<Layers />} title="Run" description="One run holds the whole pool. Reload the sheets any time from the results.">
        <Field label="Run name" htmlFor="ac-name">
          <Input id="ac-name" placeholder="e.g. Academy buckets — Oct 2026" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </Panel>

      <Panel
        icon={<FileSpreadsheet />}
        title="Sheets"
        description={
          <>
            Read only — nothing is written to the sheets.{" "}
            <InfoHint label="About the sheets" align="start">
              Share each sheet with the service account (Viewer). Tabs are recognised automatically: the &ldquo;Sahana Working New Criteria&rdquo;
              tab in sheet 1, every competency interview tab in sheet 2, the old-process tab (Bucket + overall_candidate_score) in sheet 3.
            </InfoHint>
          </>
        }
        footer={
          <>
            <span className="flex-1 text-[13px] text-muted-foreground">
              {dataset ? `Read ${dataset.candidates.length} candidates.` : "Sheets 2 and 3 are optional but add the interview and old-process detail."}
            </span>
            <Button variant="outline" onClick={() => void load(tabs ?? {})} disabled={sheetsBusy || !links.s1.trim()}>
              {sheetsBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />} {dataset ? "Load again" : "Load sheets"}
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          {SHEETS.map((s) => {
            const p = previews[s.key];
            return (
              <div key={s.key} className="space-y-2">
                <Field label={s.label} htmlFor={`ac-${s.key}`} hint={s.hint}>
                  <Input id={`ac-${s.key}`} placeholder={`Google Sheets link — ${s.placeholder}`} value={links[s.key]} onChange={(e) => setLink(s.key, e.target.value)} />
                </Field>
                {p && tabs && dataset ? (
                  s.key === "s2" ? (
                    <div className="space-y-1.5 rounded-lg border bg-muted/40 px-3 py-2.5 text-[13px]">
                      <p className="text-muted-foreground">
                        <span className="font-medium text-foreground">{p.title}</span> — competency tabs read:
                      </p>
                      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                        {p.tabs.map((t) => {
                          const on = tabs.s2.includes(t.name);
                          const fit = pickCompetencyTabs([t]).length > 0;
                          if (!fit && !on) return null;
                          return (
                            <label key={t.name} className="inline-flex items-center gap-2">
                              <Checkbox
                                checked={on}
                                disabled={sheetsBusy}
                                onCheckedChange={(v) => void load({ ...tabs, s2: v ? [...tabs.s2, t.name] : tabs.s2.filter((n) => n !== t.name) })}
                                aria-label={t.name}
                              />
                              {t.name}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-[13px]">
                      <span className="text-muted-foreground">
                        <span className="font-medium text-foreground">{p.title}</span> › tab
                      </span>
                      <NativeSelect
                        aria-label={`${s.label} tab`}
                        value={s.key === "s1" ? tabs.s1 : tabs.s3}
                        disabled={sheetsBusy}
                        onChange={(e) => void load({ ...tabs, [s.key]: e.target.value })}
                        className="h-8 text-[13px]"
                        wrapperClassName="min-w-0 max-w-full"
                      >
                        {s.key === "s3" ? <option value="">(none)</option> : null}
                        {p.tabs.map((t) => (
                          <option key={t.name} value={t.name}>
                            {t.name}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                  )
                ) : null}
              </div>
            );
          })}
        </div>
      </Panel>

      {error ? <Notice tone="danger">{error}</Notice> : null}
      {dataset?.warnings.map((w) => (
        <Notice key={w} tone="warning">
          {w}
        </Notice>
      ))}

      {dataset && preview ? (
        <Panel icon={<Users />} title="What was found" description="Eligibility from sheet 1: an L3 / L4 competency, DSA Offline cleared, or old Bucket A.">
          <StatGrid cols={4}>
            <Stat label="In sheet 1" value={preview.s.candidates} />
            <Stat label="Eligible" value={preview.s.eligible} />
            <Stat label="Eligible + Active Pool" value={preview.s.inScope} tone="highlight" hint={`P1 ${preview.s.p1} · P2 ${preview.s.p2}`} />
            <Stat label="Resumes to read" value={preview.toRead} hint={`${preview.noResume} without a resume`} />
          </StatGrid>
          <div className="mt-4 flex flex-wrap gap-1.5 text-[13px]">
            <Badge variant="secondary">Sheet 2 interviews for {preview.s2} of {preview.s.inScope}</Badge>
            <Badge variant="secondary">Sheet 3 old process for {preview.s3} of {preview.s.inScope}</Badge>
            <Badge variant="secondary">{dataset.columns.length} columns joined</Badge>
          </div>
        </Panel>
      ) : null}

      <AcSignalsPanel rules={rules} onChange={setRules} />
      <AcNudgePanel rules={rules} onChange={setRules} />
      <AcRulesCard rules={rules} onChange={setRules} />

      <Disclosure title="Advanced options" summary={`${concurrency} at a time`}>
        <Field label="Candidates read in parallel" htmlFor="ac-conc" info="Each read is the resume (one model call), GitHub and coding profiles. Rate-limited reads are retried automatically.">
          <NativeSelect id="ac-conc" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} wrapperClassName="sm:max-w-xs">
            {AC_CONCURRENCY_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} at a time{n === DEFAULT_CONCURRENCY ? " (recommended)" : ""}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </Disclosure>

      <ActionBar
        status={
          !dataset
            ? "Load the sheets to see the pool."
            : !name.trim()
              ? "Name the run to start."
              : `${preview?.s.inScope ?? 0} candidates in scope · ${preview?.toRead ?? 0} resumes to read.`
        }
      >
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button size="lg" onClick={() => void start()} disabled={!dataset || !name.trim() || sheetsBusy}>
          <Play className="h-4 w-4" /> Start bucketing
        </Button>
      </ActionBar>
    </div>
  );
}

