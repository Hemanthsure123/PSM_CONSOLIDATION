/** Race a job against a deadline; on timeout the fallback (a retryable result) wins. */
export async function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  return Promise.race([work.finally(() => clearTimeout(timer)), timedOut]);
}
