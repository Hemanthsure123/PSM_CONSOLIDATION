import "server-only";
import { getDrive } from "@/lib/drive";

/**
 * Resume links that point at a Google Drive FOLDER (students sometimes share the folder):
 * find the resume file inside it. Read-only (files.get + files.list). Shared by Academy
 * bucketing and Sample profiles.
 */

export const FOLDER = /drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?)?folders\/([A-Za-z0-9_-]+)/i;
const RESUME_TYPES = /pdf|document|wordprocessing|msword|image\//i;

/**
 * The resume inside a Drive folder link (students sometimes share the folder): a file named
 * like a resume first, then documents before images, then the newest. Read-only (list + get).
 */
export async function resumeInFolder(url: string): Promise<{ url: string; note: string } | { error: string; retryable: boolean }> {
  const id = url.match(FOLDER)?.[1] ?? "";
  try {
    // Listing a folder the account can't open returns nothing rather than an error — ask for the folder first.
    await getDrive().files.get({ fileId: id, fields: "id", supportsAllDrives: true });
    const res = await getDrive().files.list({
      q: `'${id}' in parents and trashed = false`,
      fields: "files(id,name,mimeType,modifiedTime)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 100,
    });
    const files = (res.data.files ?? []).filter((f) => f.id && RESUME_TYPES.test(f.mimeType ?? ""));
    if (!files.length) return { error: "The resume link is a Drive folder with no PDF / document in it.", retryable: false };
    const rank = (f: (typeof files)[number]) => [/resume|cv|curriculum/i.test(f.name ?? "") ? 0 : 1, /image\//i.test(f.mimeType ?? "") ? 1 : 0];
    files.sort((a, b) => {
      const [x1, x2] = rank(a);
      const [y1, y2] = rank(b);
      return x1 - y1 || x2 - y2 || String(b.modifiedTime ?? "").localeCompare(String(a.modifiedTime ?? ""));
    });
    const f = files[0];
    return {
      url: f.mimeType === "application/vnd.google-apps.document" ? `https://docs.google.com/document/d/${f.id}/edit` : `https://drive.google.com/file/d/${f.id}/view`,
      note: `Resume link is a Drive folder — read "${(f.name ?? "file").slice(0, 80)}"${files.length > 1 ? ` (newest of ${files.length} documents)` : ""}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = Number((err as { code?: unknown })?.code);
    if (/not found|404|403|permission/i.test(msg)) return { error: "Resume could not be downloaded — the Drive folder isn't shared with the service account.", retryable: false };
    return { error: `Resume folder could not be read (${msg.slice(0, 80)}) — re-run this candidate.`, retryable: status === 429 || status >= 500 || !Number.isFinite(status) };
  }
}
