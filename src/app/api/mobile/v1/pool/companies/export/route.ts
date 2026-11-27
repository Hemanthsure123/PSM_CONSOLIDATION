import { fail, withUser } from "@/lib/mobile/http";
import { companiesForExport } from "@/lib/mobile/pool/companies";
import { type CompanyFilter, type CompanySort, isCompanySort, isDay, isStateFilter } from "@/lib/mobile/pool/companies-model";
import { companiesWorkbook, XLSX_MIME } from "@/lib/mobile/pool/companies-xlsx";

/**
 * GET /pool/companies/export?state=&from=&to=&mine=&sort=&q= — the Companies list as an Excel file
 * (one row per requirement), with the screen's filters, so the file matches what the user sees.
 * Default: every drive, CTC high → low then openings.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STATE_LABEL: Record<string, string> = { in_progress: "In progress", waiting: "Waiting", on_hold: "On hold", done: "Done", active: "Not done", all: "All" };
const SORT_LABEL: Record<CompanySort, string> = { activity: "latest activity", ctc: "CTC high → low, then openings", openings: "openings high → low", crp: "CRP newest first" };

export const GET = withUser(async (req, { user }) => {
  const url = new URL(req.url);
  const p = (k: string) => url.searchParams.get(k)?.trim() || null;
  const state = p("state") ?? "all";
  const sort = p("sort") ?? "ctc";
  const from = p("from");
  const to = p("to");
  if (!isStateFilter(state)) return fail(400, "Unknown state filter.", "invalid_filter");
  if (!isCompanySort(sort)) return fail(400, "Unknown sort.", "invalid_filter");
  if ((from && !isDay(from)) || (to && !isDay(to)) || (from && to && to < from)) return fail(400, "from and to are dates (YYYY-MM-DD), from first.", "invalid_filter");
  const q = (p("q") ?? "").slice(0, 80);
  const filter: CompanyFilter = { state, from, to, mine: p("mine") === "1" || p("mine") === "true", q };
  const { list, meta } = await companiesForExport(user, filter, sort);
  const filters = [
    `Progress: ${STATE_LABEL[state]}`,
    from || to ? `CRP period: ${from ?? "…"} to ${to ?? "…"}` : "CRP period: all",
    filter.mine ? "Only drives with my candidates" : "",
    q ? `Search: "${q}"` : "",
    `Sorted by ${SORT_LABEL[sort]}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const now = new Date();
  const bytes = await companiesWorkbook(list, sort, { ...meta, generatedAt: now, generatedBy: user.name, filters }, { from, to });
  const day = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const name = `Academy-companies-${day}.xlsx`;
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": XLSX_MIME,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
    },
  });
});
