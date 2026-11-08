import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { MAX_RECORDING_BYTES, uploadPhoneRecording } from "@/lib/team/recordings";

/**
 * POST /preps/{prepId}/recordings (multipart: file, callAt ISO, durationSec, deviceKey) — submit a
 * prep call the phone recorded. Saved to the team Drive before the response; the transcript and
 * summary are then written to the row's Prep Call columns (never stored in the database), and the
 * real duration counts in call analytics. Submitting the same deviceKey again returns that call.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const POST = withUser<{ prepId: string }>(async (req, { user }, { prepId }) => {
  if (!/^[0-9a-f]{24}$/.test(prepId)) return fail(404, "This prep doesn't exist.", "not_found");
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_RECORDING_BYTES + 1024 * 1024) return fail(413, "The recording is larger than 40 MB.", "recording_too_large");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !file || typeof file === "string") return fail(400, "Attach the recording as \"file\".", "invalid_body");
  const recording = await uploadPhoneRecording(
    user,
    prepId,
    { bytes: Buffer.from(await file.arrayBuffer()), mime: file.type || "application/octet-stream", name: file.name || "call.m4a" },
    { callAt: new Date(String(form.get("callAt") ?? "")), durationSec: Number(form.get("durationSec")), deviceKey: String(form.get("deviceKey") ?? "") },
  );
  return NextResponse.json(recording);
});
