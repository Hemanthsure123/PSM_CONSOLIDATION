import "server-only";

/**
 * Second line of keep-awake (the first is the database's pg_cron ping, migration 011): while the
 * instance is up, it asks its own public URL for /api/health every 10 minutes. The request goes
 * out through Render's edge, so it counts as inbound traffic and the free instance never reaches
 * its 15-minute idle spin-down between real requests. It cannot wake a stopped instance; that is
 * what the database ping is for.
 *
 * On only where Render says where we live (RENDER_EXTERNAL_URL) and KEEP_AWAKE isn't "off".
 */
const g = globalThis as unknown as { __keepAwake?: NodeJS.Timeout };
const EVERY_MS = 10 * 60_000;
const TIMEOUT_MS = 30_000;

export function startKeepAwake(): void {
  const base = process.env.RENDER_EXTERNAL_URL;
  if (!base || process.env.KEEP_AWAKE === "off" || g.__keepAwake) return;
  const url = new URL("/api/health", base).toString();
  const ping = () => {
    fetch(url, { headers: { "user-agent": "psm-keep-awake/1 (self)" }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      .then((res) => res.body?.cancel())
      .catch(() => {
        /* the next ping, or the database's, tries again */
      });
  };
  g.__keepAwake = setInterval(ping, EVERY_MS);
  g.__keepAwake.unref?.();
  console.log("[keep-awake] self-ping on (every 10 min)");
}
