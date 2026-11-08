import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { contactsFor } from "@/lib/team/prep";

/**
 * POST /preps/contacts { prepIds: [id] } — the emails of the candidates picked for a guidance
 * session (any jobs, at most 100): { items: [{ prepId, candidate, company, round, contact }] }.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const POST = withUser(async (req) => {
  const body = await readJson<{ prepIds?: unknown }>(req);
  if (!body) return fail(400, "Send a JSON body.", "invalid_body");
  return NextResponse.json({ items: await contactsFor(body.prepIds) }, { headers: { "Cache-Control": "no-store" } });
});
