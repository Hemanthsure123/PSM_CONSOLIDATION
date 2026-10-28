import "server-only";
import { reviewDomainProjects } from "@/lib/domain-project-review";
import {
  GITHUB_BUDGET_FLOOR,
  GITHUB_INSPECT_CAP,
  PROJECT_REVIEW_CAP,
  combinedScore,
  comparePriority,
  gateFailure,
  planGithubInspection,
  shortlistBar,
} from "@/lib/domain-scoring";
import { inspectDomainGithub, type GithubInspectResult } from "@/lib/domain-screen";
import { BELOW_BAR_NOTE } from "@/lib/domain-csv";
import { checkGithubAccess } from "@/lib/github-analysis";
import { runQueue } from "@/lib/parallel-queue";
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
 * Who gets inspected / reviewed is decided once and stored, so a restart continues the same set.
 */

const GITHUB_PARALLEL = 3;
const REVIEW_PARALLEL = 2;
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

export async function evaluateGithub(ctx: RunContext): Promise<void> {
  if (ctx.plan.github === "off") return;
  let all = screened(await loadCandidates(ctx.job.id));
  // Plan the inspection once: candidates already planned (pending / done) keep their place.
  if (!all.some((c) => c.githubState !== "none")) {
    const pool = all.map((cp) => ({ ...withInternal(cp), key: cp.key }));
    const plan = planGithubInspection(pool, ctx.plan.github, 0);
    for (const c of plan.overCap) {
      const cp = all.find((x) => x.key === c.key)!;
      cp.candidate!.githubNote = `Beyond the top-${GITHUB_INSPECT_CAP} GitHub inspection cap.`;
      await saveEvaluated(ctx.job.id, cp.key, cp.candidate!, {});
    }
    for (const c of plan.belowBar) {
      const cp = all.find((x) => x.key === c.key)!;
      cp.candidate!.githubNote = `${BELOW_BAR_NOTE} — scope was domain-fit candidates only.`;
      await saveEvaluated(ctx.job.id, cp.key, cp.candidate!, {});
    }
    await markPending(ctx.job.id, plan.pool.map((c) => c.key), "github_state");
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
    concurrency: () => GITHUB_PARALLEL,
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

export async function evaluateReviews(ctx: RunContext): Promise<void> {
  if (ctx.plan.github === "off" || !ctx.plan.review) return;
  let all = screened(await loadCandidates(ctx.job.id));
  if (!all.some((c) => c.reviewState !== "none")) {
    const gates = {
      mandatoryActive: ctx.plan.mandatory.trim().length > 0,
      requireExperience: false,
      minLeetcode: 0,
      dsaGates: ctx.plan.dsa.gates,
      minCommits: 0,
      checkPresentation: false,
      minPresentation: 0,
    };
    const cap = ctx.plan.topN ? Math.min(PROJECT_REVIEW_CAP, ctx.plan.topN * 2 + 5) : PROJECT_REVIEW_CAP;
    const pool = all
      .map((cp) => ({ cp, c: withInternal(cp) }))
      .filter(({ c }) => c.githubStatus === "checked" && c.githubTopRepos.length > 0 && c.domainScore >= shortlistBar(c) && !gateFailure(c, gates))
      .sort((a, b) => comparePriority(a.c, b.c, (x) => combinedScore(x, true, false, ctx.plan.dsa.use)))
      .slice(0, cap);
    await markPending(ctx.job.id, pool.map((x) => x.cp.key), "review_state");
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
    concurrency: () => REVIEW_PARALLEL,
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
