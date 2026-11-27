import "server-only";
import { query } from "@/lib/db/client";
import { linkOf } from "@/lib/mobile/pool/shares";

/**
 * HubSpot deals linked from the CRPs master (PSM 1.12.0): the JD link and the Nurturing Team Remarks
 * of each requirement's deal, for the Companies screen and its Excel export.
 *
 * HubSpot is owned by another team: this module only ever sends GET requests (one deal by id, the
 * properties named below), never a search, batch or write; any other method throws before a request
 * is made. Calls are paced (MAX_PER_SECOND), at most MAX_PER_RUN per sync run, and a deal is read
 * again at most once a day (a failed one after 6 hours). The token (HUBSPOT_API_KEY) is never logged.
 */

const API = "https://api.hubapi.com";
const PROPERTIES = ["dealname", "jd_link", "job_description_link", "jd_shortened_link", "nurturing_team_remarks"];
export const HUBSPOT_MAX_PER_RUN = 150;
const MAX_PER_SECOND = 4;
const FRESH_MS = 24 * 3_600_000;
const RETRY_FAILED_MS = 6 * 3_600_000;
const REMARKS_MAX = 10_000;

export const hubspotConfigured = () => Boolean(process.env.HUBSPOT_API_KEY?.trim());

export interface HubspotDeal {
  dealName: string;
  jdUrl: string | null;
  remarks: string | null;
}

/** The deal's JD link (jd_link, job_description_link, jd_shortened_link: the first real link) and remarks. Pure. */
export function dealFacts(props: Record<string, unknown>): HubspotDeal {
  const text = (k: string) => (typeof props[k] === "string" ? (props[k] as string) : "");
  const jdUrl = linkOf(text("jd_link")) ?? linkOf(text("job_description_link")) ?? linkOf(text("jd_shortened_link"));
  const remarks = text("nurturing_team_remarks").normalize("NFKC").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return {
    dealName: text("dealname").slice(0, 300),
    jdUrl,
    remarks: remarks ? remarks.slice(0, REMARKS_MAX) : null,
  };
}

type Fetched = { ok: true; deal: HubspotDeal } | { ok: false; status: number; error: string };

/** GET one deal. The only request this module makes. */
async function getDeal(dealId: string): Promise<Fetched> {
  if (!/^\d{3,20}$/.test(dealId)) return { ok: false, status: 400, error: "Not a deal id." };
  const method = "GET";
  const url = `${API}/crm/v3/objects/deals/${dealId}?properties=${PROPERTIES.join(",")}&archived=false`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${process.env.HUBSPOT_API_KEY?.trim() ?? ""}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
    } catch (err) {
      if (attempt < 2) {
        await sleep(1_500 * (attempt + 1));
        continue;
      }
      return { ok: false, status: 0, error: `HubSpot didn't answer: ${err instanceof Error ? err.name : "error"}` };
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 2) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : 2_000 * (attempt + 1));
        continue;
      }
      return { ok: false, status: res.status, error: `HubSpot is busy (${res.status}).` };
    }
    if (res.status === 404) return { ok: false, status: 404, error: "The deal isn't in HubSpot (deleted or merged)." };
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, error: "HubSpot refused the token." };
    if (!res.ok) return { ok: false, status: res.status, error: `HubSpot answered ${res.status}.` };
    const body = (await res.json().catch(() => null)) as { properties?: Record<string, unknown> } | null;
    if (!body?.properties) return { ok: false, status: res.status, error: "HubSpot sent an unreadable answer." };
    return { ok: true, deal: dealFacts(body.properties) };
  }
  return { ok: false, status: 0, error: "HubSpot didn't answer." };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reads the deals that are missing, more than a day old, or failed more than 6 hours ago (at most
 * HUBSPOT_MAX_PER_RUN, never-read first). Never throws; returns how many were read and failed.
 */
export async function refreshHubspotDeals(dealIds: string[]): Promise<{ read: number; failed: number; skipped: boolean }> {
  const ids = [...new Set(dealIds.filter((d) => /^\d{3,20}$/.test(d)))];
  if (!hubspotConfigured() || !ids.length) return { read: 0, failed: 0, skipped: true };
  try {
    const known = await query<{ deal_id: string; fetched_at: Date; error: string | null }>(
      "select deal_id, fetched_at, error from app.hubspot_deals where deal_id = any($1::text[])",
      [ids],
    );
    const byId = new Map(known.map((k) => [k.deal_id, k]));
    const now = Date.now();
    const due = ids
      .map((id) => ({ id, k: byId.get(id) }))
      .filter(({ k }) => !k || now - k.fetched_at.getTime() >= (k.error ? RETRY_FAILED_MS : FRESH_MS))
      .sort((a, b) => (a.k?.fetched_at.getTime() ?? 0) - (b.k?.fetched_at.getTime() ?? 0))
      .slice(0, HUBSPOT_MAX_PER_RUN);
    let read = 0;
    let failed = 0;
    for (const { id } of due) {
      const started = Date.now();
      const r = await getDeal(id);
      if (r.ok) {
        read++;
        await query(
          `insert into app.hubspot_deals (deal_id, deal_name, jd_url, remarks, http_status, error, fetched_at) values ($1, $2, $3, $4, 200, null, now())
           on conflict (deal_id) do update set deal_name = excluded.deal_name, jd_url = excluded.jd_url, remarks = excluded.remarks,
             http_status = 200, error = null, fetched_at = now()`,
          [id, r.deal.dealName, r.deal.jdUrl, r.deal.remarks],
        );
      } else {
        failed++;
        // A failed read keeps what was read before (a busy HubSpot doesn't blank a JD link).
        await query(
          `insert into app.hubspot_deals (deal_id, http_status, error, fetched_at) values ($1, $2, $3, now())
           on conflict (deal_id) do update set http_status = excluded.http_status, error = excluded.error, fetched_at = now()`,
          [id, r.status, r.error.slice(0, 300)],
        );
        if (r.status === 401 || r.status === 403) break; // the token is wrong: stop for this run
      }
      const wait = 1000 / MAX_PER_SECOND - (Date.now() - started);
      if (wait > 0) await sleep(wait);
    }
    if (read || failed) console.log(`[hubspot] deals read: ${read}, failed: ${failed} (GET only)`);
    return { read, failed, skipped: false };
  } catch (err) {
    console.warn("[hubspot] deal refresh failed:", err instanceof Error ? err.message.slice(0, 200) : err);
    return { read: 0, failed: 0, skipped: false };
  }
}
