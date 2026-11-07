import "server-only";
import { databaseConfigured } from "@/lib/db/client";
import { screenDomainCandidate, type DomainScreenResult, type ScreenMetrics } from "@/lib/domain-screen";
import { shortlistBar } from "@/lib/domain-scoring";
import { runQueue } from "@/lib/parallel-queue";
import { isAssessed, standingFor } from "@/lib/pool/match";
import { normalisePhone, normaliseUserId } from "@/lib/pool/parse";
import { lookupStandings } from "@/lib/pool/queries";
import { getSheets } from "@/lib/sheets";
import { withSheetsRetry } from "@/lib/automation/control-sheet";
import { JobError } from "@/lib/automation/errors";
import { candidateCount, insertCandidates, loadCandidates, logEvent, saveScreening, type CandidateCheckpoint } from "@/lib/automation/store";
import { cpuGate, ioConcurrency } from "@/lib/automation/load";
import { screeningWidth } from "@/lib/automation/engine";
import { waveOf } from "@/lib/automation/ranking-bounds";
import type { RunContext } from "@/lib/automation/context";
import type { CandidateStanding, InternalStanding } from "@/lib/pool/types";
import type { DomainCandidateRow } from "@/lib/types";

/**
 * Screening agent — reads the planned tabs once into checkpoints (resume link required;
 * the same person in two tabs is screened once), matches everyone to the eligible pool
 * (internal assessments come from there automatically), then screens each resume with
 * Domain shortlisting's own scorer. A passing failure (rate limit, network) is retried with
 * growing pauses; the job carries on with the others meanwhile. Finished candidates are
 * never screened twice, even after a restart.
 *
 * Throughput on a small instance: several resumes are in flight at once (downloads and model
 * calls mostly wait), while the CPU-heavy reading of files goes through `cpuGate` one at a time.
 * Identical files and identical judgements come from the content caches (resume-cache.ts).
 */

const q = (tab: string) => `'${tab.replace(/'/g, "''")}'`;
const CANDIDATE_MS = 180_000;
/** Screening attempts per resume before it counts as "couldn't be screened". */
export const MAX_SCREEN_ATTEMPTS = 5;
/** Pause before the n-th retry of a resume that failed for a passing reason. */
const RETRY_DELAYS_MS = [60_000, 3 * 60_000, 10 * 60_000, 30 * 60_000];
/** Stop retrying passing failures this long after the job started (the rest are reported as unscored). */
export const SCREEN_DEADLINE_MS = 12 * 3600_000;

/** Resumes in flight at once: AUTOMATION_CONCURRENCY (default 6), fewer while memory is tight. */
const concurrency = () => ioConcurrency(screeningWidth(), 10);
const gate = <T,>(work: () => Promise<T>) => cpuGate.run(work);

/** Read the tabs into checkpoints (first run of the job only). */
export async function readCandidates(ctx: RunContext): Promise<void> {
  if ((await candidateCount(ctx.job.id)) > 0) return;
  const sheets = getSheets();
  const rows: { key: string; tab: string; sheetRow: number; row: DomainCandidateRow }[] = [];
  let noResume = 0;
  for (const tab of ctx.plan.tabs) {
    const res = await withSheetsRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: ctx.plan.sourceSpreadsheetId, range: q(tab.name) }));
    const all = ((res.data.values ?? []) as unknown[][]).map((r) => r.map((c) => String(c ?? "")));
    const headers = all[tab.headerRow - 1] ?? [];
    const col = (name: string) => (name ? headers.indexOf(name) : -1);
    const c = tab.columns;
    const idx = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, col(v)])) as Record<keyof typeof c, number>;
    const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
    all.slice(tab.headerRow).forEach((r, i) => {
      const sheetRow = tab.headerRow + 1 + i;
      const resumeUrl = get(r, idx.resumeColumn).match(/https?:\/\/\S+/)?.[0] ?? "";
      if (!resumeUrl) {
        if (r.some((v) => v.trim())) noResume++;
        return;
      }
      const key = `${tab.name}!${sheetRow}`;
      const userId = get(r, idx.idColumn);
      const phone = get(r, idx.phoneColumn);
      rows.push({
        key,
        tab: tab.name,
        sheetRow,
        row: {
          // The candidate's key: the mobile number, else the user id, else the sheet row.
          id: normalisePhone(phone) ?? (userId || key),
          phone,
          userId,
          name: get(r, idx.nameColumn),
          resumeUrl,
          assessmentReport: get(r, idx.assessmentColumn),
          tr1Panelist: get(r, idx.tr1PanelColumn),
          tr1PanelLinkedin: get(r, idx.tr1LinkedinColumn),
          tr1Recording: get(r, idx.tr1RecordingColumn),
          tr2Panelist: get(r, idx.tr2PanelColumn),
          tr2PanelLinkedin: get(r, idx.tr2LinkedinColumn),
          tr2Recording: get(r, idx.tr2RecordingColumn),
          placedCompany: get(r, idx.placedColumn),
          ctc: get(r, idx.ctcColumn),
        },
      });
    });
  }
  if (!rows.length) throw new JobError(`No rows with a resume link in ${ctx.plan.tabs.map((t) => `"${t.name}"`).join(", ")}.`, false);

  // Internal assessments: the eligible pool, by phone first, then user id.
  let standings: Record<string, CandidateStanding> = {};
  if (databaseConfigured()) standings = await lookupStandings(rows.map((r) => ({ phone: r.row.phone, userId: r.row.userId })));
  const internalOf = (r: DomainCandidateRow): InternalStanding | null => standingFor(standings, r.phone ?? "", r.userId ?? "");

  // One person, one screening: the first row wins, later ones point to it.
  const firstByPerson = new Map<string, string>();
  const identity = (r: DomainCandidateRow) => {
    const p = normalisePhone(r.phone ?? "");
    const u = normaliseUserId(r.userId ?? "");
    return p ? `p:${p}` : u ? `u:${u}` : `r:${r.resumeUrl.toLowerCase()}`;
  };
  // Assessed people first (TR-2, TR-1, assessment), then the sheet's order — as the screen does.
  const tierOf = (s: InternalStanding | null) => (isAssessed(s) ? s.tier : 9);
  const withInternal = rows.map((r, i) => ({ ...r, i, internal: internalOf(r.row) }));
  withInternal.sort((a, b) => tierOf(a.internal) - tierOf(b.internal) || a.i - b.i);
  let duplicates = 0;
  const items = withInternal.map((r, ord) => {
    const id = identity(r.row);
    const first = firstByPerson.get(id) ?? null;
    if (first) duplicates++;
    else firstByPerson.set(id, r.key);
    return { key: r.key, ord, sourceTab: r.tab, sourceRow: r.sheetRow, row: r.row, internal: r.internal, duplicateOf: first };
  });
  await insertCandidates(ctx.job.id, items);
  const assessed = withInternal.filter((r) => isAssessed(r.internal)).length;
  await logEvent(
    ctx.job.id,
    "screening",
    "info",
    `Read ${rows.length} rows with a resume link from ${ctx.plan.tabs.length} tab(s)${noResume ? `, ${noResume} without one` : ""}; ${duplicates} duplicates; ${assessed} internally assessed.`,
  );
}

type ScreenOut = DomainScreenResult;

async function screenOne(cp: CandidateCheckpoint, ctx: RunContext): Promise<ScreenOut> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ScreenOut>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, kind: "error", error: `Timed out after ${CANDIDATE_MS / 1000}s`, retryable: true }), CANDIDATE_MS);
  });
  return Promise.race([
    screenDomainCandidate(cp.row, {
      domain: ctx.plan.brief,
      mandatory: ctx.plan.mandatory,
      useDsa: ctx.plan.dsa.use,
      useGithub: ctx.plan.github !== "off",
      requireExperience: false,
      checkPresentation: false,
      gate,
      cache: true,
    })
      .catch((err): ScreenOut => ({ ok: false, kind: "error", error: err instanceof Error ? err.message : "screening failed", retryable: true }))
      .finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

/**
 * Screen every candidate still to do — TR-2 first, then TR-1, assessment, everyone else — in ONE
 * queue ordered by wave, so no slot sits idle at the end of a wave. When a wave (and every wave
 * before it) is finished, `afterWave` runs (the orchestrator delivers the shortlist as soon as it
 * is final) while screening carries on; its runs are serialised and an error in it stops the
 * screening and is rethrown. Returns when none is left to try, or the retry deadline passed.
 */
export async function screenCandidates(ctx: RunContext, afterWave: () => Promise<void> = async () => undefined): Promise<void> {
  const deadline = new Date(ctx.job.startedAt ?? ctx.job.createdAt).getTime() + SCREEN_DEADLINE_MS;
  const startedAt = Date.now();
  let screenedThisRun = 0;
  for (;;) {
    if (await ctx.checkStopRequested()) {
      await logEvent(ctx.job.id, "screening", "info", "Stop requested by user — halting remaining candidate screening.");
      return;
    }
    const all = await loadCandidates(ctx.job.id);
    const live = all.filter((c) => c.state !== "duplicate");
    const counts = () => ({
      read: live.length,
      screened: live.filter((c) => c.state === "screened" || c.state === "invalid" || (c.state === "error" && !c.retryable)).length,
      matches: live.filter((c) => c.state === "screened" && c.candidate && c.candidate.domainScore >= shortlistBar({ ...c.candidate, internal: c.internal })).length,
      mustHaves: live.filter(
        (c) => c.state === "screened" && c.candidate && c.candidate.meetsMandatory && c.candidate.domainScore >= shortlistBar({ ...c.candidate, internal: c.internal }),
      ).length,
    });
    const now = Date.now();
    const due = live.filter((c) => c.state === "pending" || (c.state === "error" && c.retryable && (!c.nextTryAt || Date.parse(c.nextTryAt) <= now)));
    const later = live.filter((c) => c.state === "error" && c.retryable && c.nextTryAt && Date.parse(c.nextTryAt) > now);
    await ctx.beat("screening", counts(), true);
    if (!due.length) {
      await afterWave();
      if (!later.length || now > deadline) {
        if (screenedThisRun) await logEvent(ctx.job.id, "screening", "info", timingSummary(all, Date.now() - startedAt));
        return;
      }
      const next = Math.min(...later.map((c) => Date.parse(c.nextTryAt!)));
      await ctx.wait("screening", Math.min(Math.max(next - now, 5_000), deadline - now), { note: `${later.length} to retry` });
      continue;
    }
    // Best wave first; within a wave, the sheet's order. Every checkpoint write is awaited before the next pass reads them back.
    const batch = [...due].sort((a, b) => waveOf(a.internal) - waveOf(b.internal) || a.ord - b.ord);
    const leftInWave = new Map<number, number>();
    for (const c of batch) leftInWave.set(waveOf(c.internal), (leftInWave.get(waveOf(c.internal)) ?? 0) + 1);
    const waves = [...leftInWave.keys()].sort((a, b) => a - b);
    const announced = new Set<number>();
    let chain: Promise<void> = Promise.resolve();
    let afterWaveError: { error: unknown } | null = null;
    const waveFinished = (wave: number) => {
      leftInWave.set(wave, (leftInWave.get(wave) ?? 1) - 1);
      // Announce every leading wave that is now complete (in order), once each.
      for (const w of waves) {
        if ((leftInWave.get(w) ?? 0) > 0) break;
        if (announced.has(w)) continue;
        announced.add(w);
        chain = chain.then(async () => {
          if (afterWaveError || ctx.stopped) return;
          try {
            await afterWave();
          } catch (error) {
            afterWaveError = { error };
          }
        });
      }
    };
    const saves: Promise<unknown>[] = [];
    await runQueue<CandidateCheckpoint, ScreenOut>({
      items: batch,
      concurrency,
      stopped: () => ctx.stopped || afterWaveError !== null,
      run: (cp) => screenOne(cp, ctx),
      // One quick in-queue retry for a passing failure; after that it waits its turn (next_try_at).
      retryAfter: (res, attempt) => (!res.ok && res.retryable && attempt <= 1 ? 20_000 : null),
      onDone: (cp, res) => {
        const metrics: ScreenMetrics | null = res.metrics ?? null;
        cp.metrics = metrics;
        const save = res.ok
          ? (() => {
              res.candidate.internal = cp.internal;
              cp.state = "screened";
              cp.candidate = res.candidate;
              return saveScreening(ctx.job.id, cp.key, { state: "screened", candidate: res.candidate, githubState: "none" }, metrics);
            })()
          : res.kind === "invalid"
            ? ((cp.state = "invalid"), saveScreening(ctx.job.id, cp.key, { state: "invalid", error: res.error }, metrics))
            : (() => {
                const attempts = cp.attempts + 1;
                const retry = res.retryable && attempts < MAX_SCREEN_ATTEMPTS && Date.now() < deadline;
                cp.state = "error";
                cp.retryable = retry;
                cp.attempts = attempts;
                const nextTryAt = retry ? new Date(Date.now() + RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]) : null;
                cp.nextTryAt = nextTryAt?.toISOString() ?? null;
                return saveScreening(ctx.job.id, cp.key, { state: "error", error: res.error, retryable: retry, nextTryAt }, metrics);
              })();
        screenedThisRun++;
        // The wave counts as finished for this candidate once its checkpoint is saved (afterWave reads the database).
        saves.push(
          save
            .catch((err) => console.warn(`[automation] checkpoint save failed for ${cp.key}:`, err instanceof Error ? err.message : err))
            .finally(() => waveFinished(waveOf(cp.internal))),
        );
        ctx.beat("screening", counts()).catch(() => undefined);
      },
    });
    await Promise.all(saves);
    await chain;
    if (afterWaveError) throw (afterWaveError as { error: unknown }).error;
    if (ctx.stopped) return;
    await afterWave();
  }
}

const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const secs = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

/** One line for the job's log: how long screening took and where the time went. */
export function timingSummary(all: CandidateCheckpoint[], wallMs: number): string {
  const m = all.map((c) => c.metrics).filter((x): x is ScreenMetrics => Boolean(x));
  if (!m.length) return `Screening took ${secs(wallMs)}.`;
  const models = new Map<string, number>();
  for (const x of m) if (x.scoredBy) models.set(x.scoredBy, (models.get(x.scoredBy) ?? 0) + 1);
  const modelText = [...models.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
  const read = m.filter((x) => x.readMs > 0);
  const ocr = m.filter((x) => x.ocrMs > 0);
  const judged = m.filter((x) => x.judgeMs > 0 && !x.judgementFromCache);
  return [
    `Screening took ${secs(wallMs)} for ${m.length} resumes.`,
    `Median per resume: download ${secs(median(m.map((x) => x.downloadMs)))}, read ${secs(median(read.map((x) => x.readMs)))}` +
      `, waiting for the CPU ${secs(median(m.map((x) => x.gateWaitMs)))}, AI ${secs(median(judged.map((x) => x.judgeMs)))}` +
      (ocr.length ? `, scans ${ocr.length} (median ${secs(median(ocr.map((x) => x.ocrMs)))})` : "") +
      ".",
    `From cache: ${m.filter((x) => x.textFromCache).length} files, ${m.filter((x) => x.judgementFromCache).length} judgements${ocr.length ? `, ${m.filter((x) => x.ocrFromCache).length} scans` : ""}.`,
    modelText ? `Judged by: ${modelText}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
