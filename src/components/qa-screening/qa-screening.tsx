"use client";

import * as React from "react";
import { ChevronRight, ClipboardList, Loader2, Play, Users } from "lucide-react";
import { useReportBusy } from "@/components/busy-context";
import { ActionBar } from "@/components/ui/action-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { Field } from "@/components/ui/field";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { Panel } from "@/components/ui/panel";
import { NativeSelect } from "@/components/ui/select";
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
  // Leaving from the sidebar mid-run asks first.
  useReportBusy(running);

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
      <div className="flex items-center gap-2 py-16 text-[13px] text-muted-foreground" role="status">
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
    <div className="w-full max-w-3xl space-y-6">
      <Panel
        title="Candidates"
        description="Name the run, then paste batch 1 from your sheet."
        icon={<Users />}
        actions={
          <InfoHint label="About batches and resume links" align="end">
            Copy the mobile-number and resume columns from your sheet and paste them here, up to a few thousand rows at a time.
            The mobile number is the candidate&apos;s ID. Resume links must be shared with the service account or public. One
            run holds the whole pool: add the next batch from the results page, and the ranking and downloads cover every batch.
          </InfoHint>
        }
      >
        <div className="space-y-4">
          <Field label="Run name" htmlFor="qa-name" hint="Used for the saved run and the CSV file names.">
            <Input id="qa-name" placeholder="e.g. QA drive — Oct 2026" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Batch 1 rows">
            <QaPaste batch={1} existing={NO_EXISTING} onParsed={setFirstRows} />
          </Field>
        </div>
      </Panel>

      <Panel
        title="QA requirement"
        description="Mandatory items must be in Skills, Projects and Experience for 100%. Good-to-have items raise the score."
        icon={<ClipboardList />}
      >
        <div className="space-y-4 text-[13px]">
          <div className="space-y-2">
            <p className="font-medium">
              Mandatory <span className="font-normal tabular-nums text-muted-foreground">({MANDATORY.length})</span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              {MANDATORY.map((d) => (
                <Badge key={d.key} variant="default">
                  {d.label}
                </Badge>
              ))}
            </div>
          </div>
          <details className="group border-t pt-3">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform duration-150 group-open:rotate-90" />
              Good to have{" "}
              <span className="font-normal tabular-nums text-muted-foreground">({GOOD_TO_HAVE.length + 1})</span>
            </summary>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {[...GOOD_TO_HAVE.map((d) => d.label), HANDS_ON_LABEL].map((l) => (
                <Badge key={l} variant="secondary">
                  {l}
                </Badge>
              ))}
            </div>
          </details>
        </div>
      </Panel>

      <RulesCard rules={rules} onChange={setRules} />

      <Disclosure title="Advanced options" summary={`${concurrency} resumes at a time`}>
        <Field
          label="Resumes screened in parallel"
          htmlFor="qa-conc"
          hint="12 suits most runs. You can change it on the results page too."
          className="max-w-xs"
        >
          <NativeSelect id="qa-conc" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>
            {CONCURRENCY_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} at a time{n === 12 ? " (recommended)" : ""}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </Disclosure>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <ActionBar
        status={
          !name.trim() ? (
            "Name the run to start."
          ) : firstRows.length ? (
            <span className="font-medium text-foreground">
              <span className="tabular-nums">{firstRows.length}</span> candidates ready.
            </span>
          ) : (
            "Paste at least one candidate."
          )
        }
      >
        <Button size="lg" onClick={start} disabled={!firstRows.length || !name.trim()}>
          <Play className="h-4 w-4" /> Start screening
        </Button>
      </ActionBar>
    </div>
  );
}
