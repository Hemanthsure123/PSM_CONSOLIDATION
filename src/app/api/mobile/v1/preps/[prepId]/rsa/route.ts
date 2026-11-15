import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { MAX_RSA_RECORDING_BYTES, MAX_RSA_RESUME_BYTES, rsaOverview, startRsa } from "@/lib/rsa/service";

/**
 * GET /preps/{prepId}/rsa — the prep's RSA document (if any), the job's drill-downs (with tabs) to
 * pick from, the resume link on the row, whether a recording is already saved, the run in progress.
 * POST /preps/{prepId}/rsa (multipart) — create the RSA document, or update it in place (same
 * link, no second sheet row). Fields: drilldownUrl (required), tabs (JSON array of tab ids, when the
 * drill-down has several), recording (audio file; required unless one is already saved), callAt
 * (ISO), resumeUrl or resume (PDF / .docx file; one is required), remarks (optional). Returns the
 * run (202); poll GET /preps/rsa-runs/{runId}.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const GET = withUser<{ prepId: string }>(async (_req, { user }, { prepId }) => {
  if (!/^[0-9a-f]{24}$/.test(prepId)) return fail(404, "This prep doesn't exist.", "not_found");
  return NextResponse.json(await rsaOverview(user, prepId), { headers: { "Cache-Control": "no-store" } });
});

const fileOf = async (v: FormDataEntryValue | null) =>
  v && typeof v !== "string" && v.size > 0 ? { bytes: Buffer.from(await v.arrayBuffer()), mime: v.type || "application/octet-stream", name: v.name || "file" } : null;

const tabsOf = (v: FormDataEntryValue | null): string[] => {
  if (typeof v !== "string" || !v.trim()) return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).slice(0, 50) : [];
  } catch {
    return v.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 50);
  }
};

export const POST = withUser<{ prepId: string }>(async (req, { user }, { prepId }) => {
  if (!/^[0-9a-f]{24}$/.test(prepId)) return fail(404, "This prep doesn't exist.", "not_found");
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_RSA_RECORDING_BYTES + MAX_RSA_RESUME_BYTES + 1024 * 1024) return fail(413, "The upload is too large (recording up to 40 MB, resume up to 10 MB).", "upload_too_large");
  const form = await req.formData().catch(() => null);
  if (!form) return fail(400, "Send the RSA inputs as multipart form data.", "invalid_body");
  const callAt = new Date(String(form.get("callAt") ?? ""));
  const run = await startRsa(user, prepId, {
    recording: await fileOf(form.get("recording")),
    callAt: Number.isFinite(callAt.getTime()) && callAt.getTime() <= Date.now() + 5 * 60_000 ? callAt : null,
    drilldownUrl: String(form.get("drilldownUrl") ?? ""),
    tabs: tabsOf(form.get("tabs")),
    resumeUrl: String(form.get("resumeUrl") ?? ""),
    resumeFile: await fileOf(form.get("resume")),
    remarks: String(form.get("remarks") ?? ""),
  });
  return NextResponse.json(run, { status: 202 });
});
