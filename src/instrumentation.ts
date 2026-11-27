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
    const { startMobileTicker } = await import("./lib/mobile/ticker");
    startMobileTicker();
    const { startKeepAwake } = await import("./lib/keep-awake");
    startKeepAwake();
    const { ensureAdminKeys } = await import("./lib/admin/api-keys");
    void ensureAdminKeys().catch(() => undefined);
    // The first guidance / Meet lookup after a deploy or restart reads every contact source cold:
    // read them now, in the background, so the first person waits seconds, not a minute.
    setTimeout(() => {
      void import("./lib/team/prep").then((m) => m.warmPrepLookups()).catch(() => undefined);
    }, 20_000).unref?.();
  }
}
