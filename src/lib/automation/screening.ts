import "server-only";
import { databaseConfigured } from "@/lib/db/client";
import { screenDomainCandidate, type DomainScreenResult } from "@/lib/domain-screen";
import { shortlistBar } from "@/lib/domain-scoring";
import { runQueue } from "@/lib/parallel-queue";
import { isAssessed, standingFor } from "@/lib/pool/match";
import { normalisePhone, normaliseUserId } from "@/lib/pool/parse";
import { lookupStandings } from "@/lib/pool/queries";
import { getSheets } from "@/lib/sheets";
import { withSheetsRetry } from "@/lib/automation/control-sheet";
import { JobError } from "@/lib/automation/errors";
import { candidateCount, insertCandidates, loadCandidates, logEvent, saveScreening, type CandidateCheckpoint } from "@/lib/automation/store";
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
 */

const q = (tab: string) => `'${tab.replace(/'/g, "''")}'`;
const CANDIDATE_MS = 180_000;
/** Screening attempts per resume before it counts as "couldn't be screened". */
export const MAX_SCREEN_ATTEMPTS = 5;
/** Pause before the n-th retry of a resume that failed for a passing reason. */
const RETRY_DELAYS_MS = [60_000, 3 * 60_000, 10 * 60_000, 30 * 60_000];
/** Stop retrying passing failures this long after the job started (the rest are reported as unscored). */
export const SCREEN_DEADLINE_MS = 12 * 3600_000;

const concurrency = () => Math.min(8, Math.max(1, Number(process.env.AUTOMATION_CONCURRENCY) || 4));

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
      rows.push({
        key,
        tab: tab.name,
        sheetRow,
        row: {
          id: userId || key,
          phone: get(r, idx.phoneColumn),
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
    })
      .catch((err): ScreenOut => ({ ok: false, kind: "error", error: err instanceof Error ? err.message : "screening failed", retryable: true }))
      .finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

/** Screen every candidate still to do; returns when none is left to try (or the deadline passed). */
export async function screenCandidates(ctx: RunContext): Promise<void> {
  const deadline = new Date(ctx.job.startedAt ?? ctx.job.createdAt).getTime() + SCREEN_DEADLINE_MS;
  for (;;) {
    const all = await loadCandidates(ctx.job.id);
    const live = all.filter((c) => c.state !== "duplicate");
    const counts = () => ({
      read: live.length,
      screened: live.filter((c) => c.state === "screened" || c.state === "invalid" || (c.state === "error" && !c.retryable)).length,
      matches: live.filter((c) => c.state === "screened" && c.candidate && c.candidate.domainScore >= shortlistBar({ ...c.candidate, internal: c.internal })).length,
    });
    const now = Date.now();
    const due = live.filter((c) => c.state === "pending" || (c.state === "error" && c.retryable && (!c.nextTryAt || Date.parse(c.nextTryAt) <= now)));
    const later = live.filter((c) => c.state === "error" && c.retryable && c.nextTryAt && Date.parse(c.nextTryAt) > now);
    await ctx.beat("screening", counts(), true);
    if (!due.length) {
      if (!later.length || now > deadline) return;
      const next = Math.min(...later.map((c) => Date.parse(c.nextTryAt!)));
      await ctx.wait("screening", Math.min(Math.max(next - now, 5_000), deadline - now), { note: `${later.length} to retry` });
      continue;
    }
    // Every checkpoint write is awaited before the next pass reads them back.
    const saves: Promise<unknown>[] = [];
    await runQueue<CandidateCheckpoint, ScreenOut>({
      items: due,
      concurrency,
      stopped: () => ctx.stopped,
      run: (cp) => screenOne(cp, ctx),
      // One quick in-queue retry for a passing failure; after that it waits its turn (next_try_at).
      retryAfter: (res, attempt) => (!res.ok && res.retryable && attempt <= 1 ? 20_000 : null),
      onDone: (cp, res) => {
        const save = res.ok
          ? (() => {
              res.candidate.internal = cp.internal;
              cp.state = "screened";
              cp.candidate = res.candidate;
              return saveScreening(ctx.job.id, cp.key, { state: "screened", candidate: res.candidate, githubState: "none" });
            })()
          : res.kind === "invalid"
            ? ((cp.state = "invalid"), saveScreening(ctx.job.id, cp.key, { state: "invalid", error: res.error }))
            : (() => {
                const attempts = cp.attempts + 1;
                const retry = res.retryable && attempts < MAX_SCREEN_ATTEMPTS && Date.now() < deadline;
                cp.state = "error";
                cp.retryable = retry;
                cp.attempts = attempts;
                const nextTryAt = retry ? new Date(Date.now() + RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]) : null;
                cp.nextTryAt = nextTryAt?.toISOString() ?? null;
                return saveScreening(ctx.job.id, cp.key, { state: "error", error: res.error, retryable: retry, nextTryAt });
              })();
        saves.push(save.catch((err) => console.warn(`[automation] checkpoint save failed for ${cp.key}:`, err instanceof Error ? err.message : err)));
        ctx.beat("screening", counts()).catch(() => undefined);
      },
    });
    await Promise.all(saves);
    if (ctx.stopped) return;
  }
}
