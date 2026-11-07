import "server-only";
import { Readable } from "node:stream";
import { google, type drive_v3 } from "googleapis";
import { withTeam } from "@/lib/team/google";

/**
 * Files owned by the team Google account: prep documents (Google Docs converted from HTML on
 * upload), prep-call recordings and their transcripts. Everything lives under the prep documents
 * folder (PREP_DOCS_DRIVE_FOLDER_ID), or a "PSM Prep Documents" folder the server creates.
 */

const g = globalThis as unknown as { __teamFolders?: Map<string, string> };
const folders = (g.__teamFolders ??= new Map());

const drive = (auth: Parameters<Parameters<typeof withTeam>[0]>[0]): drive_v3.Drive => google.drive({ version: "v3", auth });
const qs = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** The root folder for everything the app files (configured, else created once in My Drive). */
export async function rootFolder(): Promise<string> {
  const hit = folders.get("root");
  if (hit) return hit;
  return withTeam(async (auth) => {
    const d = drive(auth);
    const configured = process.env.PREP_DOCS_DRIVE_FOLDER_ID?.trim();
    if (configured) {
      const f = await d.files.get({ fileId: configured, fields: "id,trashed,mimeType", supportsAllDrives: true }).catch(() => null);
      if (f?.data.id && !f.data.trashed && f.data.mimeType === "application/vnd.google-apps.folder") {
        folders.set("root", f.data.id);
        return f.data.id;
      }
    }
    const found = await d.files.list({ q: "name = 'PSM Prep Documents' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false", fields: "files(id)" });
    const id =
      found.data.files?.[0]?.id ??
      (await d.files.create({ requestBody: { name: "PSM Prep Documents", mimeType: "application/vnd.google-apps.folder" }, fields: "id" })).data.id!;
    folders.set("root", id);
    return id;
  });
}

/** A sub-folder of the root ("Prep call recordings" …), created on first use. */
export async function subFolder(name: string): Promise<string> {
  const hit = folders.get(name);
  if (hit) return hit;
  const root = await rootFolder();
  return withTeam(async (auth) => {
    const d = drive(auth);
    const found = await d.files.list({
      q: `name = '${qs(name)}' and mimeType = 'application/vnd.google-apps.folder' and '${root}' in parents and trashed = false`,
      fields: "files(id)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const id =
      found.data.files?.[0]?.id ??
      (await d.files.create({ requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [root] }, fields: "id", supportsAllDrives: true })).data.id!;
    folders.set(name, id);
    return id;
  });
}

/** An existing prep document for this company + round in the folder (the prompt's "check before creating"). */
export async function findPrepDoc(company: string, round: string): Promise<{ id: string; url: string; name: string } | null> {
  const root = await rootFolder();
  return withTeam(async (auth) => {
    const res = await drive(auth).files.list({
      q: `'${root}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.document' and name contains '${qs(company.split(/\s+-\s+|\s*\|\s*/)[0].trim())}'`,
      fields: "files(id,name,webViewLink)",
      pageSize: 50,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const r = norm(round);
    const hit = (res.data.files ?? []).find((f) => !r || norm(f.name ?? "").includes(r));
    return hit?.id ? { id: hit.id, url: hit.webViewLink ?? `https://docs.google.com/document/d/${hit.id}/edit`, name: hit.name ?? "" } : null;
  });
}

/** Anyone with the link can view (the team chose view-only links for everyone). */
export async function shareViewOnly(fileId: string): Promise<void> {
  await withTeam(async (auth) => {
    const d = drive(auth);
    const perms = await d.permissions.list({ fileId, fields: "permissions(id,type,role)", supportsAllDrives: true });
    if ((perms.data.permissions ?? []).some((p) => p.type === "anyone")) return;
    await d.permissions.create({ fileId, requestBody: { type: "anyone", role: "reader", allowFileDiscovery: false }, supportsAllDrives: true });
  });
}

export async function createGoogleDoc(title: string, html: string, folderId?: string): Promise<{ id: string; url: string }> {
  const parent = folderId ?? (await rootFolder());
  return withTeam(async (auth) => {
    const res = await drive(auth).files.create({
      requestBody: { name: title, mimeType: "application/vnd.google-apps.document", parents: [parent] },
      media: { mimeType: "text/html", body: Readable.from([html]) },
      fields: "id,webViewLink",
      supportsAllDrives: true,
    });
    return { id: res.data.id!, url: res.data.webViewLink ?? `https://docs.google.com/document/d/${res.data.id}/edit` };
  });
}

/** Replaces a Google Doc's content and title in place (same file, same link). */
export async function replaceGoogleDoc(id: string, title: string, html: string): Promise<{ id: string; url: string }> {
  return withTeam(async (auth) => {
    const res = await drive(auth).files.update({
      fileId: id,
      requestBody: { name: title },
      media: { mimeType: "text/html", body: Readable.from([html]) },
      fields: "id,webViewLink",
      supportsAllDrives: true,
    });
    return { id: res.data.id!, url: res.data.webViewLink ?? `https://docs.google.com/document/d/${id}/edit` };
  });
}

export async function readGoogleDocText(id: string): Promise<string> {
  return withTeam(async (auth) => {
    const res = await drive(auth).files.export({ fileId: id, mimeType: "text/plain" }, { responseType: "text" });
    return String(res.data ?? "");
  });
}

/** Uploads a file (a call recording, a transcript as a Google Doc). */
export async function uploadFile(
  name: string,
  mimeType: string,
  body: Buffer | string,
  folderId: string,
  convertTo?: string,
): Promise<{ id: string; url: string }> {
  return withTeam(async (auth) => {
    const res = await drive(auth).files.create({
      requestBody: { name, parents: [folderId], ...(convertTo ? { mimeType: convertTo } : {}) },
      media: { mimeType, body: Readable.from([body]) },
      fields: "id,webViewLink",
      supportsAllDrives: true,
    });
    return { id: res.data.id!, url: res.data.webViewLink ?? `https://drive.google.com/file/d/${res.data.id}/view` };
  });
}

/** Gives named people view access (no email notification). */
export async function shareWith(fileId: string, emails: string[]): Promise<void> {
  await withTeam(async (auth) => {
    const d = drive(auth);
    for (const email of [...new Set(emails.filter(Boolean))]) {
      await d.permissions
        .create({ fileId, sendNotificationEmail: false, requestBody: { type: "user", role: "reader", emailAddress: email }, supportsAllDrives: true })
        .catch(() => undefined);
    }
  });
}

/** Downloads a file the team account owns (a recording to transcribe again after a failure). */
export async function downloadFile(fileId: string): Promise<{ bytes: Buffer; mime: string; name: string }> {
  return withTeam(async (auth) => {
    const d = drive(auth);
    const meta = await d.files.get({ fileId, fields: "name,mimeType,size", supportsAllDrives: true });
    const res = await d.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
    return { bytes: Buffer.from(res.data as ArrayBuffer), mime: meta.data.mimeType ?? "application/octet-stream", name: meta.data.name ?? "" };
  });
}
