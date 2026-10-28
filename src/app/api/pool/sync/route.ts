import { NextResponse } from "next/server";
import { databaseConfigured } from "@/lib/db/client";
import { syncPool } from "@/lib/pool/sync";
import { PRODUCTS, type Product } from "@/lib/pool/types";

/**
 * Eligible pool — refetch one product from its Google Sheet. JSON body: { product }.
 * The dashboard calls this once per product, in turn, so each request stays short and
 * the screen can show progress. New people are added, changed records overwritten.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!databaseConfigured()) {
    return NextResponse.json({ error: "The database isn't configured: set DATABASE_URL in .env.local." }, { status: 503 });
  }
  const body = (await req.json().catch(() => null)) as { product?: string } | null;
  const product = body?.product as Product | undefined;
  if (!product || !PRODUCTS.includes(product)) {
    return NextResponse.json({ error: `Say which product to sync: ${PRODUCTS.join(", ")}.` }, { status: 400 });
  }
  const result = await syncPool(product, { mode: "sheet" }, "dashboard");
  return NextResponse.json({ result }, { status: result.ok ? 200 : 502 });
}
