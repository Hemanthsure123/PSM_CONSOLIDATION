import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { RESUME_MAX_BYTES } from "@/lib/mobile/pool/parse";
import { addResume } from "@/lib/mobile/pool/resumes";

/**
 * POST /pool/{uid}/resumes (multipart: file, stack, best "true"|"false", note?) — an updated resume
 * (PDF / DOC / DOCX, ≤ 10 MB) saved to the team Google Drive. Returns the candidate.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = withUser<{ uid: string }>(async (req, { user }, { uid }) => {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > RESUME_MAX_BYTES + 256 * 1024) return fail(413, "The resume is larger than 10 MB.", "file_too_large");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !file || typeof file === "string") return fail(400, 'Attach the resume as "file".', "invalid_body");
  const detail = await addResume(
    user,
    uid,
    { bytes: Buffer.from(await file.arrayBuffer()), mime: file.type || "application/octet-stream", name: file.name || "resume.pdf" },
    { stack: form.get("stack"), best: form.get("best"), note: form.get("note") },
  );
  return NextResponse.json(detail, { status: 201 });
});
