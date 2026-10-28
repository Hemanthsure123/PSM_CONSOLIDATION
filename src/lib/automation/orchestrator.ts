import "server-only";
import { writeControlStatus } from "@/lib/automation/control-sheet";
import { LeaseLostError, RunContext } from "@/lib/automation/context";
import { deliver, validate } from "@/lib/automation/delivery";
import { isRetryable, JobError, messageOf } from "@/lib/automation/errors";
import { evaluateGithub, evaluateReviews } from "@/lib/automation/evaluation";
import { planJob } from "@/lib/automation/planner";
import { readCandidates, screenCandidates } from "@/lib/automation/screening";
import { finishJob, heartbeat, logEvent, releaseForRetry, savePlan, saveResult, type JobRow } from "@/lib/automation/store";
import { JOB_STEPS, type AutomationPlan, type JobProgress, type JobStep } from "@/lib/automation/types";

/**
 * The orchestrator — runs one job's agents in order and owns every decision about the job:
 *
 *   planning → screening → evaluating → validating → delivering → done
 *
 * The step is the checkpoint: a job taken up again (after a restart, a deploy, a passing
 * failure) skips finished steps, and inside a step the per-candidate checkpoints skip finished
 * candidates. A passing failure releases the job for a retry with a growing pause (up to
 * MAX_ATTEMPTS takes); a failure the user must fix ends it FAILED with the reason on the
 * control row. Agents never change the job's status themselves.
 */

export const MAX_ATTEMPTS = 8;
const retryDelay = (attempt: number) => Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
const stepIndex = (s: JobStep) => JOB_STEPS.indexOf(s);

/** Throttled "Automation Details" updates while the job runs (every status change is written at once). */
function sheetUpdater(job: JobRow) {
  let last = 0;
  let pending: { step: JobStep; progress: JobProgress } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = async () => {
    timer = null;
    if (!pending) return;
    const p = pending;
    pending = null;
    last = Date.now();
    await writeControlStatus(job, { status: "processing", step: p.step, progress: p.progress, result: null, error: null });
  };
  return {
    update(step: JobStep, progress: JobProgress) {
      pending = { step, progress };
      if (timer) return;
      timer = setTimeout(() => void flush(), Math.max(0, 60_000 - (Date.now() - last)));
    },
    async now(step: JobStep, progress: JobProgress) {
      if (timer) clearTimeout(timer);
      pending = { step, progress };
      await flush();
    },
    stop() {
      if (timer) clearTimeout(timer);
      pending = null;
    },
  };
}

export async function runJob(job: JobRow, owner: string): Promise<void> {
  if (job.attempts > MAX_ATTEMPTS) {
    const error = `Stopped after ${MAX_ATTEMPTS} attempts. Last error: ${job.error ?? "unknown"}`;
    await logEvent(job.id, job.step, "error", error);
    await finishJob(job.id, owner, "failed", error);
    await writeControlStatus(job, { status: "failed", step: job.step, progress: job.progress, result: null, error });
    return;
  }
  const sheet = sheetUpdater(job);
  let step: JobStep = job.step === "queued" ? "planning" : job.step;
  const ctx = new RunContext(job, owner, (job.plan ?? null) as AutomationPlan, (s, p) => sheet.update(s, p));
  try {
    await logEvent(job.id, step, "info", job.step !== "queued" ? `Taken up again (attempt ${job.attempts}) at step ${step}.` : "Started.");
    await sheet.now(step, ctx.progress);

    // 1. Planner.
    if (!ctx.plan || stepIndex(step) <= stepIndex("planning")) {
      await heartbeat(job.id, owner, { step: "planning" });
      const plan = await planJob(job);
      if (!(await savePlan(job.id, owner, plan))) throw new LeaseLostError();
      ctx.plan = plan;
      await logEvent(
        job.id,
        "planning",
        "info",
        `Plan: tabs ${plan.tabs.map((t) => `"${t.name}"`).join(", ")} in "${plan.sourceTitle}"; domain "${plan.domainName}"; mandatory: ${plan.mandatory || "none"}; GitHub ${plan.github}${plan.review ? " + code review" : ""}; DSA ${plan.dsa.use ? "on" : "off"}; ${plan.topN ? `top ${plan.topN}` : "no limit"}.${plan.notes.length ? ` Notes: ${plan.notes.join("; ")}.` : ""}`,
      );
      step = "screening";
      await ctx.beat(step, { note: undefined }, true);
    }

    // 2. Screening agent.
    if (stepIndex(step) <= stepIndex("screening")) {
      await readCandidates(ctx);
      await screenCandidates(ctx);
      if (ctx.stopped) throw new LeaseLostError();
      step = "evaluating";
      await ctx.beat(step, {}, true);
      await sheet.now(step, ctx.progress);
    }

    // 3. Evaluation agent.
    if (stepIndex(step) <= stepIndex("evaluating")) {
      await evaluateGithub(ctx);
      await evaluateReviews(ctx);
      if (ctx.stopped) throw new LeaseLostError();
      step = "validating";
      await ctx.beat(step, {}, true);
    }

    // 4. Validation agent, 5. Delivery agent (validation is recomputed from the checkpoints, so it is safe to redo).
    const validated = await validate(ctx);
    step = "delivering";
    await ctx.beat(step, {}, true);
    await sheet.now(step, ctx.progress);
    const result = await deliver(ctx, validated);
    await saveResult(job.id, owner, result);
    sheet.stop();
    const finished = await finishJob(job.id, owner, validated.status, null);
    await logEvent(job.id, "done", "info", `Finished: ${validated.status}.`);
    await writeControlStatus(job, { status: validated.status, step: "done", progress: ctx.progress, result, error: null });
    if (!finished) console.warn(`[automation] job ${job.id}: finished, but the lease had moved on.`);
  } catch (err) {
    sheet.stop();
    if (err instanceof LeaseLostError) {
      console.warn(`[automation] job ${job.id}: lease lost — another worker continues it.`);
      return;
    }
    const message = messageOf(err);
    if (isRetryable(err) && job.attempts < MAX_ATTEMPTS) {
      const delay = retryDelay(job.attempts);
      await logEvent(job.id, step, "warn", `${message} — retrying in ${Math.round(delay / 60_000)} min.`);
      await releaseForRetry(job.id, owner, delay, message);
      await writeControlStatus(job, {
        status: "processing",
        step,
        progress: { ...ctx.progress, note: `retrying after an error in ${Math.round(delay / 60_000)} min` },
        result: null,
        error: null,
      });
      return;
    }
    const error = err instanceof JobError ? message : `${message} (after ${job.attempts} attempt${job.attempts === 1 ? "" : "s"})`;
    await logEvent(job.id, step, "error", error);
    await finishJob(job.id, owner, "failed", error);
    await writeControlStatus(job, { status: "failed", step, progress: ctx.progress, result: null, error });
  }
}
