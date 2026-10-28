/**
 * A job failure with its retry decision: retryable = a passing problem (network, rate limit,
 * a Google / database hiccup) — the job is taken up again later from its checkpoint;
 * not retryable = something the user must change (a wrong tab name, a sheet not shared) —
 * the job ends FAILED with this message on the control row.
 */
export class JobError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "JobError";
  }
}

/** Unknown errors are treated as passing (retried a bounded number of times). */
export const isRetryable = (err: unknown) => (err instanceof JobError ? err.retryable : true);
export const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);
