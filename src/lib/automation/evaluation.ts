import "server-only";
import { reviewDomainProjects } from "@/lib/domain-project-review";
import { GITHUB_BUDGET_FLOOR, shortlistBar } from "@/lib/domain-scoring";
import { inspectDomainGithub, screenDomainCandidate, type DomainScreenResult, type GithubInspectResult } from "@/lib/domain-screen";
import { BELOW_BAR_NOTE } from "@/lib/domain-csv";
import { checkGithubAccess } from "@/lib/github-analysis";
import { runQueue } from "@/lib/parallel-queue";
import { adaptiveConcurrency, cpuGate, ioConcurrency } from "@/lib/automation/load";
import { secondOpinionChain } from "@/lib/automation/engine";
import { compareOpinions, secondOpinionPicks } from "@/lib/automation/second-opinion";
import { logEvent } from "@/lib/automation/store";
import { clearsGates, contenders, type BoundsConfig } from "@/lib/automation/ranking-bounds";
import { loadCandidates, markPending, saveEvaluated, type CandidateCheckpoint } from "@/lib/automation/store";
import type { RunContext } from "@/lib/automation/context";
import type { DomainCandidate, DomainProjectReviewResult } from "@/lib/types";

/**
 * Evaluation agent — the evidence beyond the resume, exactly as Domain shortlisting gathers it:
 *  - GitHub: deep inspection of the candidates the plan's scope names (domain-fit only, or
 *    everyone with a link), paced by GitHub's hourly budget (it waits for the reset rather than
 *    failing candidates), with the account-identity check;
 *  - code review: the strongest candidates who can still be shortlisted get their top domain
 *    repos read file by file;
 *  - DSA profiles were read during screening; internal assessments came from the eligible pool.
 * Only CONTENDERS — candidates who can still reach the top N (ranking-bounds.ts, exact) — are
 * inspected and reviewed, so a top-10 run reads ~15 GitHub profiles instead of every domain
 * fit; with "(all candidates)" everyone else's GitHub is read too, after the shortlist.
 * Who was picked is stored (pending), so a restart continues the same set.
 */

const githubParallel = () => adaptiveConcurrency(4, 6);
const reviewParallel = () => adaptiveConcurrency(3, 4);

export const boundsOf = (ctx: RunContext): BoundsConfig | null =>
  ctx.plan.topN
    ? {
        topN: ctx.plan.topN,
        useGithub: ctx.plan.github !== "off",
        useDsa: ctx.plan.dsa.use,
        mandatoryActive: ctx.plan.mandatory.trim().length > 0,
        dsaGates: ctx.plan.dsa.gates,
      }
    : null;

/** Why a candidate's GitHub wasn't read (shown in the GitHub Notes column). */
export const NOT_CONTENDER_NOTE = "Not inspected — can't reach the top N whatever their GitHub shows";
const BUDGET_CHECK_MS = 60_000;

/** Copy an inspection onto the candidate (same fields as the screen's GitHub step). */
function applyGithub(c: DomainCandidate, gh: GithubInspectResult) {
  c.githubStatus = gh.status;
  c.githubNote = gh.note;
  c.githubScore = gh.score;
  c.githubMatches = gh.matches;
  c.githubTechs = gh.techs;
  c.githubTopRepos = gh.topRepos;
  c.githubCommits2y = gh.commits2y;
  c.githubLastDomainCommit = gh.lastDomainCommit;
  c.githubAiLikelihood = gh.aiLikelihood;
  c.githubAiSummary = gh.aiSummary;
  c.githubEvidence = gh.evidence ?? [];
  c.githubMandatoryGaps = gh.mandatoryGaps ?? [];
  c.githubClaimedNotFound = gh.claimedNotFound ?? [];
  c.githubCheckedAt = gh.checkedAt ?? "";
  c.githubFromCache = Boolean(gh.fromCache);
  c.githubAccountName = gh.accountName ?? "";
  c.githubIdentity = gh.identity;
}

/** GitHub's hourly budget: checked every minute; below the floor the run waits for the reset. */
class BudgetGate {
  private checkedAt = 0;
  constructor(private readonly ctx: RunContext) {}
  async pass(): Promise<void> {
    if (Date.now() - this.checkedAt < BUDGET_CHECK_MS) return;
    this.checkedAt = Date.now();
    const access = await checkGithubAccess();
    if (access.ok && access.remaining < GITHUB_BUDGET_FLOOR) {
      const reset = Date.parse(access.resetAt);
      const ms = Number.isFinite(reset) ? reset + 5_000 - Date.now() : 15 * 60_000;
      if (ms > 0) await this.ctx.wait("evaluating", ms, { note: "GitHub hourly limit" });
      this.checkedAt = 0;
    }
  }
}

const screened = (all: CandidateCheckpoint[]) => all.filter((c) => c.state === "screened" && c.candidate);
const withInternal = (cp: CandidateCheckpoint): DomainCandidate => ({ ...cp.candidate!, internal: cp.internal });

/**
 * GitHub for the contenders (`everyone` = also every other candidate with a link, for the
 * "(all candidates)" scope once the shortlist is out). Called again later, it only adds the
 * newly wanted ones; finished inspections are never repeated.
 */
export async function evaluateGithub(ctx: RunContext, everyone = false): Promise<void> {
  if (ctx.plan.github === "off") return;
  let all = screened(await loadCandidates(ctx.job.id));
  const bounds = boundsOf(ctx);
  const withLink = (cp: CandidateCheckpoint) => Boolean(cp.candidate!.githubProfile || cp.candidate!.githubRepos.length);
  const pool = all.map(withInternal);
  const wanted = new Set(
    everyone
      ? all.filter(withLink).map((cp) => cp.key)
      : bounds
        ? all.filter((cp) => withLink(cp) && contenders(pool, bounds, "github").has(cp.candidate!.id)).map((cp) => cp.key)
        : all.filter((cp) => withLink(cp) && clearsGates(withInternal(cp), { topN: 0, useGithub: true, useDsa: ctx.plan.dsa.use, mandatoryActive: ctx.plan.mandatory.trim().length > 0, dsaGates: ctx.plan.dsa.gates })).map((cp) => cp.key),
  );
  const fresh = all.filter((cp) => wanted.has(cp.key) && cp.githubState === "none" && cp.candidate!.githubStatus === "not-inspected").map((cp) => cp.key);
  if (fresh.length) {
    await markPending(ctx.job.id, fresh, "github_state");
    all = screened(await loadCandidates(ctx.job.id));
  }
  const todo = all.filter((c) => c.githubState === "pending");
  const total = all.filter((c) => c.githubState !== "none").length;
  let done = total - todo.length;
  await ctx.beat("evaluating", { githubDone: done, githubTotal: total }, true);
  if (!todo.length) return;
  const gate = new BudgetGate(ctx);
  const saves: Promise<unknown>[] = [];
  await runQueue<CandidateCheckpoint, GithubInspectResult>({
    items: todo,
    concurrency: githubParallel,
    stopped: () => ctx.stopped,
    run: async (cp) => {
      await gate.pass();
      const c = cp.candidate!;
      return inspectDomainGithub(
        { id: c.id, githubProfile: c.githubProfile, githubRepos: c.githubRepos, claimedTechs: c.resumeTechs ?? [], name: c.name },
        ctx.plan.brief,
        ctx.plan.mandatory,
      ).catch(
        (err): GithubInspectResult => ({
          id: c.id,
          status: "failed",
          note: err instanceof Error ? err.message : "GitHub inspection failed",
          score: 0,
          matches: 0,
          techs: [],
          topRepos: [],
          commits2y: 0,
          lastDomainCommit: null,
          aiLikelihood: "",
          aiSummary: "",
          evidence: [],
          mandatoryGaps: [],
          claimedNotFound: [],
          checkedAt: "",
          fromCache: false,
          retryable: true,
        }),
      );
    },
    retryAfter: (gh, attempt) => (gh.rateLimited && attempt <= 3 ? 60_000 : gh.retryable && attempt <= 2 ? 10_000 : null),
    onDone: (cp, gh) => {
      applyGithub(cp.candidate!, gh);
      done++;
      saves.push(saveEvaluated(ctx.job.id, cp.key, cp.candidate!, { githubState: "done" }).catch((e) => console.warn("[automation] save failed:", e)));
      ctx.beat("evaluating", { githubDone: done, githubTotal: total }).catch(() => undefined);
    },
  });
  await Promise.all(saves);
}

/** Code review of the contenders' top domain repos (after their GitHub is read). */
export async function evaluateReviews(ctx: RunContext): Promise<void> {
  if (ctx.plan.github === "off" || !ctx.plan.review) return;
  let all = screened(await loadCandidates(ctx.job.id));
  const bounds = boundsOf(ctx);
  const pool = all.map(withInternal);
  const can = bounds ? contenders(pool, bounds, "review") : null;
  const fresh = all
    .filter((cp) => {
      const c = withInternal(cp);
      if (cp.reviewState !== "none" || c.githubStatus !== "checked" || !c.githubTopRepos.length || c.githubIdentity === "mismatch") return false;
      return can ? can.has(c.id) : c.domainScore >= shortlistBar(c);
    })
    .map((cp) => cp.key);
  if (fresh.length) {
    await markPending(ctx.job.id, fresh, "review_state");
    all = screened(await loadCandidates(ctx.job.id));
  }
  const todo = all.filter((c) => c.reviewState === "pending");
  const total = all.filter((c) => c.reviewState !== "none").length;
  let done = total - todo.length;
  await ctx.beat("evaluating", { reviewDone: done, reviewTotal: total }, true);
  if (!todo.length) return;
  const gate = new BudgetGate(ctx);
  const saves: Promise<unknown>[] = [];
  await runQueue<CandidateCheckpoint, DomainProjectReviewResult>({
    items: todo,
    concurrency: reviewParallel,
    stopped: () => ctx.stopped,
    run: async (cp) => {
      await gate.pass();
      const c = cp.candidate!;
      return reviewDomainProjects(
        { id: c.id, repos: c.githubTopRepos.map((r) => ({ url: r.url, name: r.name, matchPct: r.matchPct, techs: r.techs })) },
        ctx.plan.brief,
        ctx.plan.mandatory,
      ).catch(
        (err): DomainProjectReviewResult => ({
          id: c.id,
          status: "failed",
          note: err instanceof Error ? err.message : "review failed",
          score: 0,
          reviews: [],
          reviewedAt: "",
          fromCache: false,
          retryable: true,
        }),
      );
    },
    retryAfter: (r, attempt) => (r.status !== "failed" ? null : r.rateLimited && attempt <= 2 ? 60_000 : r.retryable && attempt <= 1 ? 10_000 : null),
    onDone: (cp, r) => {
      cp.candidate!.projectReview = r;
      done++;
      saves.push(saveEvaluated(ctx.job.id, cp.key, cp.candidate!, { reviewState: "done" }).catch((e) => console.warn("[automation] save failed:", e)));
      ctx.beat("evaluating", { reviewDone: done, reviewTotal: total }).catch(() => undefined);
    },
  });
  await Promise.all(saves);
}

/** Notes for the candidates whose GitHub wasn't read, so the complete sheet says why. */
export async function noteUninspected(ctx: RunContext): Promise<void> {
  if (ctx.plan.github === "off") return;
  const all = screened(await loadCandidates(ctx.job.id));
  const cfg = { topN: 0, useGithub: true, useDsa: ctx.plan.dsa.use, mandatoryActive: ctx.plan.mandatory.trim().length > 0, dsaGates: ctx.plan.dsa.gates };
  for (const cp of all) {
    const c = cp.candidate!;
    if (c.githubStatus !== "not-inspected" || c.githubNote) continue;
    const cand = withInternal(cp);
    c.githubNote = clearsGates(cand, cfg)
      ? NOT_CONTENDER_NOTE
      : cand.domainScore < shortlistBar(cand)
        ? `${BELOW_BAR_NOTE} — not inspected`
        : "Not inspected — misses a must-have, so GitHub can't change the result";
    await saveEvaluated(ctx.job.id, cp.key, c, {});
  }
}

const secondOpinionParallel = () => ioConcurrency(3, 4);

/**
 * Second opinions for the candidates next to the cut-off (second-opinion.ts): the same resume
 * judged again by an independent model, grounded by the same checks. Stored on the candidate;
 * a disagreement becomes a review flag in validation — scores and ranking never change. Called
 * again later, it only judges candidates who don't have one yet; failures are simply skipped.
 */
export async function evaluateSecondOpinions(ctx: RunContext): Promise<void> {
  const chain = secondOpinionChain();
  if (!chain) return;
  const all = screened(await loadCandidates(ctx.job.id));
  const byId = new Map(all.map((cp) => [cp.candidate!.id, cp]));
  const picks = secondOpinionPicks(all.map(withInternal), boundsOf(ctx))
    .map((id) => byId.get(id))
    .filter((cp): cp is CandidateCheckpoint => Boolean(cp));
  if (!picks.length) return;
  const mandatoryActive = ctx.plan.mandatory.trim().length > 0;
  await ctx.beat("evaluating", { note: `second opinion on ${picks.length} near the cut-off` }, true);
  let agree = 0;
  let disagree = 0;
  let failed = 0;
  const saves: Promise<unknown>[] = [];
  await runQueue<CandidateCheckpoint, DomainScreenResult>({
    items: picks,
    concurrency: secondOpinionParallel,
    stopped: () => ctx.stopped,
    run: (cp) =>
      screenDomainCandidate(cp.row, {
        domain: ctx.plan.brief,
        mandatory: ctx.plan.mandatory,
        useDsa: false,
        useGithub: false,
        requireExperience: Boolean(ctx.plan.requireExperience),
        checkPresentation: false,
        gate: (work) => cpuGate.run(work),
        chain,
        cache: true,
      }),
    retryAfter: () => null,
    onDone: (cp, res) => {
      if (!res.ok) {
        failed++;
        return;
      }
      const first = withInternal(cp);
      const second = { domainScore: res.candidate.domainScore, meetsMandatory: res.candidate.meetsMandatory, scoredBy: res.candidate.scoredBy ?? chain };
      const verdict = compareOpinions(first, second, mandatoryActive);
      if (verdict.agrees) agree++;
      else disagree++;
      cp.candidate!.secondOpinion = { ...second, ...verdict, at: new Date().toISOString() };
      saves.push(saveEvaluated(ctx.job.id, cp.key, cp.candidate!, {}).catch((e) => console.warn("[automation] save failed:", e)));
    },
  });
  await Promise.all(saves);
  await ctx.beat("evaluating", { note: undefined }, true);
  await logEvent(
    ctx.job.id,
    "evaluating",
    disagree ? "warn" : "info",
    `Second opinion (${chain.replace(/^openai:/, "openai/")}) on ${picks.length} near the cut-off: ${agree} agree, ${disagree} disagree (flagged for a person)${failed ? `, ${failed} couldn't be judged` : ""}.`,
  );
}
