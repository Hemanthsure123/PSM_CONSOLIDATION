import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { detailsText } from "@/lib/automation/sheet-text";
import { STATUS_LABEL } from "@/lib/automation/types";
import type { JobRow } from "@/lib/automation/store";

/**
 * The automation API's guard and its job summary. Every /api/automation route needs
 * `Authorization: Bearer <AUTOMATION_TOKEN>` (the sheet's Apps Script and future agents) —
 * a separate secret from the site sign-in, so it can be rotated on its own and only reaches
 * these routes. Requests are also limited to the configured spreadsheets and control tabs.
 */

const digest = (s: string) => createHash("sha256").update(s).digest();

export function checkToken(req: Request): NextResponse | null {
  const expected = process.env.AUTOMATION_TOKEN?.trim();
  if (!expected) return NextResponse.json({ error: "The automation isn't configured on this server (AUTOMATION_TOKEN)." }, { status: 503 });
  const header = req.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!given || !timingSafeEqual(digest(given), digest(expected))) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }
  return null;
}

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const allowedSpreadsheets = () => list(process.env.AUTOMATION_SPREADSHEET_IDS);
export const allowedTabs = () => {
  const tabs = list(process.env.AUTOMATION_CONTROL_TABS);
  return tabs.length ? tabs : ["Profile Shortlisting - New"];
};

export function jobSummary(job: JobRow, extra: { queueAhead?: number } = {}) {
  return {
    id: job.id,
    status: STATUS_LABEL[job.status],
    step: job.step,
    progress: job.progress,
    result: job.result,
    error: job.error,
    attempts: job.attempts,
    control: { spreadsheetId: job.spreadsheetId, tab: job.controlTab, row: job.controlRow },
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    updatedAt: job.updatedAt,
    details: detailsText({ jobId: job.id, status: job.status, step: job.step, progress: job.progress, result: job.result, error: job.error, queueAhead: extra.queueAhead }),
  };
}
