import { NextResponse } from "next/server";
import { databaseConfigured } from "@/lib/db/client";
import { detectProduct } from "@/lib/pool/parse";
import { syncPool } from "@/lib/pool/sync";
import { PRODUCTS, PRODUCT_LABEL, type Product } from "@/lib/pool/types";
import { parseCsv } from "@/lib/utils";

/**
 * Eligible pool — upload a CSV export of a product's sheet. multipart/form-data:
 * `file` (.csv) and `product` ("auto" reads it from the headers). New people are
 * added and changed records overwritten; people missing from the file are kept, so a
 * file with only the new rows works too.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_BYTES = 15 * 1024 * 1024;

export async function POST(req: Request) {
  if (!databaseConfigured()) {
    return NextResponse.json({ error: "The database isn't configured: set DATABASE_URL in .env.local." }, { status: 503 });
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Send the CSV as form data." }, { status: 400 });
  }
  const raw = form.get("file");
  if (!raw || typeof raw !== "object" || !("arrayBuffer" in raw) || (raw as File).size === 0) {
    return NextResponse.json({ error: "Choose a CSV file first." }, { status: 400 });
  }
  const file = raw as File;
  if (!/\.csv$/i.test(file.name) && !/csv|text\/plain/i.test(file.type)) {
    return NextResponse.json({ error: "Upload a .csv file (File › Download › Comma-separated values in Google Sheets)." }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `The file is larger than ${MAX_BYTES / 1024 / 1024} MB.` }, { status: 413 });
  }

  const table = parseCsv((await file.text()).replace(/^﻿/, ""));
  const detected = detectProduct(table);
  const asked = String(form.get("product") ?? "auto");
  if (asked !== "auto" && !PRODUCTS.includes(asked as Product)) {
    return NextResponse.json({ error: `Unknown product "${asked}".` }, { status: 400 });
  }
  if (!detected) {
    return NextResponse.json(
      { error: "This CSV doesn't look like an Edge 1.0, Edge 2.0 or Academy pool sheet — its header row has none of their key columns." },
      { status: 422 },
    );
  }
  if (asked !== "auto" && asked !== detected) {
    return NextResponse.json(
      { error: `This CSV looks like ${PRODUCT_LABEL[detected]}'s sheet, not ${PRODUCT_LABEL[asked as Product]}'s. Pick ${PRODUCT_LABEL[detected]} or "Detect the product from the headers".` },
      { status: 422 },
    );
  }
  const result = await syncPool(detected, { mode: "csv", fileName: file.name.slice(0, 200), table }, "dashboard-upload");
  return NextResponse.json({ result }, { status: result.ok ? 200 : 422 });
}
