import { NextResponse } from "next/server";
import { jdInputFromForm } from "@/lib/jd-source";
import { autofillProfile } from "@/lib/showcase/profile-autofill";

/**
 * Sample profiles from job descriptions — draft one profile and every input from a JD or any
 * context about the role. multipart/form-data: `text` (pasted JD / notes) and / or `file` (PDF,
 * .docx, text / HTML or an image). Returns the draft; the browser shows it for review and nothing
 * is applied without the user's click.
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
  const got = await jdInputFromForm(form);
  if (!got.ok) return NextResponse.json({ error: got.error }, { status: got.status });
  try {
    const result = await autofillProfile(got.input);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ result: result.data });
  } catch (err) {
    console.error("[showcase-autofill] crashed:", err);
    return NextResponse.json({ error: "Could not read the job description — try again." }, { status: 500 });
  }
}
