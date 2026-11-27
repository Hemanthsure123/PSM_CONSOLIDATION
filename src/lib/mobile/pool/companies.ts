import "server-only";
import { createHash } from "node:crypto";
import { query } from "@/lib/db/client";
import { UserError } from "@/lib/mobile/http";
import {
  attachStarts,
  buildCompanies,
  type CompanyDto,
  companyDto,
  type CompanyFilter,
  type CompanyFull,
  type CompanySort,
  type DealRecord,
  filterCompanies,
  type PersonFact,
  type RequirementRecord,
  requirementPeriod,
  type ShareFact,
  sortCompanies,
  type StartRecord,
} from "@/lib/mobile/pool/companies-model";
import { loadRequirements } from "@/lib/mobile/pool/requirements-store";
import { companiesSchemaReady } from "@/lib/mobile/pool/schema";
import { ownStatusOf } from "@/lib/mobile/pool/shares";
import { lastSharesSync } from "@/lib/mobile/pool/shares-store";
import { listRoster, matchMentor, type RosterUser } from "@/lib/mobile/roster";
import { audit } from "@/lib/mobile/tasks";

/**
 * Companies (PSM 1.12.0): what GET /pool/companies, the Excel export and the Calendar's tentative
 * starts read, and the tentative start writes. Everything comes from the database (written by the
 * hourly company-sheet sync, shares-sync.ts); nothing here reads a sheet or HubSpot. The built list
 * is kept 60 s per process (without the caller's "mine"), and dropped when a start changes.
 */

const CACHE_MS = 60_000;
const g = globalThis as unknown as { __companies?: { at: number; list: CompanyFull[]; meta: CompaniesMeta } };

export interface CompaniesMeta {
  sharesSyncedAt: string | null;
  masterReadAt: string | null;
  hubspotReadAt: string | null;
}

export const forgetCompanies = () => {
  g.__companies = undefined;
};

async function ready(): Promise<void> {
  if (!(await companiesSchemaReady())) throw new UserError(503, "Companies isn't set up on the server yet. Try again later.", "not_ready");
}

async function loadStarts(roster: RosterUser[]): Promise<StartRecord[]> {
  const rows = await query<{ key: string; job_id: string; company: string; role: string; crp_month: string; day: string; set_by: string; set_at: Date; source: string }>(
    "select key, job_id, company, role, crp_month, to_char(start_date, 'YYYY-MM-DD') as day, set_by, set_at, source from app.requirement_starts",
  );
  const names = new Map(roster.map((u) => [u.email, u.name]));
  return rows.map((r) => ({
    key: r.key,
    jobId: r.job_id,
    company: r.company,
    role: r.role,
    crpMonth: r.crp_month,
    date: r.day,
    by: names.get(r.set_by) ?? r.set_by,
    at: r.set_at,
    source: r.source === "import" ? "import" : "app",
  }));
}

/** Every drive, built from the database (cached 60 s). "mine" is filled in per caller by [forUser]. */
async function loadAll(): Promise<{ list: CompanyFull[]; meta: CompaniesMeta }> {
  const hit = g.__companies;
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const roster = await listRoster();
  const [requirements, shareRows, people, dealRows, starts, synced, [times]] = await Promise.all([
    loadRequirements(),
    query<{ sheet_id: string; tab: string; role: string; uid: string; rounds: unknown; final_status: string; outcome: string; status: string | null; stage: string; first_seen_at: Date; changed_at: Date }>(
      `select sheet_id, tab, role, uid, rounds, final_status, outcome, status, stage, first_seen_at, changed_at
         from app.company_shares where removed_at is null`,
    ),
    query<{ uid: string; name: string; mentor_name: string }>("select uid, name, mentor_name from app.pool_candidates where removed_at is null"),
    query<{ deal_id: string; deal_name: string; jd_url: string | null; remarks: string | null; error: string | null; fetched_at: Date }>(
      "select deal_id, deal_name, jd_url, remarks, error, fetched_at from app.hubspot_deals",
    ),
    loadStarts(roster),
    lastSharesSync(),
    query<{ master: Date | null; hubspot: Date | null }>(
      "select (select max(listed_at) from app.crp_requirements) as master, (select max(fetched_at) from app.hubspot_deals where error is null) as hubspot",
    ),
  ]);
  const shares: ShareFact[] = shareRows.map((r) => {
    const own = ownStatusOf(r);
    return { sheetId: r.sheet_id, tab: r.tab, role: r.role, uid: r.uid, own: own.status, stage: own.stage ?? r.stage, firstSeen: r.first_seen_at, changed: r.changed_at };
  });
  const persons = new Map<string, PersonFact>(
    people.map((p) => {
      const m = p.mentor_name.trim() ? matchMentor(p.mentor_name, roster) : null;
      const mentor = p.mentor_name.trim() ? { name: m?.name ?? p.mentor_name.trim(), email: m?.email ?? null } : null;
      return [p.uid, { uid: p.uid, name: p.name, mentor, mine: false }];
    }),
  );
  const deals = new Map<string, DealRecord>(
    dealRows.map((d) => [d.deal_id, { dealId: d.deal_id, dealName: d.deal_name, jdUrl: d.jd_url, remarks: d.remarks, error: d.error, fetchedAt: d.fetched_at }]),
  );
  const list = buildCompanies({ requirements, shares, people: persons, deals, starts });
  const meta: CompaniesMeta = {
    sharesSyncedAt: synced?.toISOString() ?? null,
    masterReadAt: times?.master?.toISOString() ?? null,
    hubspotReadAt: times?.hubspot?.toISOString() ?? null,
  };
  g.__companies = { at: Date.now(), list, meta };
  return g.__companies;
}

/** The list with the caller's candidates marked (mine). */
function forUser(list: CompanyFull[], user: RosterUser): CompanyFull[] {
  return list.map((c) => {
    const candidates = c.candidates.map((x) => ({ ...x, mine: x.mentor?.email === user.email }));
    return { ...c, candidates, mine: candidates.filter((x) => x.mine).length };
  });
}

export interface CompaniesBody {
  generatedAt: string;
  sharesSyncedAt: string | null;
  companies: CompanyDto[];
}

/** GET /pool/companies: every drive (the app filters), ETag over the content. */
export async function listCompanies(user: RosterUser): Promise<{ body: CompaniesBody; etag: string }> {
  await ready();
  const { list, meta } = await loadAll();
  const companies = forUser(list, user).map(companyDto);
  const etag = `"${createHash("sha1").update(JSON.stringify(companies)).update(meta.sharesSyncedAt ?? "").digest("hex").slice(0, 32)}"`;
  return { body: { generatedAt: new Date().toISOString(), sharesSyncedAt: meta.sharesSyncedAt, companies }, etag };
}

/** The drives matching the screen's filters, sorted, for the export. */
export async function companiesForExport(user: RosterUser, filter: CompanyFilter, sort: CompanySort): Promise<{ list: CompanyFull[]; meta: CompaniesMeta }> {
  await ready();
  const { list, meta } = await loadAll();
  return { list: sortCompanies(filterCompanies(forUser(list, user), filter), sort), meta };
}

// ── Tentative starts ────────────────────────────────────────────────────────

export const REQ_KEY = /^[0-9a-f]{24}$/;
const DAY_MS = 86_400_000;

/** A start date the app or a file may set: a real date within two years of today. */
export function validStartDay(day: unknown, today = new Date()): string | null {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== day) return null;
  return Math.abs(t - today.getTime()) <= 731 * DAY_MS ? day : null;
}

/** Sets (or clears, [day] null) one requirement's tentative start. */
export async function setTentativeStart(
  user: RosterUser,
  key: string,
  day: string | null,
  source: "app" | "import" = "app",
): Promise<{ key: string; tentativeStart: { date: string; by: string; at: string } | null; changed: boolean }> {
  await ready();
  if (!REQ_KEY.test(key)) throw new UserError(404, "This requirement isn't in the CRPs sheet any more.", "not_found");
  const [req] = await query<{ key: string; job_id: string; company: string; role: string; crp_month: string }>(
    "select key, job_id, company, role, crp_month from app.crp_requirements where key = $1",
    [key],
  );
  if (!req) throw new UserError(404, "This requirement isn't in the CRPs sheet any more.", "not_found");
  if (day === null) {
    const gone = await query("delete from app.requirement_starts where key = $1 returning key", [key]);
    if (gone.length) await audit(user.email, "tentative_start_cleared", key, { company: req.company, role: req.role, source });
    forgetCompanies();
    return { key, tentativeStart: null, changed: gone.length > 0 };
  }
  const valid = validStartDay(day);
  if (!valid) throw new UserError(400, "Pick a date within two years of today.", "invalid_date");
  const [prev] = await query<{ day: string }>("select to_char(start_date, 'YYYY-MM-DD') as day from app.requirement_starts where key = $1", [key]);
  if (prev?.day === valid) {
    const [row] = await query<{ set_by: string; set_at: Date }>("select set_by, set_at from app.requirement_starts where key = $1", [key]);
    const names = new Map((await listRoster()).map((u) => [u.email, u.name]));
    return { key, tentativeStart: { date: valid, by: names.get(row.set_by) ?? row.set_by, at: row.set_at.toISOString() }, changed: false };
  }
  const [row] = await query<{ set_at: Date }>(
    `insert into app.requirement_starts (key, job_id, company, role, crp_month, start_date, set_by, set_at, source)
     values ($1, $2, $3, $4, $5, $6::date, $7, now(), $8)
     on conflict (key) do update set job_id = excluded.job_id, company = excluded.company, role = excluded.role, crp_month = excluded.crp_month,
       start_date = excluded.start_date, set_by = excluded.set_by, set_at = now(), source = excluded.source
     returning set_at`,
    [key, req.job_id, req.company.slice(0, 200), req.role.slice(0, 200), req.crp_month.slice(0, 40), valid, user.email, source],
  );
  await audit(user.email, "tentative_start_set", key, { company: req.company, role: req.role, date: valid, was: prev?.day ?? null, source });
  forgetCompanies();
  return { key, tentativeStart: { date: valid, by: user.name, at: row.set_at.toISOString() }, changed: true };
}

export interface StartDto {
  key: string;
  companyId: string;
  company: string;
  role: string;
  date: string;
  by: string;
  sheetUrl: string | null;
  crpLabel: string | null;
}

/** GET /pool/companies/starts: the tentative starts in [from, to] (each bound optional), for the Calendar. */
export async function listStarts(from: string | null, to: string | null): Promise<StartDto[]> {
  await ready();
  const roster = await listRoster();
  const [requirements, starts] = await Promise.all([loadRequirements(), loadStarts(roster)]);
  const attached = attachStarts(requirements, starts);
  const out: StartDto[] = [];
  for (const r of requirements) {
    const s = attached.get(r.key);
    if (!s || (from && s.date < from) || (to && s.date > to)) continue;
    out.push({
      key: r.key,
      companyId: r.sheetId ?? `req:${r.key}`,
      company: r.company,
      role: r.role,
      date: s.date,
      by: s.by,
      sheetUrl: r.sheetId ? `https://docs.google.com/spreadsheets/d/${r.sheetId}/edit` : null,
      crpLabel: requirementPeriod(r)?.month ?? null,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.company.localeCompare(b.company));
}

export interface ImportResult {
  applied: number;
  unchanged: number;
  unknown: number;
  invalid: { row: number; reason: string }[];
}

/** POST /pool/companies/import: the "Tentative start date" column of an exported file. An empty cell changes nothing. */
export async function importStarts(user: RosterUser, bytes: Buffer): Promise<ImportResult> {
  await ready();
  const { readStartsWorkbook } = await import("@/lib/mobile/pool/companies-xlsx");
  let read;
  try {
    read = await readStartsWorkbook(bytes);
  } catch (err) {
    const code = err instanceof Error ? err.message : "";
    throw new UserError(
      400,
      code === "no_columns"
        ? `This file has no "Tentative start date" and "Ref" columns. Download the Excel from the app, fill the dates and import that file.`
        : "This isn't an Excel (.xlsx) file.",
      "invalid_file",
    );
  }
  const out: ImportResult = { applied: 0, unchanged: read.empty, unknown: 0, invalid: [...read.invalid] };
  const seen = new Set<string>();
  for (const r of read.rows) {
    if (seen.has(r.ref)) {
      out.invalid.push({ row: r.row, reason: "The same requirement is in the file twice (the first row was used)" });
      continue;
    }
    seen.add(r.ref);
    try {
      const res = await setTentativeStart(user, r.ref, r.day, "import");
      if (res.changed) out.applied++;
      else out.unchanged++;
    } catch (err) {
      if (err instanceof UserError && err.code === "not_found") out.unknown++;
      else if (err instanceof UserError && err.code === "invalid_date") out.invalid.push({ row: r.row, reason: `${r.day} is more than two years away` });
      else throw err;
    }
  }
  out.invalid.sort((a, b) => a.row - b.row);
  out.invalid = out.invalid.slice(0, 200);
  return out;
}
