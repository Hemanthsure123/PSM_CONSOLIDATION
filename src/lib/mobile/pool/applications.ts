import {
  cellText,
  cleanEmail,
  EMAIL_HEAD,
  keyText,
  MAX_ROWS_PER_TAB,
  normHead,
  NOT_PHONE_HEAD,
  NOT_RESUME_HEAD,
  PHONE_HEAD,
  phonesIn,
  resumeLinkOf,
  RESUME_HEAD,
  type SheetTab,
} from "@/lib/mobile/pool/shares";

/**
 * Applications (PSM 1.13.0) — the pure part: reading a requirement's INTERNAL sheet (the CRPs master's
 * "Internal sheet Link") for the candidates who applied, and matching them to the Academy assessed
 * pool. No network, no database: tested in scripts/feedback-selftest.ts; the I/O is in
 * applications-sync.ts.
 *
 * Two kinds of tab hold applications:
 *  - "portal": the platform's applicant export ("Applied Users", "Academy Applied" …): a Job Id column,
 *    who applied (User Id, phone, email), usually Applied Datetime and Resume Link. One row = one
 *    application to the row's Job Id.
 *  - "form": a Google Form through which candidates applied or registered for this job's drive
 *    (Timestamp, a mobile number, an application-form question or a title like "Applied" /
 *    "Registration"). Availability, slot, assignment-submission and feedback forms are not
 *    applications. A form row belongs to the sheet's job when the sheet serves exactly one job id.
 * Our own shortlisting outputs (rank, "Not shortlisted because" …) are not applications: they are
 * copies of the applicants with our verdicts.
 *
 * Only rows matched to the pool (User Id = UID, then any phone, then email) are kept: nobody else's
 * data is ever stored.
 */

export type ApplicationSource = "portal" | "form";

export interface ApplicationColumns {
  /** 0-based header row (within the first 6 rows). */
  headerRow: number;
  source: ApplicationSource;
  jobId: number | null;
  userId: number | null;
  phones: number[];
  emails: number[];
  appliedAt: number | null;
  resume: number | null;
}

const JOB_ID_HEAD = /^(job ?id|job ids?|jobid)$/;
const USER_ID_HEAD = /^(user ?id|userid|uid)$/;
const APPLIED_HEAD =
  /^(applied ?(date ?time|datetime|date|on|at|time)|application (date|date ?time|datetime|time)|date of application|creation (date ?time|datetime|date|time)|created (at|on|date|datetime|date ?time)|submitted (at|on))$/;
const TIMESTAMP_HEAD = /^timestamp$/;
/** Our shortlisting automation's output tabs (ranked copies of the applicants). */
const SCREENING_OUTPUT = /^(not shortlisted because|rank score|delivered at|source tab|domain score|review flags|shortlist rank|overall rank|final score|mandatory score)( \d+)?$/;
/** An application / registration form's own questions (header text after normHead). */
const FORM_SIGNATURE = /enter a 10 digit mobile|highest graduation|highest qualifica|have you applied for the job|upload your (updated )?(resume|cv)/;
const FORM_TITLE = /\bappl(y|ied|ication|ications|icants?)\b|\bregist(er|ered|ration|rations)\b|\bdrive\b/i;
/** Forms that collect something else from people who already applied. */
const NOT_FORM_TITLE = /availab|\bslots?\b|assign|submission|\btasks?\b|feedback|attendance|confirm|interest(ed)? check|rsvp/i;

/** A header cell for matching: camelCase / snake_case split first ("registeredMobileNumber" → "registered mobile number"). */
const headOf = (v: unknown) => normHead(String(v ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2"));

const indexes = (head: string[], test: (h: string, i: number) => boolean) => head.map((h, i) => (h && test(h, i) ? i : -1)).filter((i) => i >= 0);
const first = (head: string[], test: (h: string) => boolean) => {
  const i = head.findIndex((h) => Boolean(h) && test(h));
  return i >= 0 ? i : null;
};

/**
 * The header (first 6 rows) of an applications tab and its columns, or null when the tab isn't one
 * (a profiles list with rounds, our shortlisting output, an availability form, notes …).
 */
export function findApplicationColumns(rows: unknown[][], title: string): ApplicationColumns | null {
  const limit = Math.min(rows.length, 6);
  for (let r = 0; r < limit; r++) {
    const head = (rows[r] ?? []).map(headOf);
    if (head.filter(Boolean).length < 3) continue;
    if (head.some((h) => SCREENING_OUTPUT.test(h))) return null;
    const phones = indexes(head, (h) => PHONE_HEAD.test(h) && !NOT_PHONE_HEAD.test(h));
    const emails = indexes(head, (h, i) => EMAIL_HEAD.test(h) && !/parent|guardian/.test(h) && !phones.includes(i));
    const jobId = first(head, (h) => JOB_ID_HEAD.test(h));
    const userId = first(head, (h) => USER_ID_HEAD.test(h));
    const applied = first(head, (h) => APPLIED_HEAD.test(h));
    const timestamp = first(head, (h) => TIMESTAMP_HEAD.test(h));
    const resume = first(head, (h) => RESUME_HEAD.test(h) && !NOT_RESUME_HEAD.test(h));
    const who = phones.length > 0 || emails.length > 0 || userId !== null;
    if (jobId !== null && who && (applied !== null || resume !== null || userId !== null)) {
      return { headerRow: r, source: "portal", jobId, userId, phones, emails, appliedAt: applied ?? timestamp, resume };
    }
    const formish = head.some((h) => FORM_SIGNATURE.test(h)) || FORM_TITLE.test(title.normalize("NFKC"));
    if (jobId === null && timestamp !== null && phones.length > 0 && formish && !NOT_FORM_TITLE.test(title.normalize("NFKC"))) {
      return { headerRow: r, source: "form", jobId: null, userId: null, phones, emails, appliedAt: timestamp, resume };
    }
    // This row is the tab's header (it names who), but the tab isn't an applications list.
    if (who) return null;
  }
  return null;
}

// ── Dates ───────────────────────────────────────────────────────────────────

const IST_MS = 330 * 60_000;
const EARLIEST = Date.UTC(2020, 0, 1);

/** Day-first, month-first or unknown, from every value of a slash / dash date column. */
export type DateOrder = "dmy" | "mdy" | "unknown";

const SLASH = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i;
const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(z|[+-]\d{2}:?\d{2})?$/i;
const SERIAL = /^\d{5}(?:\.\d+)?$/;

/**
 * Whether a column's slash dates are day-first or month-first: one value with a first part above 12
 * makes it day-first, one with a second part above 12 month-first (the platform's exports are
 * month-first: "10/22/2026 19:18:16"). Unknown when no value tells.
 */
export function dateOrderOf(values: string[]): DateOrder {
  let dmy = false;
  let mdy = false;
  for (const v of values) {
    const m = v.trim().match(SLASH);
    if (!m) continue;
    if (Number(m[1]) > 12) dmy = true;
    if (Number(m[2]) > 12) mdy = true;
  }
  if (dmy && !mdy) return "dmy";
  if (mdy && !dmy) return "mdy";
  return "unknown";
}

/**
 * An "Applied Datetime" / "Timestamp" cell → ms (UTC), read as India time. Accepts "2026-11-18
 * 19:31:40", "10/22/2026 19:18:16" (order from [order]; unknown → month-first, the platform's export
 * format), "26/10/2026 6:33 PM" and sheet serial numbers (46317.81682). Null when it isn't a date,
 * before 2020 or more than 2 days ahead of [now].
 */
export function parseAppliedAt(raw: unknown, order: DateOrder = "unknown", now = Date.now()): number | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  let ms: number | null = null;
  const iso = t.match(ISO);
  const slash = t.match(SLASH);
  if (iso) {
    const [, y, mo, d, h = "0", mi = "0", s = "0", zone] = iso;
    const base = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    if (zone && /^z$/i.test(zone)) ms = base;
    else if (zone) {
      const z = zone.replace(":", "");
      const off = (Number(z.slice(1, 3)) * 60 + Number(z.slice(3, 5))) * (z.startsWith("-") ? -1 : 1);
      ms = base - off * 60_000;
    } else ms = base - IST_MS;
    if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) ms = null;
  } else if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const y = Number(slash[3]);
    let day: number;
    let month: number;
    if (a > 12) [day, month] = [a, b];
    else if (b > 12) [month, day] = [a, b];
    else if (order === "dmy") [day, month] = [a, b];
    else [month, day] = [a, b];
    let h = Number(slash[4] ?? 0);
    const mi = Number(slash[5] ?? 0);
    const s = Number(slash[6] ?? 0);
    const ap = (slash[7] ?? "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    ms = month >= 1 && month <= 12 && day >= 1 && day <= 31 ? Date.UTC(y, month - 1, day, h, mi, s) - IST_MS : null;
  } else if (SERIAL.test(t)) {
    // Days since 1899-12-30 in the sheet's own time zone (India).
    ms = Math.round((Number(t) - 25569) * 86_400_000) - IST_MS;
  }
  if (ms === null || !Number.isFinite(ms) || ms < EARLIEST || ms > now + 2 * 86_400_000) return null;
  return ms;
}

// ── Rows ────────────────────────────────────────────────────────────────────

export interface ApplicationRow {
  /** 1-based sheet row. */
  sheetRow: number;
  userId: string | null;
  phones: string[];
  email: string | null;
  /** Lower case, "" when the row has none. */
  jobId: string;
  appliedAt: number | null;
  resumeUrl: string | null;
}

/** "3AA4D59A-…" → "3aa4d59a-…"; "" for blanks and formula errors. */
export const normJobId = (raw: unknown) => cellText(raw, 80).toLowerCase();

/** The data rows of an applications tab, at most MAX_ROWS_PER_TAB. Rows naming nobody are skipped. */
export function readApplicationRows(rows: unknown[][], cols: ApplicationColumns, now = Date.now()): ApplicationRow[] {
  const end = Math.min(rows.length, cols.headerRow + 1 + MAX_ROWS_PER_TAB);
  const seen = cols.appliedAt === null ? "unknown" : dateOrderOf(rows.slice(cols.headerRow + 1, end).map((r) => String(r?.[cols.appliedAt!] ?? "")));
  // Undecided: platform exports write month-first; Google Forms here are in an Indian locale (day-first).
  const order: DateOrder = seen !== "unknown" ? seen : cols.source === "form" ? "dmy" : "mdy";
  const out: ApplicationRow[] = [];
  for (let i = cols.headerRow + 1; i < end; i++) {
    const r = rows[i] ?? [];
    const phones: string[] = [];
    for (const c of cols.phones) for (const p of phonesIn(String(r[c] ?? ""))) if (!phones.includes(p)) phones.push(p);
    let email: string | null = null;
    for (const c of cols.emails) {
      email = cleanEmail(String(r[c] ?? ""));
      if (email) break;
    }
    const userId = cols.userId === null ? null : cellText(r[cols.userId], 80).toLowerCase() || null;
    if (!phones.length && !email && !userId) continue;
    out.push({
      sheetRow: i + 1,
      userId,
      phones,
      email,
      jobId: cols.jobId === null ? "" : normJobId(r[cols.jobId]),
      appliedAt: cols.appliedAt === null ? null : parseAppliedAt(r[cols.appliedAt], order, now),
      resumeUrl: cols.resume === null ? null : resumeLinkOf(r[cols.resume]),
    });
  }
  return out;
}

// ── Matching and building ───────────────────────────────────────────────────

export interface PoolLookup {
  /** Lower-case UID → the UID as stored. */
  byUid: Map<string, string>;
  byPhone: Map<string, string>;
  byEmail: Map<string, string>;
}

/** A phone or email shared by two pool candidates matches nobody (it can't tell who applied). */
export function poolLookup(people: { uid: string; phone: string | null; email: string | null }[]): PoolLookup {
  const byUid = new Map<string, string>();
  const byPhone = new Map<string, string>();
  const byEmail = new Map<string, string>();
  const shared = new Set<string>();
  const put = (m: Map<string, string>, k: string, uid: string) => {
    const cur = m.get(k);
    if (cur && cur !== uid) shared.add(k);
    else m.set(k, uid);
  };
  for (const p of people) {
    byUid.set(p.uid.toLowerCase(), p.uid);
    if (p.phone) put(byPhone, p.phone, p.uid);
    if (p.email) put(byEmail, p.email.toLowerCase(), p.uid);
  }
  for (const k of shared) {
    byPhone.delete(k);
    byEmail.delete(k);
  }
  return { byUid, byPhone, byEmail };
}

/**
 * The pool candidate an application row is: its User Id (= UID) when the row has one — a User Id that
 * isn't in the pool is someone else, even when the phone or email matches; else any phone, then email.
 * Null: not Academy assessed.
 */
export function matchApplicant(row: Pick<ApplicationRow, "userId" | "phones" | "email">, pool: PoolLookup): { uid: string; phone: string | null } | null {
  if (row.userId) {
    const byId = pool.byUid.get(row.userId);
    return byId ? { uid: byId, phone: row.phones.find((p) => pool.byPhone.get(p) === byId) ?? row.phones[0] ?? null } : null;
  }
  for (const p of row.phones) {
    const uid = pool.byPhone.get(p);
    if (uid) return { uid, phone: p };
  }
  if (row.email) {
    const uid = pool.byEmail.get(row.email);
    if (uid) return { uid, phone: row.phones[0] ?? null };
  }
  return null;
}

export interface ApplicationRecord {
  tab: string;
  gid: number | null;
  uid: string;
  phone: string | null;
  jobId: string;
  source: ApplicationSource;
  appliedAt: number | null;
  resumeUrl: string | null;
}

export interface BuiltApplications {
  applications: ApplicationRecord[];
  /** Tabs read as applications. */
  tabsRead: number;
  /** Application rows naming someone. */
  rowsSeen: number;
  /** Rows matched to the pool (before de-duplication). */
  academyRows: number;
  /** Matched rows whose job couldn't be told (a form in a sheet that serves several job ids). */
  noJob: number;
}

export interface SheetJob {
  jobId: string;
  role: string;
}

const STOP = new Set(["jd", "batch", "the", "and", "of", "for", "applied", "applications", "application", "form", "responses", "response", "copy"]);
const wordsOf = (s: string) => new Set(keyText(s).split(" ").filter((w) => w.length > 1 && !/^\d+$/.test(w) && !STOP.has(w)));

/**
 * The job a form tab collects applications for, in a sheet that serves several: the one whose role
 * words the tab title holds best (at least half of them), when that best is unique. "" otherwise.
 */
export function jobOfTitle(title: string, jobs: SheetJob[]): string {
  const hay = wordsOf(title);
  let best: { jobId: string; score: number } | null = null;
  let tie = false;
  for (const j of jobs) {
    const want = [...wordsOf(j.role)];
    if (!want.length) continue;
    const score = want.filter((w) => hay.has(w)).length / want.length;
    if (score < 0.5) continue;
    if (!best || score > best.score) {
      best = { jobId: j.jobId, score };
      tie = false;
    } else if (score === best.score && best.jobId !== j.jobId) tie = true;
  }
  return best && !tie ? best.jobId : "";
}

/**
 * Every Academy assessed candidate's applications in one internal sheet, one per (candidate, job):
 * the earliest application (a portal row beats a form row on a tie), with a resume link from any of
 * its rows. [jobIds]: the job ids of the requirements that list this internal sheet (lower case);
 * [jobs]: those requirements' roles, to tell which job a form tab is for when there are several.
 */
export function buildApplications(
  sheet: { jobIds: string[]; jobs?: SheetJob[] },
  tabs: SheetTab[],
  people: { uid: string; phone: string | null; email: string | null }[] | PoolLookup,
  now = Date.now(),
): BuiltApplications {
  const pool = "byUid" in people ? people : poolLookup(people);
  const jobIds = [...new Set(sheet.jobIds.map((j) => j.trim().toLowerCase()).filter(Boolean))];
  const only = jobIds.length === 1 ? jobIds[0] : "";
  const best = new Map<string, ApplicationRecord>();
  let tabsRead = 0;
  let rowsSeen = 0;
  let academyRows = 0;
  let noJob = 0;
  for (const t of tabs) {
    const cols = findApplicationColumns(t.rows, t.info.title);
    if (!cols) continue;
    if (cols.source === "form" && t.info.hidden) continue;
    tabsRead++;
    const tabJob = only || (cols.source === "form" ? jobOfTitle(t.info.title, sheet.jobs ?? []) : "");
    for (const row of readApplicationRows(t.rows, cols, now)) {
      rowsSeen++;
      const m = matchApplicant(row, pool);
      if (!m) continue;
      academyRows++;
      const jobId = row.jobId || tabJob;
      if (!jobId) {
        noJob++;
        continue;
      }
      const rec: ApplicationRecord = {
        tab: t.info.title.slice(0, 200),
        gid: Number.isInteger(t.info.gid) ? t.info.gid : null,
        uid: m.uid,
        phone: m.phone,
        jobId,
        source: cols.source,
        appliedAt: row.appliedAt,
        resumeUrl: row.resumeUrl,
      };
      const key = `${m.uid}\u0000${jobId}`;
      const cur = best.get(key);
      if (!cur) {
        best.set(key, rec);
        continue;
      }
      const earlier =
        rec.appliedAt !== null && (cur.appliedAt === null || rec.appliedAt < cur.appliedAt || (rec.appliedAt === cur.appliedAt && rec.source === "portal" && cur.source === "form"));
      const keep = earlier ? rec : cur;
      best.set(key, { ...keep, resumeUrl: keep.resumeUrl ?? (earlier ? cur.resumeUrl : rec.resumeUrl), phone: keep.phone ?? cur.phone ?? rec.phone });
    }
  }
  return { applications: [...best.values()], tabsRead, rowsSeen, academyRows, noJob };
}

export interface InternalSheet {
  sheetId: string;
  company: string;
  /** Lower case, distinct. */
  jobIds: string[];
  jobs: SheetJob[];
}

/** One entry per internal sheet: the company, and the job ids (with roles) of the requirements that list it. */
export function internalSheetsOf(reqs: { internalSheetId?: string | null; company: string; jobId: string; role: string }[]): InternalSheet[] {
  const by = new Map<string, InternalSheet>();
  for (const r of reqs) {
    if (!r.internalSheetId) continue;
    const s = by.get(r.internalSheetId) ?? { sheetId: r.internalSheetId, company: r.company, jobIds: [], jobs: [] };
    const j = r.jobId.trim().toLowerCase();
    if (j && !s.jobIds.includes(j) && s.jobIds.length < 40) {
      s.jobIds.push(j);
      s.jobs.push({ jobId: j, role: r.role });
    }
    by.set(r.internalSheetId, s);
  }
  return [...by.values()];
}
