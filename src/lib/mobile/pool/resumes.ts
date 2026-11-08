import "server-only";
import { query, transaction } from "@/lib/db/client";
import { UserError } from "@/lib/mobile/http";
import { dayOf } from "@/lib/mobile/preps/parse";
import type { RosterUser } from "@/lib/mobile/roster";
import { cleanStack, RESUME_MAX_BYTES, resumeFileName, resumeType } from "@/lib/mobile/pool/parse";
import { assertPoolAccess, poolDetail } from "@/lib/mobile/pool/service";
import { downloadFile, subFolder, uploadFile } from "@/lib/team/drive";

/**
 * Updated resumes mentors collect for their candidates. Files go to the team Google Drive (folder
 * "Academy pool resumes" under the app's root folder), owned by the team account, so they outlive
 * any one person's access. Each resume has one tech stack; marking one "best" for a stack unmarks
 * the previous best of that stack. Removing a resume hides it (the Drive file stays, for audit).
 */

const FOLDER = "Academy pool resumes";
const MAX_PER_CANDIDATE = 30;

interface ResumeRow {
  id: string;
  uid: string;
  stack: string;
  best: boolean;
  file_name: string;
  mime: string;
  size_bytes: number;
  note: string | null;
  drive_file_id: string;
  uploaded_by: string;
  created_at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A resume of a candidate the user can see (404 otherwise). */
async function resumeOf(user: RosterUser, id: string): Promise<ResumeRow> {
  if (!UUID.test(id)) throw new UserError(404, "This resume doesn't exist.", "not_found");
  const r = (await query<ResumeRow>("select * from app.pool_resumes where id = $1 and deleted_at is null", [id]))[0];
  if (!r) throw new UserError(404, "This resume doesn't exist.", "not_found");
  await assertPoolAccess(user, r.uid);
  return r;
}

export interface ResumeUpload {
  bytes: Buffer;
  mime: string;
  name: string;
}

export async function addResume(
  user: RosterUser,
  uid: string,
  file: ResumeUpload,
  fields: { stack: unknown; best: unknown; note: unknown },
) {
  const { name } = await assertPoolAccess(user, uid);
  const stack = cleanStack(fields.stack);
  if (!stack) throw new UserError(422, "Pick the tech stack this resume is for.", "invalid_stack");
  if (!file.bytes.length) throw new UserError(422, "The file is empty.", "invalid_file");
  if (file.bytes.length > RESUME_MAX_BYTES) throw new UserError(413, "The resume is larger than 10 MB.", "file_too_large");
  const type = resumeType(file.mime, file.name);
  if (!type) throw new UserError(415, "Upload a PDF or Word file (.pdf, .doc, .docx).", "invalid_file");
  // The first bytes must match the type: a renamed image or a broken download is refused.
  const head = file.bytes.subarray(0, 8);
  const looksRight =
    type.ext === "pdf" ? head.subarray(0, 5).toString("latin1") === "%PDF-" :
    type.ext === "docx" ? head[0] === 0x50 && head[1] === 0x4b :
    head[0] === 0xd0 && head[1] === 0xcf;
  if (!looksRight) throw new UserError(415, `This file isn't a valid ${type.ext.toUpperCase()}.`, "invalid_file");
  const note = String(fields.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || null;
  const best = fields.best === true || fields.best === "true";
  const count = await query<{ n: number }>("select count(*)::int n from app.pool_resumes where uid = $1 and deleted_at is null", [uid]);
  if ((count[0]?.n ?? 0) >= MAX_PER_CANDIDATE) throw new UserError(422, `A candidate can have at most ${MAX_PER_CANDIDATE} resumes. Remove an old one first.`, "too_many_resumes");

  const folder = await subFolder(FOLDER);
  const fileName = resumeFileName(name, stack, dayOf(new Date()), type.ext);
  const uploaded = await uploadFile(fileName, type.mime, file.bytes, folder);
  try {
    await transaction(async (tx) => {
      if (best) {
        await tx.query("update app.pool_resumes set best = false, updated_at = now() where uid = $1 and lower(stack) = lower($2) and best and deleted_at is null", [uid, stack]);
      }
      await tx.query(
        `insert into app.pool_resumes (uid, stack, best, file_name, mime, size_bytes, drive_file_id, drive_url, note, uploaded_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [uid, stack, best, fileName, type.mime, file.bytes.length, uploaded.id, uploaded.url, note, user.email],
      );
      await tx.query("insert into app.pool_events (uid, actor_email, action, value) values ($1, $2, 'resume_added', $3)", [
        uid,
        user.email,
        `${stack}${best ? " (best)" : ""}`,
      ]);
    });
  } catch (err) {
    console.warn("[pool] resume saved to Drive but not recorded:", uploaded.id, err instanceof Error ? err.message.slice(0, 160) : err);
    throw err;
  }
  return poolDetail(user, uid);
}

/** Changes a resume's stack, best flag or note. */
export async function updateResume(user: RosterUser, id: string, input: { stack?: unknown; best?: unknown; note?: unknown }) {
  const r = await resumeOf(user, id);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  const stack = has("stack") ? cleanStack(input.stack) : r.stack;
  if (!stack) throw new UserError(422, "Pick the tech stack this resume is for.", "invalid_stack");
  const best = has("best") ? input.best === true : r.best;
  const note = has("note") ? String(input.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || null : r.note;
  await transaction(async (tx) => {
    if (best) {
      await tx.query("update app.pool_resumes set best = false, updated_at = now() where uid = $1 and lower(stack) = lower($2) and best and deleted_at is null and id <> $3", [r.uid, stack, id]);
    }
    await tx.query("update app.pool_resumes set stack = $2, best = $3, note = $4, updated_at = now() where id = $1", [id, stack, best, note]);
    const what = [stack !== r.stack ? `stack ${stack}` : "", best !== r.best ? (best ? "marked best" : "unmarked best") : ""].filter(Boolean).join(", ");
    if (what) await tx.query("insert into app.pool_events (uid, actor_email, action, value) values ($1, $2, 'resume_updated', $3)", [r.uid, user.email, what]);
  });
  return poolDetail(user, r.uid);
}

export async function removeResume(user: RosterUser, id: string) {
  const r = await resumeOf(user, id);
  await transaction(async (tx) => {
    await tx.query("update app.pool_resumes set deleted_at = now(), deleted_by = $2, best = false, updated_at = now() where id = $1", [id, user.email]);
    await tx.query("insert into app.pool_events (uid, actor_email, action, value) values ($1, $2, 'resume_removed', $3)", [r.uid, user.email, r.stack]);
  });
  return poolDetail(user, r.uid);
}

/** The file, streamed through the server (works on every phone, no Drive sharing needed). */
export async function resumeFile(user: RosterUser, id: string): Promise<{ bytes: Buffer; mime: string; fileName: string }> {
  const r = await resumeOf(user, id);
  const f = await downloadFile(r.drive_file_id).catch((err) => {
    console.warn("[pool] resume download failed:", r.drive_file_id, err instanceof Error ? err.message.slice(0, 160) : err);
    throw new UserError(502, "Google Drive didn't return this resume. Try again in a minute.", "drive_unavailable");
  });
  return { bytes: f.bytes, mime: r.mime, fileName: r.file_name };
}

