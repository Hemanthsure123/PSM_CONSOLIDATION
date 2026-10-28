import { NextResponse } from "next/server";
import { mandatoryItem } from "@/lib/showcase/profile-autofill";

/**
 * Sample profiles from job descriptions — the catalogued technologies each mandatory item names
 * (for items typed or edited by hand). JSON body: { items: [{ item, quote }] }. No model.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { items?: unknown } | null;
  if (!Array.isArray(body?.items)) return NextResponse.json({ error: "Send { items: [{ item, quote }] }." }, { status: 400 });
  const items = body.items.slice(0, 12).map((x) => {
    const o = (x && typeof x === "object" ? x : {}) as { item?: unknown; quote?: unknown };
    return mandatoryItem(String(o.item ?? "").replace(/\s+/g, " ").trim().slice(0, 80), String(o.quote ?? "").slice(0, 300));
  });
  return NextResponse.json({ items: items.filter((m) => m.item) });
}
