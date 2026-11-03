import { NextResponse } from "next/server";
import { databaseConfigured } from "@/lib/db/client";
import { importScores } from "@/lib/pool/scores/sync";
import { parseCsv } from "@/lib/utils";

/**
 * Assessment scores — import one CSV export. multipart/form-data: `file` (.csv), optional
 * `examDate` (YYYY-MM-DD, for an offline exam whose file name has no date) and `allowShrink`
 * ("1" = the user confirmed an export that removes many stored scores). The kind of sheet is
 * read from its headers. One file per request, so each import stays short.
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
  if (file.size > MAX_BYTES) return NextResponse.json({ error: `The file is larger than ${MAX_BYTES / 1024 / 1024} MB.` }, { status: 413 });
  const examDate = String(form.get("examDate") ?? "").trim();
  if (examDate && !/^\d{4}-\d{2}-\d{2}$/.test(examDate)) return NextResponse.json({ error: "Write the exam date as YYYY-MM-DD." }, { status: 400 });

  const name = file.name.slice(0, 200);
  const table = parseCsv((await file.text()).replace(/^﻿/, ""));
  const result = await importScores(
    { mode: "csv", sourceRef: name, fileName: name, table, examDate: examDate || undefined, allowShrink: form.get("allowShrink") === "1" },
    "dashboard-upload",
  );
  return NextResponse.json({ result }, { status: result.ok ? 200 : result.needsConfirm ? 409 : 422 });
}
