import { NextResponse } from "next/server";
import { probeGithub } from "@/lib/showcase/github-probe";

/** Sample profiles: one GraphQL look at a GitHub account (type, name, own repositories). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  let body: { login?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  return NextResponse.json({ result: await probeGithub(String(body.login ?? "").trim()) });
}
