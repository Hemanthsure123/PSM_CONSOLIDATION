"use client";

import * as React from "react";
import { Award, FileSpreadsheet, Loader2, Play, Target, Users } from "lucide-react";
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
import { Stat, StatGrid } from "@/components/ui/stat";
import { SettingList, SettingRow } from "@/components/ui/setting-row";
import { SpDsaBarPanel, SpRulesCard } from "@/components/showcase/showcase-rules";
import { ProfilePanel } from "@/components/showcase/profile-panel";
import { newProfile, profileReady, runDsaBar } from "@/lib/showcase/profile-rules";
import { SP_CONCURRENCY_OPTIONS, ShowcaseResults, type SpLaneProgress } from "@/components/showcase/showcase-results";
import { previewAcademySheet, readAcademyTabs, type AcademySheetPreview } from "@/actions/academy";
import { runQueue } from "@/lib/parallel-queue";
import { buildSpDataset, pickCandidateTab } from "@/lib/showcase/parse";
import { SP_LANES, laneSize, planShowcase, type SpLane, type SpPlan } from "@/lib/showcase/pipeline";
import { rankShowcase } from "@/lib/showcase/scoring";
import { getSpRun, lastSpLink, newSpRunId, rememberSpLink, saveSpDataset, saveSpRecords, saveSpRunMeta } from "@/lib/showcase/store";
import {
  DEFAULT_SP_RULES,
  SP_VERSIONS,
  withSpDefaults,
  type SpCandidate,
  type SpDataset,
  type SpDsaPlatform,
  type SpJudge,
  type SpProbe,
  type SpProfileDef,
  type SpRead,
  type SpRecord,
  type SpRules,
  type SpRunMeta,
  type SpScreen,
  type SpTrust,
  type SpVerify,
} from "@/lib/showcase/types";
import type { DsaPlatform } from "@/lib/dsa-types";

interface Props {
  /** Reopen a saved run; omit to start a new one. */
  runId?: string | null;
  onDone: () => void;
}

const UI_FLUSH_MS = 800;
const SAVE_MS = 1_000;
const META_SAVE_MS = 3_000;
const DEFAULT_CONCURRENCY = 6;
/** Passes over the stages per Start / Continue — a retried candidate gets another go in the next pass. */
const PASSES = 3;
const MAX_WAIT_MS = 15 * 60_000;
const NETWORK = "Network error";

type Reply<T> = { ok: true; data: T } | { ok: false; error: string; retryable: boolean };

async function post<T>(url: string, body: unknown): Promise<Reply<T>> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: `${NETWORK}: unreadable reply (HTTP ${res.status})`, retryable: true };
    }
    if (!res.ok) return { ok: false, error: (data as { error?: string })?.error || `HTTP ${res.status}`, retryable: res.status >= 500 };
    return { ok: true, data: data as T };
  } catch (err) {
    return { ok: false, error: `${NETWORK}: ${err instanceof Error ? err.message : "request failed"}`, retryable: true };
  }
}

const chunks = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const now = () => new Date().toISOString();
const failedScreen = (c: SpCandidate, error: string): SpScreen => ({
  id: c.id,
  status: "error",
  error,
  retryable: true,
  resumeUrl: c.resumeUrl,
  sha: "",
  source: "",
  links: { githubProfile: "", githubRepos: [], leetcode: "", codeforces: "", codechef: "", urls: [] },
  namedWithoutLink: [],
  inferred: [],
  fromSheet: [],
  candidateId: "",
  version: SP_VERSIONS.screen,
});
const failedRead = (id: string, error: string, retryable: boolean): SpRead => ({
  id,
  status: "error",
  error,
  retryable,
  nameOnResume: "",
  education: { degree: "", institution: "", year: "" },
  projects: [],
  jobs: [],
  skills: [],
  skillKeys: [],
  checks: [],
  model: "",
  transcribed: false,
  textChars: 0,
  version: SP_VERSIONS.read,
  readAt: now(),
});
const failedProbe = (login: string, note: string): SpProbe => ({ status: "failed", note, login, name: "", createdAt: "", repos: [], checkedAt: now(), retryAfterMs: 5_000 });
const failedVerify = (id: string, error: string): SpVerify => ({ id, status: "error", error, retryable: true, proofs: [], dsa: {}, version: SP_VERSIONS.verify, checkedAt: now() });
const failedTrust = (id: string, error: string): SpTrust => ({ id, identity: null, review: null, error, retryable: true, version: SP_VERSIONS.trust });
const failedJudge = (x: { id: string; basedOn: string; readAt: string }, error: string, retryable: boolean): SpJudge => ({
  id: x.id,
  status: "error",
  error,
  retryable,
  basedOn: x.basedOn,
  readAt: x.readAt,
  profiles: {},
  model: "",
  version: SP_VERSIONS.judge,
  checkedAt: now(),
});
type Mode = "roles" | "profiles";
/** The profiles a run ranks by (null = roles found in the evidence). */
const activeProfiles = (mode: Mode, profiles: SpProfileDef[]) => (mode === "profiles" && profiles.length ? profiles : null);

/** Read the sheet (view only); the candidate tab is recognised unless chosen. */
async function loadSheet(url: string, chosen = ""): Promise<{ ok: true; dataset: SpDataset; preview: AcademySheetPreview; tab: string } | { ok: false; error: string }> {
  const p = await previewAcademySheet(url.trim());
  if (!p.ok) return { ok: false, error: p.error };
  const tab = chosen && p.data.tabs.some((t) => t.name === chosen) ? chosen : pickCandidateTab(p.data.tabs);
  if (!tab) return { ok: false, error: "The sheet has no tabs." };
  const r = await readAcademyTabs(url.trim(), [tab]);
  if (!r.ok) return { ok: false, error: r.error };
  const dataset = buildSpDataset({ url: url.trim(), title: r.data.title, tab: r.data.grids[0] });
  if (!dataset.candidates.length) return { ok: false, error: `${tab} has no candidate rows.` };
  return { ok: true, dataset, preview: p.data, tab };
}

/**
 * Sample profiles — the strongest candidates per tech role, to show a company's hiring manager.
 * Load one sheet of resumes, check what was found, start; the stages run cheapest and strictest
 * first, every result is saved as it arrives, and the role tabs fill in as candidates pass.
 */
export function SampleProfiles({ runId, onDone }: Props) {
  const [id] = React.useState(() => runId || newSpRunId());
  const [loading, setLoading] = React.useState(Boolean(runId));
  const [stage, setStage] = React.useState<"setup" | "results">("setup");
  const [name, setName] = React.useState("");
  const [createdAt, setCreatedAt] = React.useState(() => now());
  const [link, setLink] = React.useState("");
  const [tab, setTab] = React.useState("");
  const [preview, setPreview] = React.useState<AcademySheetPreview | null>(null);
  const [dataset, setDataset] = React.useState<SpDataset | null>(null);
  const [rules, setRules] = React.useState<SpRules>(DEFAULT_SP_RULES);
  const [mode, setMode] = React.useState<Mode>("roles");
  const [profiles, setProfiles] = React.useState<SpProfileDef[]>(() => [newProfile("p1")]);
  const [rejected, setRejected] = React.useState<string[]>([]);
  const [concurrency, setConcurrency] = React.useState(DEFAULT_CONCURRENCY);
  const [records, setRecords] = React.useState<Record<string, SpRecord>>({});
  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState<SpLaneProgress | null>(null);
  const [sheetBusy, setSheetBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [reloadError, setReloadError] = React.useState("");
  const [storageError, setStorageError] = React.useState("");
  useReportBusy(running);

  const recordsRef = React.useRef<Record<string, SpRecord>>({});
  const abortRef = React.useRef(false);
  const runningRef = React.useRef(false);
  const progressRef = React.useRef<SpLaneProgress | null>(null);
  const meta = React.useRef({ name, createdAt, rules, rejected, concurrency, dataset, mode, profiles });
  meta.current = { name, createdAt, rules, rejected, concurrency, dataset, mode, profiles };

  React.useEffect(() => {
    if (!runId) setLink(lastSpLink());
  }, [runId]);

  React.useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    getSpRun(runId)
      .then((saved) => {
        if (cancelled || !saved) return;
        const m = saved.meta;
        setName(m.name);
        setCreatedAt(m.createdAt);
        setRules(withSpDefaults(m.rules));
        setMode(m.mode === "profiles" && m.profiles?.length ? "profiles" : "roles");
        if (m.profiles?.length) setProfiles(m.profiles);
        setRejected(m.rejected ?? []);
        setConcurrency(m.concurrency || DEFAULT_CONCURRENCY);
        recordsRef.current = saved.records;
        setRecords(saved.records);
        if (saved.dataset) {
          setDataset(saved.dataset);
          setLink(saved.dataset.source.url);
          setTab(saved.dataset.source.tab);
          setStage("results");
        } else setError("This run's sheet was not saved — load it again.");
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
    const out = rankShowcase(m.dataset, recordsRef.current, m.rules, m.rejected, activeProfiles(m.mode, m.profiles));
    const record: SpRunMeta = {
      id,
      name: m.name.trim() || "Sample profiles",
      createdAt: m.createdAt,
      updatedAt: now(),
      rules: m.rules,
      rejected: m.rejected,
      concurrency: m.concurrency,
      mode: m.mode,
      profiles: m.mode === "profiles" ? m.profiles : undefined,
      loadedAt: m.dataset.loadedAt,
      sheetTitle: m.dataset.source.title,
      stats: out.stats,
    };
    if (!(await saveSpRunMeta(record))) setStorageError("The browser refused to save this run (storage full or private mode). Download the workbooks now.");
  }, [id]);

  // Records are saved in small batches, the screen refreshed at most every UI_FLUSH_MS.
  const dirty = React.useRef(new Set<string>());
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSaves = React.useCallback(async () => {
    saveTimer.current = null;
    const ids = [...dirty.current];
    dirty.current.clear();
    if (!(await saveSpRecords(id, ids.map((k) => recordsRef.current[k]).filter(Boolean)))) setStorageError("The browser refused to save results (storage full?). Download the workbooks now.");
  }, [id]);
  const uiTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const metaTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const touch = React.useCallback(() => {
    saveTimer.current ??= setTimeout(() => void flushSaves(), SAVE_MS);
    uiTimer.current ??= setTimeout(() => {
      uiTimer.current = null;
      setRecords({ ...recordsRef.current });
      setProgress(progressRef.current ? { ...progressRef.current } : null);
    }, UI_FLUSH_MS);
    metaTimer.current ??= setTimeout(() => {
      metaTimer.current = null;
      void saveMeta();
    }, META_SAVE_MS);
  }, [flushSaves, saveMeta]);

  const update = React.useCallback(
    (cid: string, patch: (r: SpRecord) => Partial<SpRecord>) => {
      const cur = recordsRef.current[cid] ?? { id: cid };
      recordsRef.current[cid] = { ...cur, ...patch(cur) };
      dirty.current.add(cid);
      touch();
    },
    [touch],
  );

  const setLane = (lane: SpLane, total: number) => {
    progressRef.current = { lane, done: 0, total, running: 0, waiting: 0, note: "" };
    setProgress({ ...progressRef.current });
  };
  const bump = (n = 1) => {
    if (progressRef.current) progressRef.current.done += n;
    touch();
  };
  const activity = (run: number, wait: number) => {
    if (progressRef.current) progressRef.current = { ...progressRef.current, running: run, waiting: wait };
    touch();
  };
  const note = (text: string) => {
    if (progressRef.current) progressRef.current.note = text;
    touch();
  };
  const stopped = () => abortRef.current;
  const width = (cap: number) => () => Math.max(1, Math.min(cap, meta.current.concurrency));

  /** One lane of the plan. Returns how many items it finished. */
  const runLane = async (lane: SpLane, plan: SpPlan): Promise<number> => {
    const total = laneSize(plan, lane);
    if (!total) return 0;
    setLane(lane, total);
    const rules = meta.current.rules;
    const ranked = activeProfiles(meta.current.mode, meta.current.profiles);
    // Profile mode reads Codeforces for the loosest DSA bar of the run.
    const minRating = ranked ? runDsaBar(ranked).codeforces : rules.dsa.codeforces;
    let done = 0;
    const finished = () => {
      done++;
      bump();
    };

    if (lane === "screen") {
      await runQueue({
        items: plan.screen,
        concurrency: () => Math.min(12, meta.current.concurrency * 2),
        run: async (c) => {
          const r = await post<{ result: SpScreen }>("/api/showcase/screen", { candidate: c });
          return r.ok ? r.data.result : failedScreen(c, r.error);
        },
        retryAfter: (s, attempt) => (s.status === "error" && s.retryable && attempt <= 2 ? (s.error.startsWith(NETWORK) ? 4_000 : 20_000 * attempt) : null),
        stopped,
        onDone: (c, s) => {
          update(c.id, () => ({ screen: s }));
          finished();
        },
        onActivity: activity,
      });
      return done;
    }

    if (lane === "codeforces" || lane === "leetcode" || lane === "codechef") {
      const platform: DsaPlatform = lane;
      const size = platform === "codeforces" ? 50 : 5;
      await runQueue({
        items: chunks(plan.dsa[platform], size),
        concurrency: () => (platform === "leetcode" ? 2 : 1),
        run: (items) => post<{ results: Record<string, SpDsaPlatform> }>("/api/showcase/dsa", { platform, items, minRating }),
        retryAfter: (r, attempt) => (!r.ok && r.retryable && attempt <= 2 ? 10_000 * attempt : null),
        stopped,
        onDone: (items, r) => {
          if (r.ok) {
            for (const [cid, p] of Object.entries(r.data.results)) {
              // A profile that gave no answer counts its attempts, so it isn't retried forever.
              update(cid, (rec) => ({ dsa: { ...rec.dsa, [platform]: p.found === null ? { ...p, attempts: (rec.dsa?.[platform]?.attempts ?? 0) + 1 } : p } }));
            }
          }
          else note(r.error);
          done += items.length;
          bump(items.length);
        },
        onActivity: activity,
      });
      return done;
    }

    if (lane === "probe") {
      await runQueue({
        items: plan.probe,
        concurrency: width(6),
        run: async (x) => {
          const r = await post<{ result: SpProbe }>("/api/showcase/probe", { login: x.login });
          return r.ok ? r.data.result : failedProbe(x.login, r.error);
        },
        retryAfter: (p, attempt) => {
          if (p.status !== "failed" || !p.retryAfterMs || attempt > 3) return null;
          if (p.retryAfterMs > 60_000) note(`GitHub rate limit — waiting ${Math.ceil(Math.min(p.retryAfterMs, MAX_WAIT_MS) / 60_000)} min`);
          return Math.min(p.retryAfterMs, MAX_WAIT_MS);
        },
        stopped,
        onDone: (x, p) => {
          update(x.id, () => ({ probe: p }));
          finished();
        },
        onActivity: activity,
      });
      return done;
    }

    if (lane === "read") {
      await runQueue({
        items: plan.read,
        concurrency: width(12),
        run: async (x) => {
          const r = await post<{ result: SpRead }>("/api/showcase/read", x);
          return r.ok ? r.data.result : failedRead(x.id, r.error, r.retryable);
        },
        retryAfter: (r, attempt) => (r.status === "error" && r.retryable && attempt <= 2 ? (r.error.startsWith(NETWORK) ? 4_000 : 30_000 * attempt) : null),
        stopped,
        onDone: (x, r) => {
          update(x.id, () => ({ read: r }));
          finished();
        },
        onActivity: activity,
      });
      return done;
    }

    if (lane === "judge") {
      await runQueue({
        items: plan.judge,
        concurrency: width(6),
        run: async (x) => {
          const r = await post<{ result: SpJudge }>("/api/showcase/judge", x);
          return r.ok ? r.data.result : failedJudge(x, r.error, r.retryable);
        },
        retryAfter: (j, attempt) => (j.status === "error" && j.retryable && attempt <= 2 ? (j.error.startsWith(NETWORK) ? 4_000 : 30_000 * attempt) : null),
        stopped,
        onDone: (x, j) => {
          update(x.id, () => ({ judge: j }));
          finished();
        },
        onActivity: activity,
      });
      return done;
    }

    if (lane === "verify") {
      await runQueue({
        items: plan.verify,
        concurrency: width(3),
        run: async (x) => {
          const r = await post<{ result: SpVerify }>("/api/showcase/verify", x);
          return r.ok ? r.data.result : failedVerify(x.id, r.error);
        },
        retryAfter: (v, attempt) => {
          if (v.status !== "error" || !v.retryable || attempt > 3) return null;
          if (v.retryAfterMs) {
            if (v.retryAfterMs > 60_000) note(`GitHub rate limit — waiting ${Math.ceil(Math.min(v.retryAfterMs, MAX_WAIT_MS) / 60_000)} min`);
            return Math.min(v.retryAfterMs, MAX_WAIT_MS);
          }
          return v.error.startsWith(NETWORK) ? 4_000 : 30_000 * attempt;
        },
        stopped,
        onDone: (x, v) => {
          update(x.id, (rec) => ({ verify: { ...v, basedOn: rec.read?.readAt } }));
          finished();
        },
        onActivity: activity,
      });
      return done;
    }

    // trust
    await runQueue({
      items: plan.trust,
      concurrency: width(4),
      run: async (x) => {
        const r = await post<{ result: SpTrust }>("/api/showcase/trust", x);
        return r.ok ? r.data.result : failedTrust(x.id, r.error);
      },
      retryAfter: (t, attempt) => (!t.review && t.retryable && attempt <= 2 ? (t.error.startsWith(NETWORK) ? 4_000 : 30_000 * attempt) : null),
      stopped,
      onDone: (x, t) => {
        update(x.id, (rec) => ({ trust: { ...t, basedOn: rec.verify?.checkedAt } }));
        finished();
      },
      onActivity: activity,
    });
    return done;
  };

  /** Every stage in order, re-planned before each, a few passes so retried candidates move on. */
  const run = React.useCallback(async () => {
    const ds = meta.current.dataset;
    if (!ds || runningRef.current) return;
    runningRef.current = true;
    abortRef.current = false;
    setRunning(true);
    try {
      for (let pass = 0; pass < PASSES && !abortRef.current; pass++) {
        let moved = 0;
        for (const lane of SP_LANES) {
          if (abortRef.current) break;
          const m = meta.current;
          const plan = planShowcase(rankShowcase(ds, recordsRef.current, m.rules, m.rejected, activeProfiles(m.mode, m.profiles)), m.rules);
          moved += await runLane(lane, plan);
        }
        if (!moved) break;
      }
    } finally {
      runningRef.current = false;
      progressRef.current = null;
      setRunning(false);
      setProgress(null);
      await flushSaves();
      setRecords({ ...recordsRef.current });
      void saveMeta();
    }
    // runLane only uses refs and stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flushSaves, saveMeta]);

  const load = async (chosen = "") => {
    setError("");
    if (!link.trim()) {
      setError("Paste the sheet link first.");
      return;
    }
    setSheetBusy(true);
    try {
      const r = await loadSheet(link, chosen);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setDataset(r.dataset);
      setPreview(r.preview);
      setTab(r.tab);
      rememberSpLink(link.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the sheet.");
    } finally {
      setSheetBusy(false);
    }
  };

  const reload = async () => {
    const ds = meta.current.dataset;
    if (!ds) return;
    setReloadError("");
    setSheetBusy(true);
    try {
      const r = await loadSheet(ds.source.url, ds.source.tab);
      if (!r.ok) {
        setReloadError(`Sheet not reloaded — ${r.error}`);
        return;
      }
      meta.current = { ...meta.current, dataset: r.dataset };
      setDataset(r.dataset);
      if (!(await saveSpDataset(id, r.dataset))) setStorageError("The browser refused to save the reloaded sheet (storage full?).");
      await saveMeta();
    } catch (err) {
      setReloadError(err instanceof Error ? err.message : "Could not reload the sheet.");
    } finally {
      setSheetBusy(false);
    }
  };

  const start = async () => {
    if (!dataset) return;
    const t = now();
    meta.current = { ...meta.current, createdAt: t };
    setCreatedAt(t);
    if (!(await saveSpDataset(id, dataset))) setStorageError("The browser refused to save the sheet (storage full or private mode). Download the workbooks when done.");
    await saveMeta();
    setStage("results");
    void run();
  };

  const changeRules = (next: SpRules) => {
    meta.current = { ...meta.current, rules: next };
    setRules(next);
    touch();
  };
  const changeProfiles = (next: SpProfileDef[]) => {
    meta.current = { ...meta.current, profiles: next };
    setProfiles(next);
    touch();
  };
  const toggleReject = (cid: string) => {
    const next = meta.current.rejected.includes(cid) ? meta.current.rejected.filter((x) => x !== cid) : [...meta.current.rejected, cid];
    meta.current = { ...meta.current, rejected: next };
    setRejected(next);
    void saveMeta();
  };
  const changeConcurrency = (n: number) => {
    meta.current = { ...meta.current, concurrency: n };
    setConcurrency(n);
    touch();
  };

  const found = React.useMemo(() => {
    if (!dataset) return null;
    const c = dataset.candidates;
    const plan = planShowcase(rankShowcase(dataset, {}, rules, [], activeProfiles(mode, profiles)), rules);
    return {
      rows: c.length,
      withResume: c.filter((x) => x.resumeUrl).length,
      github: c.filter((x) => x.sheetLinks.github).length,
      dsa: c.filter((x) => x.sheetLinks.leetcode || x.sheetLinks.codeforces || x.sheetLinks.codechef).length,
      toScreen: plan.screen.length,
    };
  }, [dataset, rules, mode, profiles]);
  const profilesOk = mode === "roles" || (profiles.length > 0 && profiles.every(profileReady));

  if (loading) {
    return (
      <div role="status" className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-primary" /> Opening the saved run…
      </div>
    );
  }

  if (stage === "results" && dataset) {
    return (
      <ShowcaseResults
        title={name || "Sample profiles"}
        dataset={dataset}
        records={records}
        rules={rules}
        onRulesChange={changeRules}
        profiles={activeProfiles(mode, profiles)}
        onProfilesChange={changeProfiles}
        rejected={rejected}
        onToggleReject={toggleReject}
        running={running}
        progress={progress}
        concurrency={concurrency}
        onConcurrencyChange={changeConcurrency}
        onRun={() => void run()}
        onStop={() => {
          abortRef.current = true;
        }}
        onReload={() => void reload()}
        reloading={sheetBusy}
        reloadError={reloadError}
        storageError={storageError}
      />
    );
  }

  const detected = dataset ? (Object.entries(dataset.detected) as [keyof SpDataset["detected"], string][]) : [];
  const FIELD: Record<keyof SpDataset["detected"], string> = {
    name: "Name",
    email: "Email",
    mobile: "Mobile",
    resume: "Resume",
    github: "GitHub",
    leetcode: "LeetCode",
    codeforces: "Codeforces",
    codechef: "CodeChef",
    college: "College",
    degree: "Degree",
    yog: "Year",
  };

  return (
    <div className="max-w-3xl space-y-6">
      <Panel icon={<Award />} title="Run" description="One run holds the whole sheet. Reload it any time from the results.">
        <Field label="Run name" htmlFor="sp-name">
          <Input id="sp-name" placeholder="e.g. Sample profiles — Oct 2026 batch" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </Panel>

      <Panel
        icon={<FileSpreadsheet />}
        title="Sheet of resumes"
        description={
          <>
            Read only — nothing is written to the sheet.{" "}
            <InfoHint label="About the sheet" align="start">
              Share it with the service account (Viewer). Columns are recognised by their headers: name, email, mobile, resume link, and — if the
              sheet has them — GitHub, LeetCode, Codeforces, CodeChef, college, degree, year. Links in the resume are read too; the sheet&apos;s
              columns only fill what the resume doesn&apos;t link. Repeated rows (same email or mobile) are read once.
            </InfoHint>
          </>
        }
        footer={
          <>
            <span className="flex-1 text-[13px] text-muted-foreground">{dataset ? `Read ${dataset.candidates.length} candidates.` : "Thousands of rows are fine — the stages are paced and saved as they go."}</span>
            <Button variant="outline" onClick={() => void load(tab)} disabled={sheetBusy || !link.trim()}>
              {sheetBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />} {dataset ? "Load again" : "Load sheet"}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <Field label="Google Sheets link" htmlFor="sp-link">
            <Input
              id="sp-link"
              placeholder="https://docs.google.com/spreadsheets/d/…"
              value={link}
              onChange={(e) => {
                setLink(e.target.value);
                setDataset(null);
                setPreview(null);
              }}
            />
          </Field>
          {preview && dataset ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-[13px]">
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">{preview.title}</span> › tab
              </span>
              <NativeSelect aria-label="Tab with the candidates" value={tab} disabled={sheetBusy} onChange={(e) => void load(e.target.value)} className="h-8 text-[13px]" wrapperClassName="min-w-0 max-w-full">
                {preview.tabs.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}
        </div>
      </Panel>

      {error ? <Notice tone="danger">{error}</Notice> : null}
      {dataset?.warnings.map((w) => (
        <Notice key={w} tone="warning">
          {w}
        </Notice>
      ))}

      {dataset && found ? (
        <Panel icon={<Users />} title="What was found" description="Every row with a resume is screened; only the strongest go on to the expensive checks.">
          <StatGrid cols={4}>
            <Stat label="Rows" value={found.rows} />
            <Stat label="With a resume link" value={found.withResume} tone="highlight" hint={`${found.rows - found.withResume} without`} />
            <Stat label="GitHub in the sheet" value={found.github} hint="the resume's links count too" />
            <Stat label="DSA profile in the sheet" value={found.dsa} hint="the resume's links count too" />
          </StatGrid>
          <div className="mt-4 flex flex-wrap gap-1.5 text-[13px]">
            {detected.map(([k, col]) => (
              <Badge key={k} variant={col ? "secondary" : "outline"} title={col ? `Read from “${col}”` : "No such column"}>
                {FIELD[k]}: {col || "—"}
              </Badge>
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel icon={<Target />} title="What to look for">
        <SettingList>
          <SettingRow
            id="sp-mode"
            title="Sample profiles from job descriptions"
            description={
              mode === "profiles"
                ? "Each profile comes from a JD: its definition, mandatory items and every input are drafted for you to review."
                : "Off: the strongest profiles in every tech role the evidence shows, with the rules below."
            }
            info="On: you add one profile per job (up to 5). The model drafts each from the JD — domain name, a strict definition, mandatory items that must be verified, good to have, and every input (DSA bar or none, project and proof thresholds, experience, fit, cut-offs, how many to send) with its reason. Candidates are judged against each profile and listed under every profile they pass. Off: the run works as before — roles come from the evidence, with one DSA bar and one set of rules."
            checked={mode === "profiles"}
            onCheckedChange={(v) => setMode(v ? "profiles" : "roles")}
          />
        </SettingList>
      </Panel>

      {mode === "profiles" ? (
        <>
          <ProfilePanel profiles={profiles} onChange={setProfiles} />
          <Panel>
            <SettingList>
              <SettingRow
                id="sp-links-p"
                title="Profile links in the company workbook"
                description="GitHub, DSA and project links. They show the candidate's name on those sites."
                checked={rules.companyLinks}
                onCheckedChange={(v) => setRules({ ...rules, companyLinks: v })}
              />
            </SettingList>
          </Panel>
        </>
      ) : (
        <>
          <SpDsaBarPanel rules={rules} onChange={setRules} />
          <SpRulesCard rules={rules} onChange={setRules} />
        </>
      )}

      <Disclosure title="Advanced options" summary={`${concurrency} resumes at a time`}>
        <Field
          label="Resumes read in parallel"
          htmlFor="sp-conc"
          info="The model reads (and screening at twice this width). The DSA sites and GitHub are paced on their own, whatever this is set to. Rate-limited steps wait and retry automatically."
        >
          <NativeSelect id="sp-conc" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} wrapperClassName="sm:max-w-xs">
            {SP_CONCURRENCY_OPTIONS.map((n) => (
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
            ? "Load the sheet to see the candidates."
            : !name.trim()
              ? "Name the run to start."
              : !profilesOk
                ? "Give every profile a domain name and a definition — draft it from the JD."
                : `${found?.toScreen ?? 0} resumes to screen${mode === "profiles" ? ` · ${profiles.length} profile${profiles.length === 1 ? "" : "s"}` : ""} · saved as it goes.`
        }
      >
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button size="lg" onClick={() => void start()} disabled={!dataset || !name.trim() || sheetBusy || !profilesOk}>
          <Play className="h-4 w-4" /> Start
        </Button>
      </ActionBar>
    </div>
  );
}
