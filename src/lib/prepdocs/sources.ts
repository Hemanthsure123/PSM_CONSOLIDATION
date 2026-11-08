import "server-only";
import { google, type drive_v3 } from "googleapis";
import { getDrive } from "@/lib/drive";
import { docxToText, isZip } from "@/lib/docx-text";
import { pdfBufferToText } from "@/lib/pdf-text";
import { driveFileId } from "@/lib/mobile/preps/links";
import { docsAvailable, readTabsText } from "@/lib/prepdocs/tabs";
import { withTeam } from "@/lib/team/google";

/**
 * The text a prep document is built from: drill-down (hiring intelligence) documents, interview
 * transcripts and the company website. Google Docs are read with the Docs API as the team account
 * (every tab, tables included); other Drive files, and Docs when that account isn't connected, are
 * read through the service account, then the team account's Drive if the file isn't shared with the
 * service account. Personal details are removed before any model sees them.
 */

export interface SourceText {
  url: string;
  kind: "drilldown" | "transcript" | "website";
  title: string;
  modifiedAt: string | null;
  text: string;
  /** Why it couldn't be read (the document is still built from the rest). */
  error?: string;
}

const MAX_DOC_CHARS = 120_000;
const MAX_SITE_CHARS = 20_000;

/** Google Doc / Drive file → plain text. */
export async function readDriveText(url: string): Promise<{ title: string; modifiedAt: string | null; text: string }> {
  const id = driveFileId(url);
  if (!id) throw new Error("Not a Google Drive or Docs link.");
  let meta: drive_v3.Schema$File;
  let drive = getDrive();
  try {
    meta = (await drive.files.get({ fileId: id, fields: "name,mimeType,modifiedTime,size", supportsAllDrives: true })).data;
  } catch (err) {
    // Not shared with the service account: the team account may still see it.
    if (!(await docsAvailable())) throw err;
    const viaTeam = await withTeam(async (auth) => {
      const d = google.drive({ version: "v3", auth });
      return { d, meta: (await d.files.get({ fileId: id, fields: "name,mimeType,modifiedTime,size", supportsAllDrives: true })).data };
    });
    drive = viaTeam.d;
    meta = viaTeam.meta;
  }
  const mime = meta.mimeType ?? "";
  const modifiedAt = meta.modifiedTime ?? null;
  if (mime === "application/vnd.google-apps.document" && (await docsAvailable())) {
    const doc = await readTabsText(id, null);
    return { title: meta.name ?? doc.title, modifiedAt, text: doc.text.slice(0, MAX_DOC_CHARS) };
  }
  let text = "";
  if (mime === "application/vnd.google-apps.document" || mime === "application/vnd.google-apps.presentation") {
    const res = await drive.files.export({ fileId: id, mimeType: "text/plain" }, { responseType: "text" });
    text = String(res.data ?? "");
  } else if (mime === "application/vnd.google-apps.spreadsheet") {
    const res = await drive.files.export({ fileId: id, mimeType: "text/csv" }, { responseType: "text" });
    text = String(res.data ?? "");
  } else {
    if (Number(meta.size ?? 0) > 25 * 1024 * 1024) throw new Error("The file is larger than 25 MB.");
    const res = await drive.files.get({ fileId: id, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
    const buf = Buffer.from(res.data as ArrayBuffer);
    if (mime === "application/pdf") text = await pdfBufferToText(buf);
    else if (isZip(buf)) text = docxToText(buf);
    else if (mime.startsWith("text/")) text = buf.toString("utf8");
    else throw new Error(`This file type can't be read (${mime || "unknown"}).`);
  }
  return { title: meta.name ?? "", modifiedAt, text: text.slice(0, MAX_DOC_CHARS) };
}

/** A public web page → readable text (scripts, styles and tags removed). */
export async function readWebsite(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new Error("Not a web address.");
  const host = new URL(url).hostname;
  // Never fetch internal addresses from the server.
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith(".internal")) {
    throw new Error("That address isn't public.");
  }
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; PSM-PrepDocs/1.0)" }, signal: AbortSignal.timeout(15_000), redirect: "follow" });
  if (!res.ok) throw new Error(`The website answered ${res.status}.`);
  const html = (await res.text()).slice(0, 2_000_000);
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
    .slice(0, MAX_SITE_CHARS);
}

/**
 * Removes personal details before a model reads the text: phone numbers, email addresses and the
 * names of candidates on the job's rows (full names and their first names when distinctive).
 */
export function redact(text: string, names: string[]): string {
  let out = text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/(?:\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, "[phone]");
  const parts = new Set<string>();
  for (const n of names) {
    const full = n.replace(/\s+/g, " ").trim();
    if (full.length >= 3) parts.add(full);
    for (const w of full.split(" ")) if (w.length >= 4) parts.add(w);
  }
  // Longest first, whole words, case-insensitive.
  for (const p of [...parts].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    out = out.replace(re, "the candidate");
  }
  return out;
}

/** A Google Doc limited to some of its tabs (one tab per round, usually). */
async function readDocTabs(url: string, tabs: string[]): Promise<{ title: string; modifiedAt: string | null; text: string }> {
  const id = driveFileId(url);
  if (!id) throw new Error("Not a Google Docs link.");
  const [meta, body] = await Promise.all([
    getDrive().files.get({ fileId: id, fields: "modifiedTime", supportsAllDrives: true }).catch(() => null),
    readTabsText(id, tabs),
  ]);
  return { title: body.title, modifiedAt: meta?.data.modifiedTime ?? null, text: body.text.slice(0, MAX_DOC_CHARS) };
}

export async function readSources(
  picks: { url: string; kind: "drilldown" | "transcript"; tabs?: string[] }[],
  website: string | null,
  names: string[],
): Promise<SourceText[]> {
  const out: SourceText[] = [];
  // Three at a time, so ten documents don't take ten round trips in a row.
  let i = 0;
  const results: SourceText[] = new Array(picks.length);
  const worker = async () => {
    while (i < picks.length) {
      const n = i++;
      const p = picks[n];
      try {
        const r = p.tabs?.length ? await readDocTabs(p.url, p.tabs) : await readDriveText(p.url);
        results[n] = { url: p.url, kind: p.kind, title: r.title, modifiedAt: r.modifiedAt, text: redact(r.text, names) };
      } catch (err) {
        results[n] = { url: p.url, kind: p.kind, title: "", modifiedAt: null, text: "", error: err instanceof Error ? err.message.slice(0, 200) : String(err) };
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  out.push(...results);
  if (website) {
    try {
      out.push({ url: website, kind: "website", title: new URL(website).hostname, modifiedAt: null, text: redact(await readWebsite(website), names) });
    } catch (err) {
      out.push({ url: website, kind: "website", title: website, modifiedAt: null, text: "", error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
  }
  return out;
}
