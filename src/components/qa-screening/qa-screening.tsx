"use client";

import * as React from "react";
import { ClipboardList, Home, Loader2, Play, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QaPaste } from "@/components/qa-screening/qa-paste";
import { CONCURRENCY_OPTIONS, QaResults, RulesCard } from "@/components/qa-screening/qa-results";
import { rankCandidates, summarize } from "@/lib/qa-scoring";
import { getQaRun, newQaRunId, saveQaResult, saveQaRunMeta } from "@/lib/qa-store";
import {
  DEFAULT_RULES,
  GOOD_TO_HAVE,
  HANDS_ON_LABEL,
  MANDATORY,
  failedEvaluation,
  type QaBatch,
  type QaCandidateInput,
  type QaEvaluation,
  type QaRules,
  type QaRunMeta,
} from "@/lib/qa-types";

interface QaScreeningProps {
  /** Reopen a saved run; omit to start a new one. */
  runId?: string | null;
  onDone: () => void;
}

interface Job {
  c: QaCandidateInput;
  attempt: number;
  /** Epoch ms before which the job must not start (rate-limit back-off). */
  notBefore: number;
}

/** A candidate that failed only because every model was rate-limited is retried this often. */
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 30_000;
/** A dropped connection / unreadable reply is retried almost at once. */
const NETWORK_RETRY_MS = 4_000;
const NETWORK_PREFIX = "Network error";
const UI_FLUSH_MS = 400;
const META_SAVE_MS = 3_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fieldClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
const NO_EXISTING = new Map<string, number>();

/**
 * QA Resume Screening — paste candidates (mobile + resume) in batches of any
 * size, screen every resume for the QA requirement with verified evidence, and
 * download the complete ranking or the shortlist.
 */
export function QaScreening({ runId, onDone }: QaScreeningProps) {
  const [id] = React.useState(() => runId || newQaRunId());
  const [loading, setLoading] = React.useState(Boolean(runId));
  const [stage, setStage] = React.useState<"setup" | "results">("setup");
  const [name, setName] = React.useState("");
  const [createdAt, setCreatedAt] = React.useState(() => new Date().toISOString());
  const [rules, setRules] = React.useState<QaRules>(DEFAULT_RULES);
  const [concurrency, setConcurrency] = React.useState(12);
  const [batches, setBatches] = React.useState<QaBatch[]>([]);
  const [candidates, setCandidates] = React.useState<QaCandidateInput[]>([]);
  const [results, setResults] = React.useState<Record<string, QaEvaluation>>({});
  const [running, setRunning] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [retrying, setRetrying] = React.useState(0);
  const [storageError, setStorageError] = React.useState("");
  const [firstRows, setFirstRows] = React.useState<QaCandidateInput[]>([]);
  const [error, setError] = React.useState("");

  // The run loop outlives renders: it reads and writes through refs, and the UI
  // is refreshed on a short timer instead of once per resume.
  const resultsRef = React.useRef<Record<string, QaEvaluation>>({});
  const queueRef = React.useRef<Job[]>([]);
  const abortRef = React.useRef(false);
  const runningRef = React.useRef(false);
  const counters = React.useRef({ active: 0, retrying: 0 });
  const meta = React.useRef({ name, createdAt, rules, concurrency, batches, candidates });
  meta.current = { name, createdAt, rules, concurrency, batches, candidates };

  // Reopen a saved run.
  React.useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    getQaRun(runId)
      .then((saved) => {
        if (cancelled || !saved) return;
        const m = saved.meta;
        setName(m.name);
        setCreatedAt(m.createdAt);
        setRules({ ...DEFAULT_RULES, ...m.rules });
        setConcurrency(m.concurrency || 12);
        setBatches(m.batches);
        setCandidates(m.candidates);
        resultsRef.current = saved.results;
        setResults(saved.results);
        setStage("results");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not open the saved run."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const saveMeta = React.useCallback(async () => {
    const m = meta.current;
    const sum = summarize(rankCandidates(m.candidates, resultsRef.current, m.rules));
    const record: QaRunMeta = {
      id,
      name: m.name.trim() || "QA screening",
      createdAt: m.createdAt,
      updatedAt: new Date().toISOString(),
      rules: m.rules,
      concurrency: m.concurrency,
      batches: m.batches,
      candidates: m.candidates,
      stats: { evaluated: sum.evaluated, shortlisted: sum.shortlisted, borderline: sum.borderline, errors: sum.errors },
    };
    const ok = await saveQaRunMeta(record);
    if (!ok) setStorageError("The browser refused to save this run (storage full or private mode). Download the CSVs now.");
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

  const screenOne = async (c: QaCandidateInput): Promise<QaEvaluation> => {
    try {
      const res = await fetch("/api/qa/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate: c }),
      });
      const text = await res.text();
      let data: { result?: QaEvaluation; error?: string } = {};
      try {
        data = JSON.parse(text);
      } catch {
        // A cut-off / non-JSON reply (server restarting, proxy hiccup) — transient, so retry.
        console.warn(`[qa] ${c.mobile}: unreadable reply (HTTP ${res.status}, ${text.length} chars)`, text.slice(0, 200));
        return failedEvaluation(c, `${NETWORK_PREFIX}: unreadable reply from the server (HTTP ${res.status}) — re-run this candidate.`, true);
      }
      if (!res.ok || !data.result) {
        return failedEvaluation(c, data.error || `Server returned HTTP ${res.status}`, res.status >= 500);
      }
      return data.result;
    } catch (err) {
      // Network blip / dev server restarting — worth another try.
      return failedEvaluation(c, `${NETWORK_PREFIX}: ${err instanceof Error ? err.message : "request failed"} — re-run this candidate.`, true);
    }
  };

  /**
   * Screen `targets` with a rolling window of `concurrency` requests. Each
   * result is saved the moment it arrives; a candidate that failed only on
   * rate limits goes back in the queue after a pause. Called while a run is
   * going, it just adds the targets to the live queue.
   */
  const analyze = React.useCallback(
    async (targets: QaCandidateInput[]) => {
      if (!targets.length) return;
      queueRef.current.push(...targets.map((c) => ({ c, attempt: 0, notBefore: 0 })));
      if (runningRef.current) return;
      runningRef.current = true;
      abortRef.current = false;
      setRunning(true);

      const worker = async () => {
        while (!abortRef.current) {
          const q = queueRef.current;
          if (!q.length) return;
          const now = Date.now();
          const idx = q.findIndex((j) => j.notBefore <= now);
          if (idx < 0) {
            await sleep(Math.min(1_000, Math.max(100, Math.min(...q.map((j) => j.notBefore)) - now)));
            continue;
          }
          const job = q.splice(idx, 1)[0];
          if (job.attempt > 0) counters.current.retrying--;
          counters.current.active++;
          scheduleFlush();
          const result = await screenOne(job.c);
          counters.current.active--;
          if (result.status === "error" && result.retryable && job.attempt < MAX_RETRIES && !abortRef.current) {
            const wait = result.error.startsWith(NETWORK_PREFIX) ? NETWORK_RETRY_MS : RETRY_DELAY_MS * (job.attempt + 1);
            q.push({ c: job.c, attempt: job.attempt + 1, notBefore: Date.now() + wait });
            counters.current.retrying++;
            scheduleFlush();
            continue;
          }
          resultsRef.current[job.c.id] = result;
          void saveQaResult(id, result).then((ok) => {
            if (!ok) setStorageError("The browser refused to save results (storage full?). Download the CSVs now.");
          });
          scheduleFlush();
          scheduleMeta();
        }
      };

      try {
        // Workers stop when the queue is empty; a batch added at that very moment starts them again.
        while (queueRef.current.length && !abortRef.current) {
          const width = Math.min(16, Math.max(1, meta.current.concurrency));
          await Promise.all(Array.from({ length: Math.min(width, queueRef.current.length) }, worker));
        }
      } finally {
        queueRef.current = [];
        counters.current = { active: 0, retrying: 0 };
        runningRef.current = false;
        setRunning(false);
        setActive(0);
        setRetrying(0);
        setResults({ ...resultsRef.current });
        void saveMeta();
      }
    },
    // screenOne only uses stable values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, scheduleFlush, scheduleMeta, saveMeta],
  );

  const start = async () => {
    setError("");
    if (!firstRows.length) return;
    const now = new Date().toISOString();
    const b: QaBatch[] = [{ n: 1, addedAt: now, count: firstRows.length }];
    meta.current = { ...meta.current, batches: b, candidates: firstRows, createdAt: now };
    setCreatedAt(now);
    setBatches(b);
    setCandidates(firstRows);
    resultsRef.current = {};
    setResults({});
    await saveMeta();
    setStage("results");
    void analyze(firstRows);
  };

  const addBatch = async (rows: QaCandidateInput[]) => {
    if (!rows.length) return;
    const m = meta.current;
    const n = (m.batches.length ? m.batches[m.batches.length - 1].n : 0) + 1;
    const fresh = rows.filter((r) => !m.candidates.some((c) => c.id === r.id)).map((r) => ({ ...r, batch: n }));
    if (!fresh.length) return;
    const nextBatches = [...m.batches, { n, addedAt: new Date().toISOString(), count: fresh.length }];
    const nextCandidates = [...m.candidates, ...fresh];
    meta.current = { ...m, batches: nextBatches, candidates: nextCandidates };
    setBatches(nextBatches);
    setCandidates(nextCandidates);
    await saveMeta();
    void analyze(fresh);
  };

  const changeRules = (next: QaRules) => {
    meta.current = { ...meta.current, rules: next };
    setRules(next);
    scheduleMeta();
  };

  const changeConcurrency = (n: number) => {
    meta.current = { ...meta.current, concurrency: n };
    setConcurrency(n);
    scheduleMeta();
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Opening the saved run…
      </div>
    );
  }

  if (stage === "results") {
    return (
      <QaResults
        title={name || "QA screening"}
        candidates={candidates}
        results={results}
        rules={rules}
        onRulesChange={changeRules}
        batches={batches}
        running={running}
        active={active}
        retrying={retrying}
        concurrency={concurrency}
        onConcurrencyChange={changeConcurrency}
        onRun={(targets) => void analyze(targets)}
        onStop={() => {
          abortRef.current = true;
        }}
        onBack={onDone}
        onAddBatch={(rows) => void addBatch(rows)}
        storageError={storageError}
      />
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
              <ShieldCheck className="h-4 w-4 text-muted-foreground" /> QA Resume Screening
            </h2>
            <p className="text-sm text-muted-foreground">
              Screen large pools for the QA role: every resume is checked for the mandatory and good-to-have QA skills in
              its Skills, Projects and Experience — with the exact resume words as evidence — then ranked. Paste batches
              of any size; download the complete ranking or only the shortlist.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="h-4 w-4" /> The QA requirement
          </CardTitle>
          <CardDescription>
            Mandatory items must be in Skills, Projects and Experience for 100%; good-to-have items raise the score.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 font-medium">Mandatory:</span>
            {MANDATORY.map((d) => (
              <span key={d.key} className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                {d.label}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 font-medium">Good to have:</span>
            {[...GOOD_TO_HAVE.map((d) => d.label), HANDS_ON_LABEL].map((l) => (
              <span key={l} className="rounded bg-muted px-2 py-0.5 text-xs">
                {l}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Run</CardTitle>
          <CardDescription>
            One run holds the whole pool — add the next batch from the results page; ranking and downloads cover every
            batch.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="qa-name">Run name</Label>
            <Input id="qa-name" placeholder="e.g. QA drive — Oct 2026" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qa-conc">Resumes screened in parallel</Label>
            <select id="qa-conc" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} className={fieldClass}>
              {CONCURRENCY_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} at a time{n === 12 ? " (recommended)" : ""}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <RulesCard rules={rules} onChange={setRules} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Batch 1 — paste candidates</CardTitle>
          <CardDescription>
            Copy the mobile-number and resume columns from your sheet and paste them here (up to a few thousand rows at a
            time). The mobile number is the candidate&apos;s ID; resume links must be shared with the service account or
            public.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <QaPaste batch={1} existing={NO_EXISTING} onParsed={setFirstRows} />
        </CardContent>
      </Card>

      {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {!name.trim() ? "Name the run to start." : firstRows.length ? `${firstRows.length} candidates ready.` : "Paste at least one candidate."}
        </p>
        <Button size="lg" onClick={start} disabled={!firstRows.length || !name.trim()}>
          <Play className="h-4 w-4" /> Start screening
        </Button>
      </div>
    </div>
  );
}
