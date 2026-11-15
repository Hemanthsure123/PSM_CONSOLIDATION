import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { releaseBytes } from "@/lib/mobile/releases";

/**
 * GET /app/releases/{versionCode}/apk — the APK in parts of at most 8 MB. "Range: bytes=start-[end]"
 * is answered with 206 (a dropped download resumes where it stopped); without a Range header the
 * first part comes back (200 when that is the whole file). X-Content-SHA256 lets the phone verify the
 * whole file before installing.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Parts of at most 8 MB per request keep the server's memory low. */
const MAX_PART = 8 * 1024 * 1024;

export const GET = withUser<{ versionCode: string }>(async (req, _ctx, { versionCode }) => {
  const code = Number(versionCode);
  if (!Number.isInteger(code) || code <= 0) return fail(404, "This version doesn't exist.", "not_found");
  const header = req.headers.get("range");
  const m = header?.match(/^bytes=(\d+)-(\d*)$/);
  if (header && !m) return fail(416, "Unsupported range.", "range_not_satisfiable");
  const start = m ? Number(m[1]) : 0;
  const askedEnd = m && m[2] ? Number(m[2]) : Number.MAX_SAFE_INTEGER;
  const end = Math.min(askedEnd, start + MAX_PART - 1);
  const part = await releaseBytes(code, { start, end });
  if (!part) return fail(404, "This version is no longer available. Check for updates again.", "not_found");
  const last = start + part.bytes.length - 1;
  const whole = start === 0 && last === part.total - 1;
  return new NextResponse(new Uint8Array(part.bytes), {
    status: whole ? 200 : 206,
    headers: {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Length": String(part.bytes.length),
      "Accept-Ranges": "bytes",
      ...(whole ? {} : { "Content-Range": `bytes ${start}-${last}/${part.total}` }),
      "X-Content-SHA256": part.sha256,
      "Cache-Control": "private, no-store",
    },
  });
});
