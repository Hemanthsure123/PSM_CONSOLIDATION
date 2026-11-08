import { withUser } from "@/lib/mobile/http";
import { resumeFile } from "@/lib/mobile/pool/resumes";

/** GET /pool/resumes/{id}/file — the resume itself, streamed through the server (no Drive sharing needed). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = withUser<{ resumeId: string }>(async (_req, { user }, { resumeId }) => {
  const f = await resumeFile(user, resumeId);
  const ascii = f.fileName.replace(/[^\x20-\x7e]+/g, "_").replace(/"/g, "'");
  return new Response(new Uint8Array(f.bytes), {
    headers: {
      "Content-Type": f.mime,
      "Content-Length": String(f.bytes.length),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.fileName)}`,
      "Cache-Control": "private, no-store",
    },
  });
});
