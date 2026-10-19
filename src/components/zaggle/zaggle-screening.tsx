"use client";

import * as React from "react";
import { Building2, ClipboardList, Loader2, Play } from "lucide-react";
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
import { ZG_CONCURRENCY_OPTIONS, ZaggleResults, ZgRulesCard } from "@/components/zaggle/zaggle-results";
import { KNOWN_SERVICES_FIRMS } from "@/lib/zaggle/companies";
import { rankZg, summarizeZg } from "@/lib/zaggle/scoring";
import { getZgRun, newZgRunId, saveZgResult, saveZgRunMeta } from "@/lib/zaggle/store";
import {
  DEFAULT_ZG_RULES,
  ZAGGLE_ROLE,
  ZG_GOOD_TO_HAVE,
  ZG_SKILLS,
  failedZgEvaluation,
  type ZgBatch,
  type ZgCandidateInput,
  type ZgEvaluation,
  type ZgRules,
  type ZgRunMeta,
} from "@/lib/zaggle/types";

interface Props {
  /** Reopen a saved run; omit to start a new one. */
  runId?: string | null;
  onDone: () => void;
}

interface Job {
  c: ZgCandidateInput;
  attempt: number;
  notBefore: number;
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 30_000;
const NETWORK_RETRY_MS = 4_000;
const NETWORK_PREFIX = "Network error";
const UI_FLUSH_MS = 400;
const META_SAVE_MS = 3_000;
const DEFAULT_CONCURRENCY = 8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_EXISTING = new Map<string, number>();

/**
 * Zaggle (ZagMoney) — SDE 1 Backend Engineer. A screening built for this one
 * JD: paste the candidates (mobile + resume link) in batches of any size, every
 * resume is checked for the mandatory requirements — including 1 year of
 * relevant full-time experience summed across companies — and ranked; download
 * the shortlist, the review list or the complete ranking.
 */
export function ZaggleScreening({ runId, onDone }: Props) {
  const [id] = React.useState(() => runId || newZgRunId());
  const [loading, setLoading] = React.useState(Boolean(runId));
  const [stage, setStage] = React.useState<"setup" | "results">("setup");
  const [name, setName] = React.useState("");
  const [createdAt, setCreatedAt] = React.useState(() => new Date().toISOString());
  const [rules, setRules] = React.useState<ZgRules>(DEFAULT_ZG_RULES);
  const [concurrency, setConcurrency] = React.useState(DEFAULT_CONCURRENCY);
  const [batches, setBatches] = React.useState<ZgBatch[]>([]);
  const [candidates, setCandidates] = React.useState<ZgCandidateInput[]>([]);
  const [results, setResults] = React.useState<Record<string, ZgEvaluation>>({});
  const [running, setRunning] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [retrying, setRetrying] = React.useState(0);
  const [storageError, setStorageError] = React.useState("");
  const [firstRows, setFirstRows] = React.useState<ZgCandidateInput[]>([]);
  const [error, setError] = React.useState("");
  useReportBusy(running);

  const resultsRef = React.useRef<Record<string, ZgEvaluation>>({});
  const queueRef = React.useRef<Job[]>([]);
  const abortRef = React.useRef(false);
  const runningRef = React.useRef(false);
  const counters = React.useRef({ active: 0, retrying: 0 });
  const meta = React.useRef({ name, createdAt, rules, concurrency, batches, candidates });
  meta.current = { name, createdAt, rules, concurrency, batches, candidates };

  React.useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    getZgRun(runId)
      .then((saved) => {
        if (cancelled || !saved) return;
        const m = saved.meta;
        setName(m.name);
        setCreatedAt(m.createdAt);
        setRules({ ...DEFAULT_ZG_RULES, ...m.rules });
        setConcurrency(m.concurrency || DEFAULT_CONCURRENCY);
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
    const sum = summarizeZg(rankZg(m.candidates, resultsRef.current, m.rules));
    const record: ZgRunMeta = {
      id,
      name: m.name.trim() || "Zaggle SDE 1",
      createdAt: m.createdAt,
      updatedAt: new Date().toISOString(),
      rules: m.rules,
      concurrency: m.concurrency,
      batches: m.batches,
      candidates: m.candidates,
      stats: { evaluated: sum.evaluated, shortlisted: sum.shortlisted, review: sum.review, errors: sum.errors },
    };
    if (!(await saveZgRunMeta(record))) setStorageError("The browser refused to save this run (storage full or private mode). Download the CSVs now.");
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

  const screenOne = async (c: ZgCandidateInput): Promise<ZgEvaluation> => {
    try {
      const res = await fetch("/api/zaggle/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate: c }),
      });
      const text = await res.text();
      let data: { result?: ZgEvaluation; error?: string } = {};
      try {
        data = JSON.parse(text);
      } catch {
        return failedZgEvaluation(c, `${NETWORK_PREFIX}: unreadable reply from the server (HTTP ${res.status}) — re-run this candidate.`, true);
      }
      if (!res.ok || !data.result) return failedZgEvaluation(c, data.error || `Server returned HTTP ${res.status}`, res.status >= 500);
      return data.result;
    } catch (err) {
      return failedZgEvaluation(c, `${NETWORK_PREFIX}: ${err instanceof Error ? err.message : "request failed"} — re-run this candidate.`, true);
    }
  };

  /** Rolling window of `concurrency` requests; each result saved as it arrives; rate-limited rows retried later. */
  const analyze = React.useCallback(
    async (targets: ZgCandidateInput[]) => {
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
          void saveZgResult(id, result).then((ok) => {
            if (!ok) setStorageError("The browser refused to save results (storage full?). Download the CSVs now.");
          });
          scheduleFlush();
          scheduleMeta();
        }
      };

      try {
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
    const b: ZgBatch[] = [{ n: 1, addedAt: now, count: firstRows.length }];
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

  const addBatch = async (rows: ZgCandidateInput[]) => {
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

  const changeRules = (next: ZgRules) => {
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
      <div role="status" className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-primary" /> Opening the saved run…
      </div>
    );
  }

  if (stage === "results") {
    return (
      <ZaggleResults
        title={name || "Zaggle SDE 1"}
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

  const mandatoryLabels = [
    ...ZG_SKILLS.map((d) => d.label),
    `1 year relevant full-time backend / software experience (${rules.minMonths}–${rules.maxMonths} months, summed across companies, overlaps once, internships ${rules.countInternships ? "counted" : "not counted"})`,
    "Experience at a software product company",
    "No consulting / IT services background",
  ];

  return (
    <div className="max-w-3xl space-y-6">
      <Panel icon={<Building2 />} title="Run" description={`${ZAGGLE_ROLE.company} · ${ZAGGLE_ROLE.title}`}>
        <Field label="Run name" htmlFor="zg-name" hint="One run holds the whole pool. Add later batches from the results.">
          <Input id="zg-name" placeholder="e.g. Zaggle SDE 1 — Oct 2026" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </Panel>

      <Panel
        icon={<ClipboardList />}
        title="Batch 1 candidates"
        description={
          <>
            Paste the mobile-number and resume columns from your sheet.{" "}
            <InfoHint label="About pasting candidates" align="start">
              Up to a few thousand rows at a time. The mobile number is the candidate&apos;s ID; resume links must be shared with the
              service account or be public.
            </InfoHint>
          </>
        }
      >
        <QaPaste batch={1} existing={NO_EXISTING} onParsed={setFirstRows} />
      </Panel>

      <Disclosure title="What the screening checks" summary={`${mandatoryLabels.length} mandatory · ${ZG_GOOD_TO_HAVE.length} good to have`}>
        <div className="space-y-4 text-[13px]">
          <p className="leading-relaxed text-muted-foreground">
            Screening built for this JD only. Every resume is read for the work history (each job&apos;s company, type and dates) and the
            required skills, with the exact resume words as evidence. The program adds up the relevant full-time months across companies,
            checks the employers, then ranks everyone.
          </p>
          <div className="space-y-1.5">
            <p className="font-medium">Mandatory</p>
            <ul className="flex flex-wrap gap-1.5">
              {mandatoryLabels.map((l) => (
                <li key={l}>
                  <Badge variant="default" className="whitespace-normal">
                    {l}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-1.5">
            <p className="font-medium">Good to have</p>
            <ul className="flex flex-wrap gap-1.5">
              {ZG_GOOD_TO_HAVE.map((d) => (
                <li key={d.key}>
                  <Badge variant="secondary" className="whitespace-normal">
                    {d.label}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-muted-foreground">100% only when every mandatory requirement is met; each good-to-have raises the score above 100%.</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Known IT services / consulting / staffing firms (always classified as such): {KNOWN_SERVICES_FIRMS.join(", ")}. Other employers
            are classified from the resume: a firm that builds software for clients counts as IT services; one that runs its own product
            counts as a product company; if the resume doesn&apos;t make it clear, the candidate goes to Review.
          </p>
        </div>
      </Disclosure>

      <ZgRulesCard rules={rules} onChange={setRules} />

      <Disclosure title="Advanced options" summary={`${concurrency} at a time`}>
        <Field
          label="Resumes screened in parallel"
          htmlFor="zg-conc"
          info="More at a time finishes sooner. Resumes that hit a rate limit are retried automatically."
        >
          <NativeSelect
            id="zg-conc"
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
            wrapperClassName="sm:max-w-xs"
          >
            {ZG_CONCURRENCY_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} at a time{n === DEFAULT_CONCURRENCY ? " (recommended)" : ""}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </Disclosure>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <ActionBar
        status={!name.trim() ? "Name the run to start." : firstRows.length ? `${firstRows.length} candidates ready.` : "Paste at least one candidate."}
      >
        <Button size="lg" onClick={start} disabled={!firstRows.length || !name.trim()}>
          <Play className="h-4 w-4" /> Start screening
        </Button>
      </ActionBar>
    </div>
  );
}
