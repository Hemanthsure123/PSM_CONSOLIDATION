import "server-only";
import { getDrive } from "@/lib/drive";

/**
 * Resolve a resume URL (taken from the internal sheet's resume column) to raw
 * bytes + mime type so the LLM can read it and the report can link to it.
 *
 * Two cases are handled:
 *  1. Google Drive / Google Docs links → downloaded via the Drive API (the
 *     service account must have read access). Google-native Docs are exported
 *     to PDF; everything else is fetched as-is.
 *  2. Any other public URL → fetched directly.
 *
 * Returns `null` (rather than throwing) when the resume can't be resolved, so
 * the caller can degrade gracefully and still produce a report.
 */

export interface ResumeBytes {
  data: Buffer;
  mimeType: string;
}

/** Pull a Drive file id out of the common Drive/Docs URL shapes. */
export function extractDriveFileId(url: string): string | null {
  const u = (url ?? "").trim();
  if (!u) return null;
  // /file/d/<id>/  or  /document/d/<id>/  or  /spreadsheets/d/<id>/
  const path = u.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (path) return path[1];
  // ?id=<id>  or  &id=<id>
  const q = u.match(/[?&]id=([a-zA-Z0-9-_]+)/);
  if (q) return q[1];
  return null;
}

function isDriveUrl(url: string): boolean {
  return /drive\.google\.com|docs\.google\.com/i.test(url);
}

/** A resume download that takes longer than this is abandoned (it would stall a whole batch). */
const DRIVE_TIMEOUT_MS = 60_000;
const URL_TIMEOUT_MS = 30_000;

async function fetchFromDrive(fileId: string): Promise<ResumeBytes | null> {
  const drive = getDrive();

  // Inspect the file to decide between media download vs. Docs export.
  const meta = await drive.files.get(
    {
      fileId,
      fields: "mimeType, name",
      supportsAllDrives: true,
    },
    { timeout: DRIVE_TIMEOUT_MS },
  );
  const mimeType = meta.data.mimeType ?? "";

  if (mimeType.startsWith("application/vnd.google-apps")) {
    // Native Google Doc/Sheet/Slide → export to PDF.
    const res = await drive.files.export(
      { fileId, mimeType: "application/pdf" },
      { responseType: "arraybuffer", timeout: DRIVE_TIMEOUT_MS },
    );
    return { data: Buffer.from(res.data as ArrayBuffer), mimeType: "application/pdf" };
  }

  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer", timeout: DRIVE_TIMEOUT_MS },
  );
  return {
    data: Buffer.from(res.data as ArrayBuffer),
    mimeType: mimeType || "application/pdf",
  };
}

async function fetchFromUrl(url: string): Promise<ResumeBytes | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(URL_TIMEOUT_MS), redirect: "follow", cache: "no-store" });
  if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get("content-type")?.split(";")[0] || "application/pdf";
  return { data: buf, mimeType };
}

/**
 * A Drive file shared "anyone with the link" but not with the service account is
 * invisible to the API; its public download URL still works. An HTML reply is a
 * sign-in / not-found page, never the resume.
 */
async function fetchDrivePublic(fileId: string): Promise<ResumeBytes | null> {
  const res = await fetch(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download`, {
    signal: AbortSignal.timeout(URL_TIMEOUT_MS),
    redirect: "follow",
    cache: "no-store",
  });
  const type = res.headers.get("content-type")?.split(";")[0] ?? "";
  if (!res.ok || type.startsWith("text/html")) return null;
  return { data: Buffer.from(await res.arrayBuffer()), mimeType: type === "application/octet-stream" ? "application/pdf" : type || "application/pdf" };
}

export type ResumeFetch = { ok: true; bytes: ResumeBytes } | { ok: false; transient: boolean; error: string };

/**
 * A network failure, a timeout, a rate limit or a 5xx says nothing about the
 * resume — the caller should retry. A 404 / 403 means the file is gone or not
 * shared.
 */
function isTransient(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; name?: string; message?: string; response?: { status?: number } };
  const status = Number(e?.response?.status ?? e?.status ?? (typeof e?.code === "number" ? e.code : NaN));
  if (Number.isFinite(status)) return status === 429 || status >= 500;
  const text = `${String(e?.code ?? "")} ${e?.name ?? ""} ${e?.message ?? ""}`;
  return /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network|timeout|timed out|aborted|fetch failed/i.test(text);
}

/** The resume's bytes, or why not — and whether trying again later could help. */
export async function fetchResume(url: string): Promise<ResumeFetch> {
  const u = (url ?? "").trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, transient: false, error: "not a link" };

  try {
    if (isDriveUrl(u)) {
      const fileId = extractDriveFileId(u);
      if (!fileId) return { ok: false, transient: false, error: "no Drive file id in the link" };
      try {
        const bytes = await fetchFromDrive(fileId);
        if (bytes) return { ok: true, bytes };
        return { ok: false, transient: false, error: "Drive returned no file" };
      } catch (err) {
        const viaLink = await fetchDrivePublic(fileId).catch(() => null);
        if (viaLink) return { ok: true, bytes: viaLink };
        throw err;
      }
    }
    const bytes = await fetchFromUrl(u);
    return bytes ? { ok: true, bytes } : { ok: false, transient: false, error: "the link did not return a file" };
  } catch (err) {
    console.warn("[resume] failed to fetch resume bytes:", err instanceof Error ? err.message : err);
    return { ok: false, transient: isTransient(err), error: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }
}

export async function fetchResumeBytes(url: string): Promise<ResumeBytes | null> {
  const r = await fetchResume(url);
  return r.ok ? r.bytes : null;
}
