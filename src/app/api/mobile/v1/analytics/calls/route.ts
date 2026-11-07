import { NextResponse } from "next/server";
import { fail, withUser } from "@/lib/mobile/http";
import { callAnalytics } from "@/lib/team/recordings";

/**
 * GET /analytics/calls?from=YYYY-MM-DD&to=YYYY-MM-DD — prep calls per mentor (count, total and
 * average duration from the recordings themselves), team totals and a daily series. Admins and
 * leads see everyone; members see their own.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export const GET = withUser(async (req, { user }) => {
  const sp = new URL(req.url).searchParams;
  const to = sp.get("to") ?? istToday();
  const from = sp.get("from") ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  if (!DAY.test(from) || !DAY.test(to) || from > to) return fail(422, "from / to must be days (YYYY-MM-DD), from first.", "invalid_query");
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 366 * 86_400_000) return fail(422, "Ask for at most a year.", "invalid_query");
  const everyone = user.role === "admin" || user.role === "lead";
  return NextResponse.json(await callAnalytics(from, to, everyone ? null : user.email), { headers: { "Cache-Control": "no-store" } });
});
