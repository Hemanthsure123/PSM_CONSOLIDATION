import "server-only";
import { google, type sheets_v4 } from "googleapis";
import { env } from "@/lib/env";

/**
 * Lazily-constructed singleton Google Sheets v4 client, authenticated via the
 * GCP service account. Read-only scope. The target spreadsheet must be shared
 * with the service-account email (or live on a Shared Drive it can access).
 *
 * Lazy + cached on `globalThis` (see bigquery.ts for the rationale).
 */
const globalForSheets = globalThis as unknown as { sheets?: sheets_v4.Sheets; sheetsWriter?: sheets_v4.Sheets };

// Transport-level retries for every googleapis call, kept to gaxios's own bounded rules: at most 3
// retries, on a dropped connection (no response: "Premature close", ECONNRESET …), 408, 429 or 5xx.
// Only reads are retried here — a write (POST: values.append, batchUpdate, Drive upload) whose
// response was lost may already have happened, so retrying it could add a row twice. No custom
// shouldRetry: it would replace gaxios's attempt / method / status checks and retry without end.
google.options({
  retryConfig: {
    retry: 3,
    noResponseRetries: 3,
    retryDelay: 500,
    httpMethodsToRetry: ["GET", "HEAD", "OPTIONS"],
  },
});

export function resetSheetsClients(): void {
  globalForSheets.sheets = undefined;
  globalForSheets.sheetsWriter = undefined;
}

export function getSheets(): sheets_v4.Sheets {
  if (!globalForSheets.sheets) {
    const auth = new google.auth.JWT({
      email: env.gcp.clientEmail,
      key: env.gcp.privateKey,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
      ],
    });
    globalForSheets.sheets = google.sheets({ version: "v4", auth });
  }
  return globalForSheets.sheets;
}

/**
 * A Sheets client that can WRITE — only the sheet automation uses it (status cells on the
 * control row, the psm_final_shortlisted_<date> tab). Everything else reads through the
 * read-only client above. The spreadsheet must give the service account edit access.
 */
export function getSheetsWriter(): sheets_v4.Sheets {
  if (!globalForSheets.sheetsWriter) {
    const auth = new google.auth.JWT({
      email: env.gcp.clientEmail,
      key: env.gcp.privateKey,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    globalForSheets.sheetsWriter = google.sheets({ version: "v4", auth });
  }
  return globalForSheets.sheetsWriter;
}

/**
 * Execute a Google Sheets operation with automatic retries for transient socket/network errors
 * (e.g. "Premature close", "ECONNRESET", "socket hang up", "fetch failed", rate limits) — including
 * a failed sign-in (the OAuth token fetch), which the transport retries don't cover. Reads only:
 * a write whose response was lost may already have happened.
 */
export async function withSheetsRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 400): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      const msg = String(err?.message ?? "").toLowerCase();
      const isTransient =
        msg.includes("premature close") ||
        msg.includes("econnreset") ||
        msg.includes("socket hang up") ||
        msg.includes("etimedout") ||
        msg.includes("fetch failed") ||
        msg.includes("eai_again") ||
        msg.includes("rate limit") ||
        err?.status === 429 ||
        err?.code === 429 ||
        (err?.status >= 500 && err?.status <= 599);

      if (!isTransient || attempt >= maxRetries) {
        throw err;
      }

      // If the socket was abruptly closed, invalidate cached client to force a fresh connection
      if (msg.includes("premature close") || msg.includes("econnreset") || msg.includes("socket hang up")) {
        resetSheetsClients();
      }

      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
      console.warn(`[sheets] Transient error (${err?.message}). Retrying in ${delay}ms (attempt ${attempt}/${maxRetries})...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Extract the spreadsheet id from any Google Sheets URL (or accept a bare id).
 *   https://docs.google.com/spreadsheets/d/<ID>/edit#gid=0  →  <ID>
 */
export function extractSpreadsheetId(input: string): string | null {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return null;
  const m = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  // Bare id (no slashes / not a URL).
  if (/^[a-zA-Z0-9-_]{20,}$/.test(trimmed)) return trimmed;
  return null;
}
