import "server-only";
import { heartbeat } from "@/lib/automation/store";
import type { JobRow } from "@/lib/automation/store";
import type { AutomationPlan, JobProgress, JobStep } from "@/lib/automation/types";

/** Thrown when another worker took the job over (our lease expired): stop touching it. */
export class LeaseLostError extends Error {
  constructor() {
    super("The job's lease was lost.");
    this.name = "LeaseLostError";
  }
}

/**
 * What every agent gets: the job, its plan, and `beat()` — save progress and extend the lease.
 * Agents call it between units of work; it is rate-limited, and throws LeaseLostError when the
 * job is no longer ours, which stops the run cleanly.
 */
export class RunContext {
  progress: JobProgress = {};
  private lastBeat = 0;
  private lost = false;

  constructor(
    readonly job: JobRow,
    readonly owner: string,
    public plan: AutomationPlan,
    private readonly onProgress: (step: JobStep, progress: JobProgress) => void,
  ) {
    this.progress = { ...job.progress };
  }

  get stopped() {
    return this.lost;
  }

  /** Save progress (at most every 15 s unless forced) and keep the lease. */
  async beat(step: JobStep, patch: JobProgress = {}, force = false): Promise<void> {
    if (this.lost) throw new LeaseLostError();
    this.progress = { ...this.progress, ...patch };
    this.onProgress(step, this.progress);
    if (!force && Date.now() - this.lastBeat < 15_000) return;
    this.lastBeat = Date.now();
    const ok = await heartbeat(this.job.id, this.owner, { step, progress: this.progress });
    if (!ok) {
      this.lost = true;
      throw new LeaseLostError();
    }
  }

  /** Wait, keeping the lease alive. */
  async wait(step: JobStep, ms: number, patch: JobProgress = {}): Promise<void> {
    const until = Date.now() + ms;
    await this.beat(step, { ...patch, waitingUntil: new Date(until).toISOString() }, true);
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, Math.min(20_000, until - Date.now())));
      await this.beat(step, {}, true);
    }
    await this.beat(step, { waitingUntil: undefined }, true);
  }
}
