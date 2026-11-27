import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { importStarts } from "@/lib/mobile/pool/companies";

/**
 * POST /pool/companies/import — multipart/form-data, field "file": an exported Companies .xlsx with
 * the "Tentative start date" column filled (at most 5 MB). A filled date sets the requirement's
 * tentative start (source "import"); an empty cell changes nothing.
 * 200 {applied, unchanged, unknown, invalid: [{row, reason}]}.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 5 * 1024 * 1024;

export const POST = withUser(async (req, { user }) => {
  const size = Number(req.headers.get("content-length") ?? 0);
  if (size > MAX_BYTES + 64 * 1024) return fail(413, "The file is larger than 5 MB.", "too_large");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") return fail(400, "Attach the Excel file (field \"file\").", "invalid_file");
  if (file.size > MAX_BYTES) return fail(413, "The file is larger than 5 MB.", "too_large");
  const bytes = Buffer.from(await file.arrayBuffer());
  // .xlsx files are zip archives: "PK\x03\x04".
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return fail(400, "This isn't an Excel (.xlsx) file.", "invalid_file");
  return NextResponse.json(await importStarts(user, bytes), { headers: { "Cache-Control": "no-store" } });
});
