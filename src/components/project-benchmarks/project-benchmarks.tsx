"use client";

import * as React from "react";
import { FileText, Loader2, Play, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/select";
import { Panel } from "@/components/ui/panel";
import { Field } from "@/components/ui/field";
import { Disclosure } from "@/components/ui/disclosure";
import { InfoHint } from "@/components/ui/info-hint";
import { Notice } from "@/components/ui/notice";
import { ActionBar } from "@/components/ui/action-bar";
import { useReportBusy } from "@/components/busy-context";
import { cn } from "@/lib/utils";
import { BenchmarkPaste } from "@/components/project-benchmarks/benchmark-paste";
import { BenchmarkResults, CONCURRENCY_OPTIONS, type ExportSettings } from "@/components/project-benchmarks/benchmark-results";
import { consolidateBenchmarks } from "@/lib/benchmark-report";
import { getBenchmarkRun, newBenchmarkRunId, saveBenchmarkResult, saveBenchmarkRunMeta } from "@/lib/benchmark-store";
import {
  DEFAULT_MIN_RELEVANCE,
  DEFAULT_MIN_SCORE,
  failedBenchmark,
  type BenchmarkBatch,
  type BenchmarkCandidateInput,
  type BenchmarkDomainProfile,
  type BenchmarkResult,
  type BenchmarkRunMeta,
} from "@/lib/benchmark-types";
import { linkOnly } from "@/lib/resume-input";

interface ProjectBenchmarksProps {
  /** Reopen a saved run; omit to start a new one. */
  runId?: string | null;
  /** Start screening the reopened run's unscreened resumes straight away (a run just created for another domain). */
  autoStart?: boolean;
  onDone: () => void;
  /** Open another saved run (used after creating one for another domain). */
  onOpenRun: (runId: string, autoStart: boolean) => void;
}

interface Job {
  c: BenchmarkCandidateInput;
  attempt: number;
  /** Epoch ms before which the job must not start (rate-limit back-off). */
  notBefore: number;
}

/** A resume that failed only because every model was rate-limited is retried this often. */
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 30_000;
/** A dropped connection / unreadable reply is retried almost at once. */
const NETWORK_RETRY_MS = 4_000;
const NETWORK_PREFIX = "Network error";
const UI_FLUSH_MS = 400;
const META_SAVE_MS = 3_000;
const DEFAULT_CONCURRENCY = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_EXISTING = new Map<string, number>();
const DEFAULT_SETTINGS: ExportSettings = {
  minScore: DEFAULT_MIN_SCORE,
  minRelevance: DEFAULT_MIN_RELEVANCE,
  categories: [],
  showSources: false,
};
/** One-click starting points — any domain or tech stack can be typed. */
const DOMAIN_EXAMPLES = [
  "Generative AI",
  "Machine Learning",
  "Backend Engineering",
  "MERN Stack",
  "Java Spring Boot",
  "Data Engineering",
  "DevOps & Cloud",
  "Frontend (React)",
  "Android Development",
  "Cybersecurity",
];

const defaultTitle = (domain: string) => `Benchmark ${domain} Projects for 15+ LPA Roles`;

/** Turn the typed domain into the run's domain profile (one model call). */
async function fetchProfile(domain: string, focus: string): Promise<{ profile?: BenchmarkDomainProfile; error?: string }> {
  try {
    const res = await fetch("/api/benchmarks/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain, focus }),
    });
    const data = (await res.json().catch(() => ({}))) as { profile?: BenchmarkDomainProfile; error?: string };
    if (!res.ok || !data.profile) return { error: data.error || `Server returned HTTP ${res.status}` };
    return { profile: data.profile };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Request failed." };
  }
}

/**
 * A run saved before screening became domain-specific had no profile and filed
 * projects under fixed domains — open it as an "all domains" run so nothing is lost.
 */
function upgradeLegacy(
  meta: BenchmarkRunMeta,
  results: Record<string, BenchmarkResult>,
): { meta: BenchmarkRunMeta; results: Record<string, BenchmarkResult> } {
  if (meta.profile) return { meta, results };
  const categories = new Set<string>();
  const upgraded: Record<string, BenchmarkResult> = {};
  for (const [id, r] of Object.entries(results)) {
    upgraded[id] = {
      ...r,
      projects: r.projects.map((p) => {
        const legacy = p as typeof p & { domain?: string };
        const category = p.category || legacy.domain || "Other";
        categories.add(category);
        return { ...p, category, relevance: typeof p.relevance === "number" ? p.relevance : 100 };
      }),
    };
  }
  const profile: BenchmarkDomainProfile = {
    domain: "All domains",
    input: "",
    focus: "",
    summary: "Screened before domain-specific screening — projects from every domain. Start a new run with a domain to screen for one.",
    categories: Array.from(categories),
    advancedSignals: [],
    basicExamples: [],
    keywords: [],
  };
  return { meta: { ...meta, profile, minRelevance: meta.minRelevance ?? DEFAULT_MIN_RELEVANCE, categories: [] }, results: upgraded };
}

/**
 * Runs pasted before the parser knew better stored long resume LINKS (S3 / Drive
 * URLs over 150 characters) as resume TEXT, and every such resume came back "not a
 * resume" without ever being opened. Move each link back to `resumeUrl` and drop
 * those verdicts, so the resumes are screened properly.
 */
function repairLinks(
  meta: BenchmarkRunMeta,
  results: Record<string, BenchmarkResult>,
): { meta: BenchmarkRunMeta; results: Record<string, BenchmarkResult>; requeued: number; fixed: number } {
  let fixed = 0;
  let requeued = 0;
  const next = { ...results };
  const candidates = meta.candidates.map((c) => {
    const link = !c.resumeUrl ? linkOnly(c.resumeText) : "";
    if (!link) return c;
    fixed++;
    const r = next[c.id];
    if (r && (r.status === "invalid" || r.status === "error") && (r.source === "pasted" || !r.source)) {
      delete next[c.id];
      requeued++;
    }
    return { ...c, resumeUrl: link, resumeText: undefined };
  });
  return { meta: fixed ? { ...meta, candidates } : meta, results: next, requeued, fixed };
}

/**
 * Benchmark Projects — type a domain ("Generative AI", "MERN Stack" …), paste
 * resumes (raw text separated by numbers, or sheet rows with links), screen every
 * resume for that domain's industry-standard projects that meet the ≥15 LPA bar,
 * and download them grouped by the domain's sub-areas as a Markdown file for Notion.
 */
export function ProjectBenchmarks({ runId, autoStart, onDone, onOpenRun }: ProjectBenchmarksProps) {
  const [id] = React.useState(() => runId || newBenchmarkRunId());
  const [loading, setLoading] = React.useState(Boolean(runId));
  const [stage, setStage] = React.useState<"setup" | "results">("setup");
  const [name, setName] = React.useState("");
  const [domainInput, setDomainInput] = React.useState("");
  const [focusInput, setFocusInput] = React.useState("");
  const [profile, setProfile] = React.useState<BenchmarkDomainProfile | null>(null);
  const [preparing, setPreparing] = React.useState(false);
  const [createdAt, setCreatedAt] = React.useState(() => new Date().toISOString());
  const [settings, setSettings] = React.useState<ExportSettings>(DEFAULT_SETTINGS);
  const [concurrency, setConcurrency] = React.useState(DEFAULT_CONCURRENCY);
  const [batches, setBatches] = React.useState<BenchmarkBatch[]>([]);
  const [candidates, setCandidates] = React.useState<BenchmarkCandidateInput[]>([]);
  const [results, setResults] = React.useState<Record<string, BenchmarkResult>>({});
  const [running, setRunning] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [retrying, setRetrying] = React.useState(0);
  const [storageError, setStorageError] = React.useState("");
  const [firstRows, setFirstRows] = React.useState<BenchmarkCandidateInput[]>([]);
  const [error, setError] = React.useState("");
  // Shown on the results page after a saved run was repaired on opening.
  const [notice, setNotice] = React.useState("");
  // Leaving from the sidebar mid-run asks first.
  useReportBusy(running);

  // The run loop outlives renders: it reads and writes through refs, and the UI
  // is refreshed on a short timer instead of once per resume.
  const resultsRef = React.useRef<Record<string, BenchmarkResult>>({});
  const queueRef = React.useRef<Job[]>([]);
  const abortRef = React.useRef(false);
  const runningRef = React.useRef(false);
  const counters = React.useRef({ active: 0, retrying: 0 });
  const meta = React.useRef({ name, createdAt, profile, settings, concurrency, batches, candidates });
  meta.current = { name, createdAt, profile, settings, concurrency, batches, candidates };
  const autoStarted = React.useRef(false);

  const saveMeta = React.useCallback(async () => {
    const m = meta.current;
    if (!m.profile) return;
    const { totals } = consolidateBenchmarks(m.candidates, resultsRef.current, m.profile, {
      minScore: m.settings.minScore,
      minRelevance: m.settings.minRelevance,
      categories: m.settings.categories,
    });
    const errors = m.candidates.filter((c) => resultsRef.current[c.id]?.status === "error").length;
    const record: BenchmarkRunMeta = {
      id,
      name: m.name.trim() || defaultTitle(m.profile.domain),
      createdAt: m.createdAt,
      updatedAt: new Date().toISOString(),
      profile: m.profile,
      concurrency: m.concurrency,
      minScore: m.settings.minScore,
      minRelevance: m.settings.minRelevance,
      categories: m.settings.categories,
      showSources: m.settings.showSources,
      batches: m.batches,
      candidates: m.candidates,
      stats: { screened: totals.screened, withProjects: totals.withProjects, projects: totals.projects, errors },
    };
    const ok = await saveBenchmarkRunMeta(record);
    if (!ok) setStorageError("The browser refused to save this run (storage full or private mode). Download the .md now.");
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

  const screenOne = async (c: BenchmarkCandidateInput): Promise<BenchmarkResult> => {
    try {
      const res = await fetch("/api/benchmarks/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate: c, profile: meta.current.profile }),
      });
      const text = await res.text();
      let data: { result?: BenchmarkResult; error?: string } = {};
      try {
        data = JSON.parse(text);
      } catch {
        // A cut-off / non-JSON reply (server restarting, proxy hiccup) — transient, so retry.
        return failedBenchmark(c, `${NETWORK_PREFIX}: unreadable reply from the server (HTTP ${res.status}) — re-run this resume.`, true);
      }
      if (!res.ok || !data.result) return failedBenchmark(c, data.error || `Server returned HTTP ${res.status}`, res.status >= 500);
      return data.result;
    } catch (err) {
      return failedBenchmark(c, `${NETWORK_PREFIX}: ${err instanceof Error ? err.message : "request failed"} — re-run this resume.`, true);
    }
  };

  /**
   * Screen `targets` with a rolling window of `concurrency` requests. Each result
   * is saved the moment it arrives; a resume that failed only on rate limits goes
   * back in the queue after a pause. Called while a run is going, it just adds the
   * targets to the live queue.
   */
  const analyze = React.useCallback(
    async (targets: BenchmarkCandidateInput[]) => {
      if (!targets.length || !meta.current.profile) return;
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
          void saveBenchmarkResult(id, result).then((ok) => {
            if (!ok) setStorageError("The browser refused to save results (storage full?). Download the .md now.");
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

  // Reopen a saved run (and, for a run just created for another domain, start it).
  React.useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    getBenchmarkRun(runId)
      .then((saved) => {
        if (cancelled || !saved) return;
        const upgraded = upgradeLegacy(saved.meta, saved.results);
        const { meta: m, results: r, requeued, fixed } = repairLinks(upgraded.meta, upgraded.results);
        if (fixed) {
          setNotice(
            `${fixed.toLocaleString("en-IN")} resume link${fixed === 1 ? " was" : "s were"} read as text in this run, so ` +
              `${requeued.toLocaleString("en-IN")} resume${requeued === 1 ? " was" : "s were"} wrongly marked "not a resume" ` +
              `without being opened. Fixed — they are queued again; click "Screen ${requeued.toLocaleString("en-IN")} for ${m.profile.domain}".`,
          );
        }
        meta.current = {
          name: m.name,
          createdAt: m.createdAt,
          profile: m.profile,
          settings: {
            minScore: m.minScore || DEFAULT_MIN_SCORE,
            minRelevance: m.minRelevance || DEFAULT_MIN_RELEVANCE,
            categories: m.categories ?? [],
            showSources: Boolean(m.showSources),
          },
          concurrency: m.concurrency || DEFAULT_CONCURRENCY,
          batches: m.batches,
          candidates: m.candidates,
        };
        setName(m.name);
        setCreatedAt(m.createdAt);
        setProfile(m.profile);
        setSettings(meta.current.settings);
        setConcurrency(meta.current.concurrency);
        setBatches(m.batches);
        setCandidates(m.candidates);
        resultsRef.current = r;
        setResults(r);
        setStage("results");
        // Keep the repaired resume links (the stale verdicts are overwritten as the resumes are re-screened).
        if (fixed) void saveMeta();
        if (autoStart && !autoStarted.current && m.profile.keywords.length) {
          autoStarted.current = true;
          const pending = m.candidates.filter((c) => !r[c.id]);
          if (pending.length) void analyze(pending);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not open the saved run."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [runId, autoStart, analyze, saveMeta]);

  /** Re-screen: drop the old results first so the counts reflect the new attempt. */
  const run = (targets: BenchmarkCandidateInput[]) => {
    for (const c of targets) delete resultsRef.current[c.id];
    setResults({ ...resultsRef.current });
    void analyze(targets);
  };

  const start = async () => {
    setError("");
    if (!firstRows.length || !domainInput.trim()) return;
    setPreparing(true);
    const { profile: p, error: err } = await fetchProfile(domainInput, focusInput);
    setPreparing(false);
    if (!p) {
      setError(err || "Could not prepare the domain.");
      return;
    }
    const now = new Date().toISOString();
    const b: BenchmarkBatch[] = [{ n: 1, addedAt: now, count: firstRows.length }];
    const title = name.trim() || defaultTitle(p.domain);
    meta.current = { ...meta.current, name: title, profile: p, batches: b, candidates: firstRows, createdAt: now };
    setName(title);
    setProfile(p);
    setCreatedAt(now);
    setBatches(b);
    setCandidates(firstRows);
    resultsRef.current = {};
    setResults({});
    await saveMeta();
    setStage("results");
    void analyze(firstRows);
  };

  const addBatch = async (rows: BenchmarkCandidateInput[]) => {
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

  /** A new run on these same resumes for another domain — saved, then opened and started. */
  const screenForDomain = async (domain: string, focus: string): Promise<string> => {
    const { profile: p, error: err } = await fetchProfile(domain, focus);
    if (!p) return err || "Could not prepare the domain.";
    const m = meta.current;
    const now = new Date().toISOString();
    const newId = newBenchmarkRunId();
    const record: BenchmarkRunMeta = {
      id: newId,
      name: defaultTitle(p.domain),
      createdAt: now,
      updatedAt: now,
      profile: p,
      concurrency: m.concurrency,
      minScore: m.settings.minScore,
      minRelevance: m.settings.minRelevance,
      categories: [],
      showSources: m.settings.showSources,
      batches: m.batches,
      candidates: m.candidates,
      stats: { screened: 0, withProjects: 0, projects: 0, errors: 0 },
    };
    const ok = await saveBenchmarkRunMeta(record);
    if (!ok) return "The browser refused to save the new run (storage full or private mode).";
    onOpenRun(newId, true);
    return "";
  };

  const changeSettings = (next: ExportSettings) => {
    meta.current = { ...meta.current, settings: next };
    setSettings(next);
    scheduleMeta();
  };

  const changeConcurrency = (n: number) => {
    meta.current = { ...meta.current, concurrency: n };
    setConcurrency(n);
    scheduleMeta();
  };

  if (loading) {
    return (
      <div role="status" className="flex items-center justify-center gap-2 rounded-xl border bg-card py-16 text-sm text-muted-foreground shadow-surface">
        <Loader2 className="h-4 w-4 animate-spin" /> Opening the saved run…
      </div>
    );
  }

  if (stage === "results" && profile) {
    return (
      <BenchmarkResults
        title={name || defaultTitle(profile.domain)}
        profile={profile}
        candidates={candidates}
        results={results}
        batches={batches}
        settings={settings}
        onSettingsChange={changeSettings}
        running={running}
        active={active}
        retrying={retrying}
        concurrency={concurrency}
        onConcurrencyChange={changeConcurrency}
        onRun={run}
        onStop={() => {
          abortRef.current = true;
        }}
        onBack={onDone}
        onAddBatch={(rows) => void addBatch(rows)}
        onScreenForDomain={screenForDomain}
        storageError={storageError}
        notice={notice}
      />
    );
  }

  const domain = domainInput.trim();
  return (
    <div className="max-w-3xl space-y-6">
      <Panel
        title="Domain"
        icon={<Target />}
        description="Only this domain's projects are picked, and the export is grouped by its sub-areas."
      >
        <div className="grid gap-5">
          <Field
            label="Domain or tech stack"
            htmlFor="bench-domain"
            info={
              <>
                Everything is judged against this domain: only its projects are picked, the 15+ LPA bar is set by what
                production-grade work looks like in it, and the export is grouped by its sub-areas. Projects from other
                domains are ignored.
              </>
            }
          >
            <Input
              id="bench-domain"
              placeholder="e.g. Generative AI"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="mr-0.5 text-xs text-muted-foreground">Examples:</span>
              {DOMAIN_EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setDomainInput(ex)}
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25",
                    domain === ex
                      ? "border-primary/40 bg-accent text-accent-foreground"
                      : "bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {ex}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Focus" optional htmlFor="bench-focus" hint="What to include or leave out.">
            <Textarea
              id="bench-focus"
              className="min-h-[72px]"
              placeholder="e.g. RAG, AI agents and fine-tuning; leave out computer vision"
              value={focusInput}
              onChange={(e) => setFocusInput(e.target.value)}
            />
          </Field>
        </div>
      </Panel>

      <Panel
        title="Batch 1 resumes"
        icon={<FileText />}
        description="Each resume starts with its number on its own line. More batches can be added from the results."
        actions={
          <InfoHint align="end" label="About pasting resumes">
            Paste the resumes one after another, each starting with its number (serial or mobile number) on its own
            line, or rows copied from a sheet with a number and a resume link or resume text. Thousands at a time is
            fine. Resume links must be shared with the service account or be public. One run holds the whole pool, and
            the export covers every batch.
          </InfoHint>
        }
      >
        <BenchmarkPaste batch={1} existing={NO_EXISTING} onParsed={setFirstRows} />
      </Panel>

      <Disclosure title="How resumes are screened" summary="5 rules">
        <p className="text-[13px] text-muted-foreground">
          Each resume is read by a Senior Technical Recruiter / Principal Architect prompt for {domain || "your domain"}.
        </p>
        <ul className="mt-3 space-y-2 text-[13px] leading-relaxed">
          <li>
            <span className="font-medium">Domain first.</span>{" "}
            <span className="text-muted-foreground">
              Only {domain || "the domain"}&apos;s projects count; work from other domains is ignored however good it is.
            </span>
          </li>
          <li>
            <span className="font-medium">15+ LPA quality filter.</span>{" "}
            <span className="text-muted-foreground">
              Only complex, production-grade {domain || "domain"} projects, judged against what advanced work looks like
              in that domain.
            </span>
          </li>
          <li>
            <span className="font-medium">Basic projects ignored.</span>{" "}
            <span className="text-muted-foreground">
              The domain&apos;s tutorial-level and overdone projects, plus calculators, to-do lists, CRUD apps and UI
              clones.
            </span>
          </li>
          <li>
            <span className="font-medium">Quality over quantity.</span>{" "}
            <span className="text-muted-foreground">Every project that meets the bar, none that doesn&apos;t.</span>
          </li>
          <li>
            <span className="font-medium">Links ignored.</span>{" "}
            <span className="text-muted-foreground">
              Judged only on the description, features and tech stack. Each project must be traceable to the resume
              text, so nothing is invented.
            </span>
          </li>
        </ul>
      </Disclosure>

      <Disclosure title="Advanced options" summary={`${concurrency} at a time${name.trim() ? " · custom title" : ""}`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title of the Notion page" optional htmlFor="bench-name">
            <Input
              id="bench-name"
              placeholder={defaultTitle(domain || "<Domain>")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Resumes screened in parallel" htmlFor="bench-conc">
            <NativeSelect id="bench-conc" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>
              {CONCURRENCY_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} at a time{n === DEFAULT_CONCURRENCY ? " (recommended)" : ""}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
      </Disclosure>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <ActionBar
        status={
          !domain ? (
            "Type the domain to screen for."
          ) : firstRows.length ? (
            <>
              <span className="font-medium tabular-nums text-foreground">{firstRows.length}</span> resumes ready to screen
              for {domain}.
            </>
          ) : (
            "Paste at least one resume."
          )
        }
      >
        <Button
          size="lg"
          className="h-auto min-h-11 whitespace-normal py-2 text-left"
          onClick={start}
          disabled={!firstRows.length || !domain || preparing}
        >
          {preparing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {preparing ? `Preparing ${domain}…` : `Find ${domain || "domain"} benchmark projects`}
        </Button>
      </ActionBar>
    </div>
  );
}
