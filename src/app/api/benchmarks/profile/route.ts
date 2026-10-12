import { NextResponse } from "next/server";
import { buildDomainProfile } from "@/lib/benchmark-evaluator";

/**
 * Turn the domain the user typed ("Generative AI", "MERN Stack" …) into the
 * domain profile every resume of the run is screened against. One model call
 * per run.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  let body: { domain?: unknown; focus?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const domain = typeof body.domain === "string" ? body.domain : "";
  const focus = typeof body.focus === "string" ? body.focus : "";
  if (!domain.trim()) return NextResponse.json({ error: "Type the domain to screen for." }, { status: 400 });

  const res = await buildDomainProfile(domain, focus);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  return NextResponse.json({ profile: res.profile });
}
