import "server-only";
import puppeteer, { type Browser } from "puppeteer";

/**
 * Close the browser, and if `close()` hangs or throws (common on Windows when
 * the temp profile is locked, and worse under memory pressure), SIGKILL the
 * Chromium process so it can never orphan and accumulate until the machine runs
 * out of memory.
 */
async function closeBrowserHard(browser: Browser): Promise<void> {
  const proc = browser.process();
  try {
    await Promise.race([
      browser.close(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("close timed out")), 5000)),
    ]);
  } catch (err) {
    console.warn("[pdf] browser close failed; force-killing:", err instanceof Error ? err.message : err);
    try {
      proc?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Render an HTML string to a PDF Buffer with headless Chromium.
 *
 * Deployment note: `puppeteer` bundles a full Chromium and needs a long-running
 * Node runtime — it does NOT run on Vercel/serverless functions out of the box.
 * For serverless, swap to `puppeteer-core` + `@sparticuz/chromium` and point
 * `executablePath` at the Lambda-compatible binary. The rest of this function
 * stays the same.
 */
/** One launch → render → close attempt. Fresh browser each time. */
async function renderOnce(html: string, singlePage: boolean): Promise<Buffer> {
  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      headless: true,
      // A starved machine can leave the CDP connection sluggish; give protocol
      // calls room so we retry on real failures, not premature timeouts.
      protocolTimeout: 120000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    // Under memory pressure Chromium can attach a page whose main frame isn't
    // ready yet ("Requesting main frame too early!"). Reusing the blank page
    // the browser already opened, and nudging it to about:blank first, makes the
    // frame reliably present before we set content.
    const pages = await browser.pages();
    const page = pages[0] ?? (await browser.newPage());
    await page.goto("about:blank");
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 60000 });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
      // Hard guarantee a single page — never spill to page 2 — unless the
      // caller is rendering a genuinely multi-page document.
      ...(singlePage ? { pageRanges: "1" } : {}),
    });

    return Buffer.from(pdf);
  } finally {
    // Guarantee the Chromium process is gone (close, else SIGKILL) so it can
    // never orphan — see closeBrowserHard.
    if (browser) await closeBrowserHard(browser);
  }
}

/**
 * Render an HTML string to a PDF Buffer with headless Chromium, retrying on
 * transient browser-startup failures. On a memory-strained machine Chromium can
 * launch but fail to initialise its renderer ("Requesting main frame too
 * early!", "Target closed"); a fresh relaunch usually succeeds, so we try a few
 * times with backoff before giving up.
 *
 * Deployment note: `puppeteer` bundles a full Chromium and needs a long-running
 * Node runtime — it does NOT run on Vercel/serverless functions out of the box.
 * For serverless, swap to `puppeteer-core` + `@sparticuz/chromium`.
 */
export async function htmlToPdf(
  html: string,
  /**
   * Single-page reports (the per-candidate screening report) are hard-clipped to
   * page 1 so they can never spill. Multi-page documents (the projects
   * consolidation) must pass `false` or they would be silently truncated.
   */
  options: { singlePage?: boolean } = {},
): Promise<Buffer> {
  const { singlePage = true } = options;
  const attempts = 3;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await renderOnce(html, singlePage);
    } catch (err) {
      lastErr = err;
      console.warn(`[pdf] render attempt ${i}/${attempts} failed:`, err instanceof Error ? err.message : err);
      if (i < attempts) await new Promise((r) => setTimeout(r, 600 * i));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
