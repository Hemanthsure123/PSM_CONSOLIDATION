"use client";

import * as React from "react";
import { FileJson, Loader2, Play } from "lucide-react";
import { useReportBusy } from "@/components/busy-context";
import { ActionBar } from "@/components/ui/action-bar";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { Field } from "@/components/ui/field";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { Panel } from "@/components/ui/panel";
import { NativeSelect } from "@/components/ui/select";
import { BucketingPaste, type ParsedInput } from "@/components/bucketing/bucketing-paste";
import { BucketingResults, CONCURRENCY_OPTIONS } from "@/components/bucketing/bucketing-results";
import { BUCKET_COLOR } from "@/components/bucketing/candidate-detail";
import { BUCKET_LABEL, BUCKET_RULE, BUCKETS, STAGE_LABEL, STAGE_TIER, STAGES, type Stage } from "@/lib/bucketing/config";
import {
  failedBucketingResult,
  noResumeResult,
  type BucketingBatch,
  type BucketingCandidateInput,
  type BucketingImportFile,
  type BucketingResult,
  type BucketingRunMeta,
} from "@/lib/bucketing/types";
import { getBucketingRun, newBucketingRunId, runStats, saveBucketingResults, saveBucketingRunMeta } from "@/lib/bucketing-store";

interface Props {
  /** Reopen a saved run; omit to start a new one. */
  runId?: string | null;
  onDone: () => void;
}

interface Job {
  c: BucketingCandidateInput;
  attempt: number;
  notBefore: number;
}

/** Below this many GitHub calls left in the hour, the run pauses until the reset instead of failing candidates. */
const GITHUB_FLOOR = 150;
const GITHUB_CHECK_MS = 120_000;
const MODEL_RETRY_MS = 60_000;
const NETWORK_RETRY_MS = 4_000;
const MAX_ATTEMPTS = 2;
const UI_FLUSH_MS = 500;
const META_SAVE_MS = 3_000;
const NETWORK_PREFIX = "Network error";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_EXISTING = new Map<string, number>();

/**
 * Candidate Bucketing — paste the pool (or upload the sheet CSV), and every
 * resume runs through the LangGraph workflow: projects and GitHub verified,
 * domains scored, DSA consolidated, stage applied. Results land in five
 * buckets (ranked TR-2 → TR-1 → Assessment) or "not bucketed" with the reason.
 */
export function CandidateBucketing({ runId, onDone }: Props) {
  const [id, setId] = React.useState(() => runId || newBucketingRunId());
  const [loading, setLoading] = React.useState(Boolean(runId));
  const [view, setView] = React.useState<"setup" | "results">("setup");
  const [name, setName] = React.useState("");
  const [createdAt, setCreatedAt] = React.useState(() => new Date().toISOString());
  const [concurrency, setConcurrency] = React.useState(4);
  const [defaultStage, setDefaultStage] = React.useState<Stage>("ASSESSMENT");
  const [batches, setBatches] = React.useState<BucketingBatch[]>([]);
  const [candidates, setCandidates] = React.useState<BucketingCandidateInput[]>([]);
  const [results, setResults] = React.useState<Record<string, BucketingResult>>({});
  const [running, setRunning] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [pausedUntil, setPausedUntil] = React.useState("");
  const [githubLeft, setGithubLeft] = React.useState<number | null>(null);
  const [githubError, setGithubError] = React.useState("");
  const [storageError, setStorageError] = React.useState("");
  const [first, setFirst] = React.useState<ParsedInput>({ candidates: [], noResume: [] });
  const [error, setError] = React.useState("");
  const importRef = React.useRef<HTMLInputElement>(null);
  useReportBusy(running);

  const resultsRef = React.useRef<Record<string, BucketingResult>>({});
  const queueRef = React.useRef<Job[]>([]);
  const abortRef = React.useRef(false);
  const runningRef = React.useRef(false);
  const activeRef = React.useRef(0);
  const gateRef = React.useRef({ until: 0, checkedAt: 0 });
  const meta = React.useRef({ id, name, createdAt, concurrency, defaultStage, batches, candidates });
  meta.current = { id, name, createdAt, concurrency, defaultStage, batches, candidates };

  // Reopen a saved run.
  React.useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    getBucketingRun(runId)
      .then((saved) => {
        if (cancelled || !saved) return;
        const m = saved.meta;
        setName(m.name);
        setCreatedAt(m.createdAt);
        setConcurrency(m.concurrency || 4);
        setDefaultStage(m.defaultStage);
        setBatches(m.batches);
        setCandidates(m.candidates);
        resultsRef.current = saved.results;
        setResults(saved.results);
        setView("results");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not open the saved run."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // GitHub budget — shown before a run and re-checked while it goes.
  const checkGithub = React.useCallback(async (): Promise<{ remaining: number; resetAt: string } | null> => {
    try {
      const res = await fetch("/api/bucketing/github", { cache: "no-store" });
      const data = (await res.json()) as { ok: boolean; remaining?: number; resetAt?: string; message?: string };
      gateRef.current.checkedAt = Date.now();
      if (!data.ok) {
        setGithubError(data.message ?? "GitHub is not usable.");
        return null;
      }
      setGithubError("");
      setGithubLeft(data.remaining ?? null);
      return { remaining: data.remaining ?? 0, resetAt: data.resetAt ?? "" };
    } catch {
      return null;
    }
  }, []);
  React.useEffect(() => {
    void checkGithub();
  }, [checkGithub]);

  const saveMeta = React.useCallback(async () => {
    const m = meta.current;
    const record: BucketingRunMeta = {
      id: m.id,
      name: m.name.trim() || "Candidate bucketing",
      createdAt: m.createdAt,
      updatedAt: new Date().toISOString(),
      concurrency: m.concurrency,
      defaultStage: m.defaultStage,
      batches: m.batches,
      candidates: m.candidates,
      stats: runStats(Object.values(resultsRef.current)),
    };
    const ok = await saveBucketingRunMeta(record);
    if (!ok) setStorageError("The browser refused to save this run (storage full or private mode). Download the CSVs now.");
  }, []);

  const flushTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleFlush = React.useCallback(() => {
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      setResults({ ...resultsRef.current });
      setActive(activeRef.current);
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

  const record = React.useCallback(
    (rs: BucketingResult[]) => {
      for (const r of rs) resultsRef.current[r.id] = r;
      void saveBucketingResults(meta.current.id, rs).then((ok) => {
        if (!ok) setStorageError("The browser refused to save results (storage full?). Download the CSVs now.");
      });
      scheduleFlush();
      scheduleMeta();
    },
    [scheduleFlush, scheduleMeta],
  );

  const evaluateOne = async (c: BucketingCandidateInput): Promise<BucketingResult> => {
    try {
      const res = await fetch("/api/bucketing/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate: c }),
      });
      const text = await res.text();
      let data: { result?: BucketingResult; error?: string } = {};
      try {
        data = JSON.parse(text);
      } catch {
        return failedBucketingResult(c, `${NETWORK_PREFIX}: unreadable reply from the server (HTTP ${res.status}) — re-run this candidate.`);
      }
      if (!res.ok || !data.result) return failedBucketingResult(c, data.error || `Server returned HTTP ${res.status}`);
      return data.result;
    } catch (err) {
      return failedBucketingResult(c, `${NETWORK_PREFIX}: ${err instanceof Error ? err.message : "request failed"} — re-run this candidate.`);
    }
  };

  /** Hold every worker while the GitHub budget is low; true when it's fine to go on. */
  const githubGate = async (): Promise<void> => {
    const g = gateRef.current;
    if (Date.now() < g.until) return;
    if (Date.now() - g.checkedAt < GITHUB_CHECK_MS) return;
    const s = await checkGithub();
    if (s && s.remaining < GITHUB_FLOOR && s.resetAt) {
      g.until = Date.parse(s.resetAt) + 5_000;
      setPausedUntil(new Date(g.until).toISOString());
    }
  };

  /**
   * Rolling window of `concurrency` candidates, TR-2 first. Every result is saved
   * the moment it arrives. A candidate whose evidence was unavailable (GitHub
   * budget, model rate limits, network) is retried before it is recorded as
   * "re-run needed".
   */
  const analyze = React.useCallback(
    async (targets: BucketingCandidateInput[]) => {
      const fresh = targets.filter((c) => c.resumeUrl && !queueRef.current.some((j) => j.c.id === c.id));
      if (!fresh.length) return;
      queueRef.current.push(...fresh.map((c) => ({ c, attempt: 0, notBefore: 0 })));
      queueRef.current.sort((a, b) => STAGE_TIER[a.c.stage] - STAGE_TIER[b.c.stage]);
      if (runningRef.current) return;
      runningRef.current = true;
      abortRef.current = false;
      setRunning(true);

      const worker = async () => {
        while (!abortRef.current) {
          await githubGate();
          const wait = gateRef.current.until - Date.now();
          if (wait > 0) {
            await sleep(Math.min(wait, 5_000));
            continue;
          }
          if (gateRef.current.until) {
            gateRef.current.until = 0;
            setPausedUntil("");
          }
          const q = queueRef.current;
          if (!q.length) return;
          const now = Date.now();
          const idx = q.findIndex((j) => j.notBefore <= now);
          if (idx < 0) {
            await sleep(Math.min(1_000, Math.max(100, Math.min(...q.map((j) => j.notBefore)) - now)));
            continue;
          }
          const job = q.splice(idx, 1)[0];
          activeRef.current += 1;
          scheduleFlush();
          const r = await evaluateOne(job.c);
          activeRef.current -= 1;
          if (r.status === "retry_needed" && job.attempt < MAX_ATTEMPTS && !abortRef.current) {
            const network = r.remarks.some((m) => m.startsWith(NETWORK_PREFIX));
            if (r.reasonCodes.includes("GITHUB_UNAVAILABLE")) gateRef.current.checkedAt = 0; // re-check the budget now
            q.push({ c: job.c, attempt: job.attempt + 1, notBefore: Date.now() + (network ? NETWORK_RETRY_MS : MODEL_RETRY_MS * (job.attempt + 1)) });
            q.sort((a, b) => STAGE_TIER[a.c.stage] - STAGE_TIER[b.c.stage]);
            scheduleFlush();
            continue;
          }
          record([r]);
        }
      };

      try {
        while (queueRef.current.length && !abortRef.current) {
          const width = Math.min(8, Math.max(1, meta.current.concurrency));
          await Promise.all(Array.from({ length: Math.min(width, queueRef.current.length) }, worker));
        }
      } finally {
        queueRef.current = [];
        activeRef.current = 0;
        runningRef.current = false;
        setRunning(false);
        setActive(0);
        setPausedUntil("");
        setResults({ ...resultsRef.current });
        void saveMeta();
      }
    },
    // evaluateOne / githubGate only use refs and stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [record, saveMeta, scheduleFlush],
  );

  const start = async () => {
    setError("");
    const all = [...first.candidates, ...first.noResume];
    if (!first.candidates.length) return;
    const now = new Date().toISOString();
    const b: BucketingBatch[] = [{ n: 1, addedAt: now, count: all.length }];
    meta.current = { ...meta.current, batches: b, candidates: all, createdAt: now };
    setCreatedAt(now);
    setBatches(b);
    setCandidates(all);
    resultsRef.current = {};
    record(first.noResume.map(noResumeResult));
    await saveMeta();
    setView("results");
    void analyze(first.candidates);
  };

  const addBatch = async (input: ParsedInput) => {
    const m = meta.current;
    const n = (m.batches.length ? m.batches[m.batches.length - 1].n : 0) + 1;
    const rows = [...input.candidates, ...input.noResume].filter((r) => !m.candidates.some((c) => c.id === r.id)).map((r) => ({ ...r, batch: n }));
    if (!rows.length) return;
    const nextBatches = [...m.batches, { n, addedAt: new Date().toISOString(), count: rows.length }];
    const nextCandidates = [...m.candidates, ...rows];
    meta.current = { ...m, batches: nextBatches, candidates: nextCandidates };
    setBatches(nextBatches);
    setCandidates(nextCandidates);
    record(rows.filter((r) => !r.resumeUrl).map(noResumeResult));
    await saveMeta();
    void analyze(rows.filter((r) => r.resumeUrl));
  };

  /** Load the batch runner's output (scripts/bucketing-run.ts) as a new saved run. */
  const importFile = async (file: File) => {
    setError("");
    try {
      const raw = JSON.parse(await file.text()) as BucketingImportFile | BucketingResult[];
      const data: BucketingImportFile = Array.isArray(raw) ? { results: raw } : raw;
      if (!Array.isArray(data.results) || !data.results.every((r) => r && typeof r.id === "string" && "status" in r)) {
        throw new Error("This file is not a bucketing results file.");
      }
      const cands: BucketingCandidateInput[] =
        data.candidates ??
        data.results.map((r) => ({ id: r.id, mobile: r.mobile, name: r.name, resumeUrl: "", stage: r.stage, track: r.track, batch: 1 }));
      const now = new Date().toISOString();
      const newId = newBucketingRunId();
      const runName = name.trim() || data.name || file.name.replace(/\.json$/i, "");
      meta.current = { id: newId, name: runName, createdAt: now, concurrency, defaultStage, batches: [{ n: 1, addedAt: now, count: cands.length }], candidates: cands };
      setId(newId);
      setName(runName);
      setCreatedAt(now);
      setBatches(meta.current.batches);
      setCandidates(cands);
      resultsRef.current = {};
      record(data.results);
      await saveMeta();
      setView("results");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import the file.");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" /> Opening the saved run…
      </div>
    );
  }

  if (view === "results") {
    return (
      <BucketingResults
        title={name || "Candidate bucketing"}
        candidates={candidates}
        results={results}
        batches={batches}
        defaultStage={defaultStage}
        running={running}
        active={active}
        pausedUntil={pausedUntil}
        githubLeft={githubLeft}
        concurrency={concurrency}
        onConcurrencyChange={(n) => {
          meta.current = { ...meta.current, concurrency: n };
          setConcurrency(n);
          scheduleMeta();
        }}
        onRun={(targets) => void analyze(targets)}
        onStop={() => {
          abortRef.current = true;
        }}
        onBack={onDone}
        onAddBatch={(input) => void addBatch(input)}
        storageError={storageError}
      />
    );
  }

  const ready = first.candidates.length;
  return (
    <div className="max-w-3xl space-y-6">
      <Panel title="Run" description="A run is saved as it goes and can be resumed from the dashboard.">
        <Field label="Run name" htmlFor="bk-name" info="TR-2 cleared candidates run first, then TR-1, then Assessment.">
          <Input id="bk-name" placeholder="e.g. Assessed pool 8+ LPA — Oct 2026" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </Panel>

      <Panel
        title="Candidates"
        description={
          <>
            Upload the sheet&apos;s CSV export, or paste its rows with the header row.{" "}
            <InfoHint label="About resume links" align="start">
              Resume links must be public or shared with the service account.
            </InfoHint>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Rows with no stage are" htmlFor="bk-stage" className="sm:max-w-xs">
            <NativeSelect id="bk-stage" value={defaultStage} onChange={(e) => setDefaultStage(e.target.value as Stage)}>
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABEL[s]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <BucketingPaste batch={1} existing={NO_EXISTING} defaultStage={defaultStage} onParsed={setFirst} />
        </div>
      </Panel>

      <Disclosure title="How bucketing works" summary={`${BUCKETS.length} buckets`}>
        <div className="space-y-4 text-[13px]">
          <p className="leading-relaxed text-muted-foreground">
            Every resume goes through an agent workflow. Projects and their GitHub repos are verified commit by commit: any commit by someone else or
            by an AI coding tool invalidates the project. Domains are scored from projects and internships only, DSA is consolidated (Codeforces first,
            then CodeChef, then LeetCode), and the interview stage is applied. Each candidate lands in one bucket, or gets the reason why not, with a
            trust score.
          </p>
          <div>
            <p className="font-medium">The five buckets</p>
            <p className="text-muted-foreground">A bucket needs one verified project whose code (not the resume&apos;s wording) meets its rule.</p>
            <dl className="mt-2 divide-y rounded-lg border">
              {BUCKETS.map((b) => (
                <div key={b} className="grid gap-1 px-3 py-2 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-3">
                  <dt className="flex items-center gap-2 font-medium">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: BUCKET_COLOR[b] }} aria-hidden />
                    {BUCKET_LABEL[b]}
                  </dt>
                  <dd className="text-muted-foreground">{BUCKET_RULE[b]}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </Disclosure>

      <Disclosure title="Advanced options" summary={`${concurrency} in parallel`}>
        <Field
          label="Candidates in parallel"
          htmlFor="bk-conc"
          hint="Each candidate uses about 10 GitHub calls."
          className="sm:max-w-xs"
        >
          <NativeSelect id="bk-conc" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>
            {CONCURRENCY_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} at a time{n === 4 ? " (recommended)" : ""}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </Disclosure>

      {githubError ? (
        <Notice tone="danger" title="GitHub can't be used, so the run can't start">
          GitHub: {githubError}
        </Notice>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <ActionBar
        status={
          <div className="space-y-0.5">
            <p className="font-medium text-foreground">
              {!name.trim() ? "Name the run to start." : ready ? `${ready} candidates ready.` : "Add at least one candidate."}
            </p>
            {!githubError ? (
              <p className="text-xs tabular-nums">
                {githubLeft !== null
                  ? `GitHub calls left this hour: ${githubLeft} (about 10 per candidate; the run pauses itself below ${GITHUB_FLOOR}).`
                  : "Checking GitHub…"}
              </p>
            ) : null}
          </div>
        }
      >
        <input
          ref={importRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = "";
          }}
        />
        <Button variant="outline" onClick={() => importRef.current?.click()} title="Open results.json from a batch run">
          <FileJson className="h-4 w-4" /> Open a results file
        </Button>
        <Button size="lg" onClick={start} disabled={!ready || !name.trim() || Boolean(githubError)}>
          <Play className="h-4 w-4" /> Start bucketing
        </Button>
      </ActionBar>
    </div>
  );
}
