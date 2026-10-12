import "server-only";
import { Readable } from "node:stream";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDrive } from "@/lib/drive";
import { env } from "@/lib/env";

/** Where a generated PDF ended up. */
export type PdfStorage = "drive" | "local";

export interface StoredPdf {
  link: string;
  storage: PdfStorage;
}

/** The permanent "service accounts have no storage quota" Drive failure. */
export function isStorageQuotaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const reason = (err as { errors?: { reason?: string }[] })?.errors?.[0]?.reason;
  return reason === "storageQuotaExceeded" || /do not have storage quota|storageQuota/i.test(message);
}

/** Retry a Drive API call with exponential backoff on TRANSIENT failures only. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Permanent errors (e.g. storage quota) must not be retried.
      if (isStorageQuotaError(err)) throw err;
      const status =
        (err as { code?: number; status?: number })?.code ?? (err as { status?: number })?.status;
      const retryable = status === 429 || status === 403 || (typeof status === "number" && status >= 500);
      if (!retryable || i === attempts - 1) throw err;
      const delay = Math.min(1000 * 2 ** i, 8000) + Math.random() * 250;
      console.warn(`[drive] transient error (${status}); retrying in ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Upload the PDF to the configured Drive folder and return a shareable link. */
export async function uploadToDrive(pdfBuffer: Buffer, fileName: string): Promise<string> {
  const drive = getDrive();
  const createRes = await withRetry(() =>
    drive.files.create({
      requestBody: { name: fileName, parents: [env.drive.folderId], mimeType: "application/pdf" },
      media: { mimeType: "application/pdf", body: Readable.from(pdfBuffer) },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    }),
  );

  const fileId = createRes.data.id;
  if (!fileId) throw new Error("Drive upload returned no file id.");

  await withRetry(() =>
    drive.permissions.create({
      fileId,
      requestBody: { role: "reader", type: "anyone" },
      supportsAllDrives: true,
    }),
  );

  let webViewLink = createRes.data.webViewLink ?? "";
  if (!webViewLink) {
    const getRes = await withRetry(() =>
      drive.files.get({ fileId, fields: "webViewLink", supportsAllDrives: true }),
    );
    webViewLink = getRes.data.webViewLink ?? "";
  }
  if (!webViewLink) throw new Error("Could not resolve a shareable Drive link.");
  return webViewLink;
}

/** Fallback: write the PDF under public/reports and return its served path. */
export async function saveLocally(pdfBuffer: Buffer, fileName: string): Promise<string> {
  const dir = join(process.cwd(), "public", "reports");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), pdfBuffer);
  return `/reports/${fileName}`;
}

/**
 * Store a generated PDF: Drive first (shareable link), falling back to a local
 * public path when the service account has no storage quota — i.e. the folder
 * isn't on a Shared Drive. Generation must never fail just because Drive can't
 * take the file.
 */
export async function storePdf(pdfBuffer: Buffer, fileName: string): Promise<StoredPdf> {
  try {
    return { link: await uploadToDrive(pdfBuffer, fileName), storage: "drive" };
  } catch (err) {
    if (isStorageQuotaError(err)) {
      console.warn(`[storage] Drive quota blocked ${fileName}; saving locally instead.`);
      return { link: await saveLocally(pdfBuffer, fileName), storage: "local" };
    }
    throw err;
  }
}
