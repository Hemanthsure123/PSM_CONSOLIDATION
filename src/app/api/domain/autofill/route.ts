import { NextResponse } from "next/server";
import { autofillDomain } from "@/lib/domain-autofill";
import { AUTOFILL_MAX_BYTES, AUTOFILL_MAX_TEXT } from "@/lib/domain-autofill-rules";

/**
 * Domain Shortlisting — draft "What defines it" and "Mandatory skills" from a job
 * description. multipart/form-data: `text` (pasted JD or notes), `file` (PDF, .docx,
 * text / HTML or an image), `domainName` (what's typed so far). Returns the draft;
 * the browser shows it for review and nothing is applied without the user's click.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Send the job description as form data." }, { status: 400 });
  }
  const text = String(form.get("text") ?? "").slice(0, AUTOFILL_MAX_TEXT);
  const domainName = String(form.get("domainName") ?? "").slice(0, 200);
  const raw = form.get("file");
  let file: { name: string; type: string; data: Buffer } | null = null;
  if (raw && typeof raw === "object" && "arrayBuffer" in raw && (raw as File).size > 0) {
    const f = raw as File;
    if (f.size > AUTOFILL_MAX_BYTES) {
      return NextResponse.json({ error: `The file is larger than ${AUTOFILL_MAX_BYTES / 1024 / 1024} MB.` }, { status: 413 });
    }
    file = { name: f.name.slice(0, 200), type: f.type, data: Buffer.from(await f.arrayBuffer()) };
  }
  if (!file && !text.trim()) {
    return NextResponse.json({ error: "Paste the job description or upload it first." }, { status: 400 });
  }
  try {
    const result = await autofillDomain({ text, file, domainName });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ result: result.data });
  } catch (err) {
    console.error("[domain-autofill] crashed:", err);
    return NextResponse.json({ error: "Could not read the job description — try again." }, { status: 500 });
  }
}
