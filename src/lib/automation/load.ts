/**
 * Back-pressure for the free plan's 512 MB: how many units of work to run at once, lowered while
 * the process's memory is high (a resume, a repository or a model answer in flight each hold some)
 * and back up when it drops. Read on every pick, so the width follows memory as the run goes.
 */

const MB = 1024 * 1024;
/** Above this resident size the width is halved; above the hard mark only one runs at a time. */
const SOFT_MB = Number(process.env.AUTOMATION_MEMORY_SOFT_MB) || 380;
const HARD_MB = Number(process.env.AUTOMATION_MEMORY_HARD_MB) || 450;

export function adaptiveConcurrency(base: number, max: number, rss: number = process.memoryUsage().rss): number {
  const width = Math.min(max, Math.max(1, Math.floor(base)));
  if (rss >= HARD_MB * MB) return 1;
  if (rss >= SOFT_MB * MB) return Math.max(1, Math.floor(width / 2));
  return width;
}
