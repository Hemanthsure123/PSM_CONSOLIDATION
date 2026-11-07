import "server-only";
import { withSheetsRetry } from "@/lib/automation/control-sheet";
import { env } from "@/lib/env";
import { normName } from "@/lib/mobile/roster";
import { getSheetsWriter } from "@/lib/sheets";

/**
 * A candidate's email, looked up — never guessed:
 *   0. the candidate's own resume (the drill-down row's resume link): one email there → done;
 *   1. the CRPs tab (only its "JOB ID" and "Company Sheet Link" columns) gives the job's company
 *      sheet;
 *   2. every tab of that company sheet is searched by the candidate's phone (last 10 digits),
 *      then by exact full name;
 *   3. one distinct email → found. Two or more different emails → "ambiguous" (none returned);
 *      no row → "not_found".
 * Reads go through the service account and are cached (CRPs 10 min, each company sheet 10 min).
 */

export type ContactStatus = "found" | "ambiguous" | "not_found" | "no_company_sheet" | "unreadable";

export interface ContactResult {
  email: string | null;
  status: ContactStatus;
  /** Where it was found ("Company sheet title › Tab"), for the app to show. */
  source: string | null;
  matchedBy: "resume" | "phone" | "name" | null;
}

const TTL = 10 * 60_000;
const EMAIL = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const q = (tab: string) => `'${tab.replace(/'/g, "''")}'`;
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const last10 = (s: unknown) => String(s ?? "").replace(/\D/g, "").slice(-10);

const g = globalThis as unknown as {
  __crpIndex?: { at: number; byJob: Map<string, string[]> };
  __crpLoading?: Promise<Map<string, string[]>>;
  __companySheets?: Map<string, { at: number; rows: CandidateRow[]; title: string }>;
};
const sheetCache = (g.__companySheets ??= new Map());

interface CandidateRow {
  tab: string;
  name: string;
  phone: string;
  email: string;
}

function crpConfig() {
  return {
    spreadsheetId: process.env.CRP_SPREADSHEET_ID?.trim() || env.mobile.controlSpreadsheetId,
    tab: process.env.CRP_TAB?.trim() || "CRPs",
  };
}

const sheetIdOf = (url: string) => url.match(/\/spreadsheets\/d\/([\w-]{20,})/)?.[1] ?? null;

/** Job ID → company sheet ids, from the CRPs tab's two columns only. */
async function crpIndex(): Promise<Map<string, string[]>> {
  const hit = g.__crpIndex;
  if (hit && Date.now() - hit.at < TTL) return hit.byJob;
  if (g.__crpLoading) return g.__crpLoading;
  g.__crpLoading = (async () => {
    const c = crpConfig();
    if (!c.spreadsheetId) throw new Error("The CRPs sheet isn't configured on the server.");
    const sheets = getSheetsWriter();
    const head = await withSheetsRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: c.spreadsheetId, range: `${q(c.tab)}!1:1` }));
    const header = (head.data.values?.[0] ?? []).map(norm);
    const jobCol = header.findIndex((h) => h === "job id" || h === "jobid");
    const linkCol = header.findIndex((h) => h === "company sheet link" || h === "company sheet");
    if (jobCol < 0 || linkCol < 0) throw new Error('The CRPs tab has no "JOB ID" or "Company Sheet Link" column.');
    const col = (i: number) => {
      let s = "";
      for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
      return s;
    };
    const res = await withSheetsRetry(() =>
      sheets.spreadsheets.values.batchGet({ spreadsheetId: c.spreadsheetId, ranges: [`${q(c.tab)}!${col(jobCol)}2:${col(jobCol)}`, `${q(c.tab)}!${col(linkCol)}2:${col(linkCol)}`] }),
    );
    const jobs = res.data.valueRanges?.[0]?.values ?? [];
    const links = res.data.valueRanges?.[1]?.values ?? [];
    const byJob = new Map<string, string[]>();
    for (let i = 0; i < jobs.length; i++) {
      const job = String(jobs[i]?.[0] ?? "").trim().toLowerCase();
      const id = sheetIdOf(String(links[i]?.[0] ?? ""));
      if (!job || !id) continue;
      const list = byJob.get(job) ?? [];
      if (!list.includes(id)) list.push(id);
      byJob.set(job, list);
    }
    g.__crpIndex = { at: Date.now(), byJob };
    return byJob;
  })().finally(() => {
    g.__crpLoading = undefined;
  });
  return g.__crpLoading;
}

/** Every candidate row (name, phone, email) of a company sheet, all visible tabs. */
async function companyRows(spreadsheetId: string): Promise<{ rows: CandidateRow[]; title: string }> {
  const hit = sheetCache.get(spreadsheetId);
  if (hit && Date.now() - hit.at < TTL) return hit;
  const sheets = getSheetsWriter();
  const meta = await withSheetsRetry(() => sheets.spreadsheets.get({ spreadsheetId, fields: "properties.title,sheets.properties(title,hidden,sheetType)" }));
  const tabs = (meta.data.sheets ?? []).map((s) => s.properties!).filter((p) => p.sheetType === "GRID" && !p.hidden && p.title);
  const title = meta.data.properties?.title ?? "Company sheet";
  if (!tabs.length) return { rows: [], title };
  // Headers are in the first 5 rows; read those first, then only the three columns per tab.
  const heads = await withSheetsRetry(() => sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges: tabs.map((t) => `${q(t.title!)}!A1:AZ5`) }));
  const plans: { tab: string; headerRow: number; name: number; phone: number; email: number }[] = [];
  (heads.data.valueRanges ?? []).forEach((vr, i) => {
    const values = vr.values ?? [];
    for (let r = 0; r < values.length; r++) {
      const h = values[r].map(norm);
      const email = h.findIndex((x) => x === "email" || x === "email id" || x === "email address" || x === "mail id" || x === "e mail");
      if (email < 0) continue;
      const name = h.findIndex((x) => x === "full name" || x === "name" || x === "candidate name" || x === "student name");
      const phone = h.findIndex((x) => /^(mobile|phone|contact)( number| no)?$/.test(x) || x === "whatsapp number");
      if (name < 0 && phone < 0) continue;
      plans.push({ tab: tabs[i].title!, headerRow: r + 1, name, phone, email });
      break;
    }
  });
  const rows: CandidateRow[] = [];
  if (plans.length) {
    const res = await withSheetsRetry(() => sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges: plans.map((p) => `${q(p.tab)}!A${p.headerRow + 1}:AZ`) }));
    (res.data.valueRanges ?? []).forEach((vr, i) => {
      const p = plans[i];
      for (const row of vr.values ?? []) {
        const email = String(row[p.email] ?? "").trim();
        if (!EMAIL.test(email)) continue;
        rows.push({ tab: p.tab, name: p.name >= 0 ? normName(String(row[p.name] ?? "")) : "", phone: p.phone >= 0 ? last10(row[p.phone]) : "", email: email.toLowerCase() });
      }
    });
  }
  const out = { at: Date.now(), rows, title };
  sheetCache.set(spreadsheetId, out);
  return out;
}

function pick(rows: CandidateRow[], title: string, matchedBy: "phone" | "name"): ContactResult | null {
  if (!rows.length) return null;
  const emails = [...new Set(rows.map((r) => r.email))];
  if (emails.length > 1) return { email: null, status: "ambiguous", source: `${title} › ${[...new Set(rows.map((r) => r.tab))].join(", ")}`, matchedBy };
  return { email: emails[0], status: "found", source: `${title} › ${rows[0].tab}`, matchedBy };
}

const resumeCache = ((globalThis as unknown as { __resumeEmails?: Map<string, { at: number; email: string | null }> }).__resumeEmails ??= new Map());
const NOT_PERSONAL = /@(example\.com|domain\.com|email\.com|gmail\.co)$|^(noreply|no-reply|info|support|hr|careers)@/i;

/**
 * The email written on the candidate's own resume (PDF / Word / text; images are skipped — no
 * model reads them for this). One distinct email → it; several → the one in the resume's header
 * when only one is there; otherwise none (the company sheet decides).
 */
async function emailFromResume(resumeUrl: string): Promise<string | null> {
  const url = resumeUrl.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const hit = resumeCache.get(url);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.email;
  let email: string | null = null;
  try {
    const { fetchResume } = await import("@/lib/resume");
    const { contentFromBytes } = await import("@/lib/resume-content");
    const fetched = await fetchResume(url);
    if (fetched.ok) {
      const content = await contentFromBytes(fetched.bytes);
      const text = typeof content === "string" ? "" : content.text;
      const all = (text.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map((e) => e.toLowerCase().replace(/\.+$/, ""));
      const emails = [...new Set(all)].filter((e) => EMAIL.test(e) && !NOT_PERSONAL.test(e));
      if (emails.length === 1) email = emails[0];
      else if (emails.length > 1) {
        const head = [...new Set((text.slice(0, 1200).match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map((e) => e.toLowerCase().replace(/\.+$/, "")))].filter((e) => emails.includes(e));
        if (head.length === 1) email = head[0];
      }
    } else if (fetched.transient) {
      return null; // don't cache a passing failure
    }
  } catch (err) {
    console.warn("[contacts] resume unreadable:", err instanceof Error ? err.message.slice(0, 160) : err);
    return null;
  }
  resumeCache.set(url, { at: Date.now(), email });
  return email;
}

/**
 * Looks up one candidate's email: first from the candidate's own information (the resume linked
 * in the drill-down row); only when that gives none, from the job's company sheet.
 */
export async function findCandidateEmail(jobId: string, candidate: { name: string; phone: string; resumeUrl?: string }): Promise<ContactResult> {
  const none = (status: ContactStatus): ContactResult => ({ email: null, status, source: null, matchedBy: null });
  if (candidate.resumeUrl) {
    const fromResume = await emailFromResume(candidate.resumeUrl);
    if (fromResume) return { email: fromResume, status: "found", source: "Candidate's resume", matchedBy: "resume" };
  }
  if (!jobId.trim()) return none("no_company_sheet");
  let ids: string[];
  try {
    ids = (await crpIndex()).get(jobId.trim().toLowerCase()) ?? [];
  } catch (err) {
    console.warn("[contacts] CRPs unreadable:", err instanceof Error ? err.message.slice(0, 200) : err);
    return none("unreadable");
  }
  if (!ids.length) return none("no_company_sheet");
  const phone = last10(candidate.phone);
  const name = normName(candidate.name);
  const all: { rows: CandidateRow[]; title: string }[] = [];
  let unreadable = 0;
  for (const id of ids) {
    try {
      all.push(await companyRows(id));
    } catch (err) {
      unreadable++;
      console.warn("[contacts] company sheet unreadable:", id.slice(0, 8), err instanceof Error ? err.message.slice(0, 160) : err);
    }
  }
  if (!all.length && unreadable) return none("unreadable");
  const title = all.map((a) => a.title).join(" / ");
  const rows = all.flatMap((a) => a.rows);
  if (phone.length === 10) {
    const r = pick(rows.filter((x) => x.phone === phone), title, "phone");
    if (r) return r;
  }
  if (name) {
    const r = pick(rows.filter((x) => x.name === name), title, "name");
    if (r) return r;
  }
  return none(unreadable ? "unreadable" : "not_found");
}

export function forgetContacts(): void {
  g.__crpIndex = undefined;
  sheetCache.clear();
}

export const isEmail = (s: string) => EMAIL.test(s.trim());
