import "server-only";
import { google, type drive_v3 } from "googleapis";
import { env } from "@/lib/env";

/**
 * Name and last-modified time of a Google Doc / Drive file behind a drill-down or transcript link,
 * read through the service account (cached 30 min). Files the service account can't see simply
 * come back without metadata; the link is still shown.
 */

const TTL = 30 * 60_000;
const g = globalThis as unknown as { __prepDrive?: drive_v3.Drive; __prepDocMeta?: Map<string, { at: number; v: DocMeta | null }> };
const cache = (g.__prepDocMeta ??= new Map());

export interface DocMeta {
  name: string;
  modifiedAt: string;
}

function drive(): drive_v3.Drive {
  g.__prepDrive ??= google.drive({
    version: "v3",
    auth: new google.auth.JWT({ email: env.gcp.clientEmail, key: env.gcp.privateKey, scopes: ["https://www.googleapis.com/auth/drive.readonly"] }),
  });
  return g.__prepDrive;
}

export function driveFileId(url: string): string | null {
  if (!/^https:\/\/(docs|drive)\.google\.com\//i.test(url)) return null;
  const m = url.match(/\/d\/([\w-]{20,})/) ?? url.match(/[?&]id=([\w-]{20,})/);
  return m ? m[1] : null;
}

async function one(fileId: string): Promise<DocMeta | null> {
  const hit = cache.get(fileId);
  if (hit && Date.now() - hit.at < TTL) return hit.v;
  let v: DocMeta | null = null;
  try {
    const res = await drive().files.get({ fileId, fields: "name,modifiedTime", supportsAllDrives: true }, { timeout: 6_000 });
    if (res.data.modifiedTime) v = { name: res.data.name ?? "", modifiedAt: res.data.modifiedTime };
  } catch {
    v = null;
  }
  cache.set(fileId, { at: Date.now(), v });
  if (cache.size > 5_000) cache.clear();
  return v;
}

/** Metadata for many links, 6 at a time, within ~8 s overall. */
export async function docMetaFor(urls: string[]): Promise<Map<string, DocMeta | null>> {
  const ids = [...new Set(urls.map(driveFileId).filter((x): x is string => Boolean(x)))].slice(0, 40);
  const out = new Map<string, DocMeta | null>();
  let i = 0;
  const worker = async () => {
    while (i < ids.length) {
      const id = ids[i++];
      out.set(id, await one(id));
    }
  };
  await Promise.race([Promise.all(Array.from({ length: 6 }, worker)), new Promise((r) => setTimeout(r, 8_000))]);
  return out;
}
