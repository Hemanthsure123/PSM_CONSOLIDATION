/**
 * Runs once when the server starts (Next.js instrumentation hook). It starts the sheet
 * automation's background worker, which continues any job a restart or deploy interrupted.
 * The worker only runs where AUTOMATION_WORKER=on (lib/automation/worker.ts).
 *
 * The condition must stay written exactly like this: the edge build drops the branch, so the
 * Node-only worker (Chromium, the database) is never bundled for the edge runtime.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorker } = await import("./lib/automation/worker");
    startWorker();
  }
}
