import {
  combinedState,
  crpMonthLabel,
  crpPeriod,
  ctcLabel,
  effectiveStatus,
  isApplicationsTab,
  isFinalStatus,
  type MasterState,
  parseCrpMonth,
  parseCtc,
  pickRequirement,
  requirementState,
  type ShareStatus,
  sheetUrl,
  STATUS_RANK,
} from "@/lib/mobile/pool/shares";

/**
 * Companies (PSM 1.12.0) — the pure part: hiring drives (a company sheet, or a master requirement
 * without one) with their requirements from the CRPs master, the Academy assessed candidates found
 * in the sheet and their statuses, the verified-against-master check, JD links / HubSpot remarks and
 * tentative starts. No I/O: tested in scripts/companies-selftest.ts; companies.ts loads the inputs.
 *
 * Where each number comes from is kept apart on purpose:
 *  - academySent / assessedSent / nonAssessedSent: typed by the team in the CRPs master;
 *  - verifiedAssessed: Academy assessed candidates actually present in the company sheet (shared
 *    tabs, or an applications tab with a round filled in), matched by phone or email.
 */

export interface RequirementRecord {
  key: string;
  rowIndex: number;
  sheetId: string | null;
  company: string;
  role: string;
  jobId: string;
  jobType: string;
  crpMonth: string;
  crpYear: number | null;
  crpWeek: number | null;
  openings: number | null;
  ctcText: string;
  finalStatus: string;
  stage: string;
  idStatus: string;
  academySent: number | null;
  assessedSent: number | null;
  nonAssessedSent: number | null;
  requested: string;
  techStack: string;
  passOut: string;
  interviewProcess: string;
  ise: string;
  crm: string;
  jdUrl: string | null;
  hubspotUrl: string | null;
  hubspotDealId: string | null;
  /** 1.13.0 (migration 023): the requirement's internal sheet; undefined before it. */
  internalSheetId?: string | null;
  /** 1.13.0 (migration 023): the month its ID was done, as typed, and that month's year. */
  idMonth?: string;
  idYear?: number | null;
}

export interface DealRecord {
  dealId: string;
  dealName: string;
  jdUrl: string | null;
  remarks: string | null;
  error: string | null;
  fetchedAt: Date;
}

export interface StartRecord {
  key: string;
  jobId: string;
  company: string;
  role: string;
  crpMonth: string;
  /** YYYY-MM-DD */
  date: string;
  /** Who set it (a name). */
  by: string;
  at: Date;
  source: "app" | "import";
}

export interface ShareFact {
  sheetId: string;
  tab: string;
  role: string;
  uid: string;
  /** The candidate's own status in that tab (before the requirement's state). */
  own: ShareStatus;
  stage: string;
  firstSeen: Date;
  changed: Date;
}

export interface PersonFact {
  uid: string;
  name: string;
  mentor: { name: string; email: string | null } | null;
  mine: boolean;
}

export type CompanyState = "in_progress" | "waiting" | "on_hold" | "done";
export const COMPANY_STATES: CompanyState[] = ["in_progress", "waiting", "on_hold", "done"];

export interface TentativeStartDto {
  date: string;
  by: string;
  at: string;
}

export interface RequirementDto {
  key: string;
  role: string;
  jobId: string;
  jobType: string;
  crpMonth: string | null;
  crpWeek: number | null;
  crpFrom: string | null;
  crpTo: string | null;
  ctcText: string;
  ctcMin: number | null;
  ctcMax: number | null;
  openings: number | null;
  masterState: MasterState;
  finalStatus: string;
  stage: string;
  idStatus: string;
  academySent: number | null;
  assessedSent: number | null;
  nonAssessedSent: number | null;
  verifiedAssessed: number | null;
  check: string;
  jdUrl: string | null;
  jdSource: "master" | "hubspot" | null;
  remarks: string | null;
  hubspotUrl: string | null;
  tentativeStart: TentativeStartDto | null;
}

export interface CompanyCandidateDto {
  uid: string;
  name: string;
  mentor: { name: string; email: string | null } | null;
  mine: boolean;
  status: ShareStatus;
  stage: string;
  kind: "shared" | "applied";
  role: string;
  sharedOn: string | null;
  updatedAt: string | null;
}

export interface CompanyCounts {
  candidates: number;
  shared: number;
  applied: number;
  inProcess: number;
  awaiting: number;
  selected: number;
  rejected: number;
  noShow: number;
  onHold: number;
  closed: number;
  noUpdate: number;
}

export interface CompanyDto {
  id: string;
  company: string;
  sheetUrl: string | null;
  state: CompanyState;
  masterState: MasterState;
  statusText: string;
  stageText: string;
  crp: { from: string | null; to: string | null; label: string };
  ctc: { text: string; min: number | null; max: number | null };
  openings: number | null;
  ise: string;
  requirements: RequirementDto[];
  counts: CompanyCounts;
  academy: { sent: number | null; assessed: number | null; nonAssessed: number | null };
  mine: number;
  lastActivityAt: string | null;
  candidates: CompanyCandidateDto[];
}

/** Internal: a requirement with the full remarks (the export keeps up to 10,000 characters; JSON 2,000). */
export interface RequirementFull extends RequirementDto {
  remarksFull: string | null;
  hubspotNote: string;
}

export interface CompanyFull extends Omit<CompanyDto, "requirements"> {
  requirements: RequirementFull[];
}

const IST_DAY = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const distinct = (list: string[]) => {
  const out: string[] = [];
  for (const v of list.map((x) => x.trim()).filter(Boolean)) if (!out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  return out;
};
const sumOrNull = (list: (number | null)[]) => (list.some((n) => n !== null) ? list.reduce<number>((a, n) => a + (n ?? 0), 0) : null);
const norm = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** A requirement's CRP period, when its month (and year) is known. */
export function requirementPeriod(r: Pick<RequirementRecord, "crpMonth" | "crpYear" | "crpWeek">): { from: string; to: string; month: string } | null {
  const m = parseCrpMonth(r.crpMonth);
  const year = m?.year ?? r.crpYear;
  if (!m || !year) return null;
  return { ...crpPeriod(year, m.month, r.crpWeek), month: crpMonthLabel(year, m.month) };
}

/** "Nov 2026 · Wk 2", "Nov 2026 · Wk 2–3", "Oct–Nov 2026", "Dec 2026 – Jan 2027", "" */
export function crpLabel(reqs: Pick<RequirementRecord, "crpMonth" | "crpYear" | "crpWeek">[]): string {
  const ps = reqs.map((r) => ({ p: requirementPeriod(r), week: r.crpWeek })).filter((x) => x.p !== null) as { p: { from: string; to: string; month: string }; week: number | null }[];
  if (!ps.length) return "";
  const months = distinct(ps.sort((a, b) => a.p.from.localeCompare(b.p.from)).map((x) => x.p.month));
  if (months.length === 1) {
    const weeks = [...new Set(ps.map((x) => x.week).filter((w): w is number => w !== null))].sort((a, b) => a - b);
    if (!weeks.length) return months[0];
    return `${months[0]} · Wk ${weeks.length === 1 ? weeks[0] : `${weeks[0]}–${weeks[weeks.length - 1]}`}`;
  }
  const [fm, fy] = months[0].split(" ");
  const [lm, ly] = months[months.length - 1].split(" ");
  return fy === ly ? `${fm}–${lm} ${ly}` : `${months[0]} – ${months[months.length - 1]}`;
}

/**
 * Tentative starts by requirement key. A start whose key is gone (the master row was edited) finds
 * its requirement again by job id + CRP month, then company + role + CRP month, when exactly one fits.
 */
export function attachStarts(reqs: RequirementRecord[], starts: StartRecord[]): Map<string, StartRecord> {
  const out = new Map<string, StartRecord>();
  const byKey = new Map(reqs.map((r) => [r.key, r]));
  const orphans: StartRecord[] = [];
  for (const s of starts) {
    if (byKey.has(s.key)) out.set(s.key, s);
    else orphans.push(s);
  }
  for (const s of orphans) {
    const free = reqs.filter((r) => !out.has(r.key) && norm(r.crpMonth) === norm(s.crpMonth));
    const byJob = s.jobId ? free.filter((r) => r.jobId.toLowerCase() === s.jobId.toLowerCase()) : [];
    const byName = free.filter((r) => norm(r.company) === norm(s.company) && norm(r.role) === norm(s.role));
    const hit = byJob.length === 1 ? byJob[0] : byName.length === 1 ? byName[0] : null;
    if (hit) out.set(hit.key, s);
  }
  return out;
}

const stateOf = (r: RequirementRecord) => requirementState(r.finalStatus, r.stage, r.idStatus);

/** "Master says 6 assessed; the company sheet has 14" — empty when the numbers agree or can't be compared. */
export function checkText(r: Pick<RequirementRecord, "academySent" | "assessedSent" | "nonAssessedSent">, verified: number | null, note = ""): string {
  const parts: string[] = [];
  if (verified !== null && r.assessedSent !== null && verified !== r.assessedSent) {
    parts.push(`Master says ${r.assessedSent} assessed; the company sheet has ${verified}`);
  } else if (verified !== null && r.assessedSent === null && verified > 0) {
    parts.push(`Master count is blank; the company sheet has ${verified} assessed`);
  }
  if (r.academySent !== null && r.assessedSent !== null && r.nonAssessedSent !== null && r.academySent !== r.assessedSent + r.nonAssessedSent) {
    parts.push(`Master total ${r.academySent} ≠ assessed ${r.assessedSent} + non-assessed ${r.nonAssessedSent}`);
  }
  if (note) parts.push(note);
  return parts.join(". ");
}

/** A candidate counts as sent when the row is in a shared tab, or an applications tab with something filled in. */
const isSent = (kind: "shared" | "applied", own: ShareStatus) => kind === "shared" || own !== "shared";

export interface BuildInput {
  requirements: RequirementRecord[];
  shares: ShareFact[];
  people: Map<string, PersonFact>;
  deals: Map<string, DealRecord>;
  starts: StartRecord[];
}

/** Every hiring drive Academy candidates were sent to (master count above 0, or found in the sheet). */
export function buildCompanies(input: BuildInput): CompanyFull[] {
  const groups = new Map<string, RequirementRecord[]>();
  for (const r of [...input.requirements].sort((a, b) => a.rowIndex - b.rowIndex)) {
    const id = r.sheetId ?? `req:${r.key}`;
    groups.set(id, [...(groups.get(id) ?? []), r]);
  }
  const sharesBySheet = new Map<string, ShareFact[]>();
  for (const s of input.shares) sharesBySheet.set(s.sheetId, [...(sharesBySheet.get(s.sheetId) ?? []), s]);
  const starts = attachStarts(input.requirements, input.starts);
  const out: CompanyFull[] = [];

  for (const [id, reqs] of groups) {
    const sheetId = reqs[0].sheetId;
    const states = reqs.map(stateOf);
    const masterState = combinedState(states);
    // One entry per candidate: a shared tab beats an applications tab, then the most advanced status, then the newest.
    type Row = { s: ShareFact; kind: "shared" | "applied"; status: ShareStatus; req: RequirementRecord | null; sent: boolean };
    const best = new Map<string, Row>();
    for (const s of sheetId ? sharesBySheet.get(sheetId) ?? [] : []) {
      if (!input.people.has(s.uid)) continue;
      const kind = isApplicationsTab(s.tab) ? "applied" : "shared";
      const req = pickRequirement({ tab: s.tab, role: s.role }, reqs);
      const status = effectiveStatus(s.own, kind, req ? stateOf(req) : masterState);
      const row: Row = { s, kind, status, req, sent: isSent(kind, s.own) };
      const cur = best.get(s.uid);
      const better =
        !cur ||
        Number(row.sent) - Number(cur.sent) > 0 ||
        (row.sent === cur.sent && (STATUS_RANK[row.status] - STATUS_RANK[cur.status] > 0 || (row.status === cur.status && row.s.changed > cur.s.changed)));
      if (better) best.set(s.uid, row);
    }
    const rows = [...best.values()];
    const sent = rows.filter((r) => r.sent);
    const masterSent = reqs.some((r) => (r.academySent ?? 0) > 0 || (r.assessedSent ?? 0) > 0 || (r.nonAssessedSent ?? 0) > 0);
    if (!masterSent && !sent.length) continue;

    // Verified per requirement: exact when the sheet serves one requirement, or every sent candidate's tab names its requirement.
    const verified = new Map<string, number | null>();
    let note = "";
    if (reqs.length === 1) verified.set(reqs[0].key, sheetId ? sent.length : null);
    else if (sheetId && sent.every((r) => r.req)) for (const r of reqs) verified.set(r.key, sent.filter((x) => x.req?.key === r.key).length);
    else {
      for (const r of reqs) verified.set(r.key, null);
      if (sheetId) note = `The company sheet serves ${reqs.length} requirements and has ${sent.length} Academy assessed in all`;
    }

    const count = (st: ShareStatus) => rows.filter((r) => r.status === st).length;
    const counts: CompanyCounts = {
      candidates: rows.length,
      shared: sent.length,
      applied: rows.length - sent.length,
      inProcess: count("in_process"),
      awaiting: count("awaiting"),
      selected: count("selected"),
      rejected: count("rejected"),
      noShow: count("no_show"),
      onHold: count("on_hold"),
      closed: count("closed"),
      noUpdate: count("shared"),
    };
    const active = rows.some((r) => r.status === "in_process" || r.status === "awaiting");
    const allFinal = rows.length > 0 && rows.every((r) => isFinalStatus(r.status));
    let state: CompanyState;
    if (masterState === "closed" || allFinal) state = "done";
    else if (active) state = "in_progress";
    else if (masterState === "on_hold" || rows.some((r) => r.status === "on_hold")) state = "on_hold";
    else state = "waiting";

    const periods = reqs.map(requirementPeriod).filter((p): p is NonNullable<typeof p> => p !== null);
    const ctcs = reqs.map((r) => parseCtc(r.ctcText)).filter((c): c is NonNullable<typeof c> => c !== null);
    const ctcTexts = distinct(reqs.map((r) => ctcLabel(r.ctcText)));
    const requirements: RequirementFull[] = reqs.map((r) => {
      const p = requirementPeriod(r);
      const c = parseCtc(r.ctcText);
      const deal = r.hubspotDealId ? input.deals.get(r.hubspotDealId) ?? null : null;
      const jdUrl = r.jdUrl ?? deal?.jdUrl ?? null;
      const remarksFull = jdUrl ? null : deal?.remarks ?? null;
      const v = verified.get(r.key) ?? null;
      const st = starts.get(r.key);
      return {
        key: r.key,
        role: r.role,
        jobId: r.jobId,
        jobType: r.jobType,
        crpMonth: p?.month ?? (r.crpMonth || null),
        crpWeek: r.crpWeek,
        crpFrom: p?.from ?? null,
        crpTo: p?.to ?? null,
        ctcText: ctcLabel(r.ctcText),
        ctcMin: c?.min ?? null,
        ctcMax: c?.max ?? null,
        openings: r.openings,
        masterState: stateOf(r),
        finalStatus: r.finalStatus,
        stage: r.stage,
        idStatus: r.idStatus,
        academySent: r.academySent,
        assessedSent: r.assessedSent,
        nonAssessedSent: r.nonAssessedSent,
        verifiedAssessed: v,
        check: checkText(r, v, v === null ? note : ""),
        jdUrl,
        jdSource: r.jdUrl ? "master" : deal?.jdUrl ? "hubspot" : null,
        remarks: remarksFull ? clip(remarksFull, 2000) : null,
        remarksFull,
        hubspotUrl: r.hubspotUrl,
        hubspotNote: !r.hubspotDealId ? (r.hubspotUrl ? "Not a deal link" : "") : !deal ? "Not read yet" : deal.error ? deal.error : "",
        tentativeStart: st ? { date: st.date, by: st.by, at: st.at.toISOString() } : null,
      };
    });
    const candidates: CompanyCandidateDto[] = rows
      .map((r) => {
        const p = input.people.get(r.s.uid)!;
        return {
          uid: r.s.uid,
          name: p.name,
          mentor: p.mentor,
          mine: p.mine,
          status: r.status,
          stage: r.s.stage,
          kind: r.kind,
          role: r.req?.role || r.s.role,
          sharedOn: IST_DAY(r.s.firstSeen),
          updatedAt: r.s.changed.toISOString(),
        };
      })
      .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
    const activity = rows.map((r) => Math.max(r.s.changed.getTime(), r.s.firstSeen.getTime()));
    out.push({
      id,
      company: reqs[0].company,
      sheetUrl: sheetId ? sheetUrl(sheetId) : null,
      state,
      masterState,
      statusText: distinct(reqs.map((r) => r.finalStatus)).join(" / "),
      stageText: distinct(reqs.map((r) => r.stage)).join(" / "),
      crp: {
        from: periods.length ? periods.map((p) => p.from).sort()[0] : null,
        to: periods.length ? periods.map((p) => p.to).sort().at(-1)! : null,
        label: crpLabel(reqs),
      },
      ctc: {
        text: ctcTexts.length === 1 ? ctcTexts[0] : ctcs.length ? ctcLabel(`${Math.min(...ctcs.map((c) => c.min))}-${Math.max(...ctcs.map((c) => c.max))}`) : "",
        min: ctcs.length ? Math.min(...ctcs.map((c) => c.min)) : null,
        max: ctcs.length ? Math.max(...ctcs.map((c) => c.max)) : null,
      },
      openings: sumOrNull(reqs.map((r) => r.openings)),
      ise: distinct(reqs.map((r) => r.ise)).join(" / "),
      requirements,
      counts,
      academy: {
        sent: sumOrNull(reqs.map((r) => r.academySent)),
        assessed: sumOrNull(reqs.map((r) => r.assessedSent)),
        nonAssessed: sumOrNull(reqs.map((r) => r.nonAssessedSent)),
      },
      mine: candidates.filter((c) => c.mine).length,
      lastActivityAt: activity.length ? new Date(Math.max(...activity)).toISOString() : null,
      candidates,
    });
  }
  return sortCompanies(out, "activity");
}

/** The JSON shape (remarks clipped, internal fields dropped). */
export function companyDto(c: CompanyFull): CompanyDto {
  return { ...c, requirements: c.requirements.map(({ remarksFull: _r, hubspotNote: _h, ...r }) => r) };
}

// ── Filters and sorting (the export uses the screen's) ──────────────────────

export type CompanyStateFilter = CompanyState | "active" | "all";
export type CompanySort = "activity" | "ctc" | "openings" | "crp";

export interface CompanyFilter {
  state?: CompanyStateFilter;
  /** YYYY-MM-DD: drives whose CRP period overlaps [from, to]. */
  from?: string | null;
  to?: string | null;
  mine?: boolean;
  q?: string | null;
}

export const isStateFilter = (v: string): v is CompanyStateFilter => ["in_progress", "waiting", "on_hold", "done", "active", "all"].includes(v);
export const isCompanySort = (v: string): v is CompanySort => ["activity", "ctc", "openings", "crp"].includes(v);
export const isDay = (v: string | null | undefined): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

export function filterCompanies<T extends Pick<CompanyDto, "state" | "crp" | "mine" | "company"> & { requirements: Pick<RequirementDto, "role">[] }>(
  list: T[],
  f: CompanyFilter,
): T[] {
  const q = norm(f.q ?? "");
  return list.filter((c) => {
    if (f.state && f.state !== "all") {
      if (f.state === "active" ? c.state === "done" : c.state !== f.state) return false;
    }
    if (f.mine && c.mine <= 0) return false;
    if (f.from || f.to) {
      if (!c.crp.from || !c.crp.to) return false;
      if (f.from && c.crp.to < f.from) return false;
      if (f.to && c.crp.from > f.to) return false;
    }
    if (q && !norm(`${c.company} ${c.requirements.map((r) => r.role).join(" ")}`).includes(q)) return false;
    return true;
  });
}

const STATE_ORDER: Record<CompanyState, number> = { in_progress: 0, waiting: 1, on_hold: 2, done: 3 };
const desc = (a: number | null, b: number | null) => (b ?? -1) - (a ?? -1);

/** activity: state, then newest activity; ctc: highest CTC, then openings; openings: most openings, then CTC; crp: newest CRP first. */
export function sortCompanies<T extends Pick<CompanyDto, "state" | "ctc" | "openings" | "crp" | "lastActivityAt" | "company">>(list: T[], sort: CompanySort): T[] {
  const name = (a: T, b: T) => a.company.localeCompare(b.company, "en", { sensitivity: "base" });
  const act = (c: T) => (c.lastActivityAt ? Date.parse(c.lastActivityAt) : null);
  const crpTo = (c: T) => (c.crp.to ? Date.parse(c.crp.to) : null);
  const by: Record<CompanySort, (a: T, b: T) => number> = {
    activity: (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || desc(act(a), act(b)) || desc(crpTo(a), crpTo(b)) || name(a, b),
    ctc: (a, b) => desc(a.ctc.max, b.ctc.max) || desc(a.ctc.min, b.ctc.min) || desc(a.openings, b.openings) || name(a, b),
    openings: (a, b) => desc(a.openings, b.openings) || desc(a.ctc.max, b.ctc.max) || name(a, b),
    crp: (a, b) => desc(crpTo(a), crpTo(b)) || STATE_ORDER[a.state] - STATE_ORDER[b.state] || name(a, b),
  };
  return [...list].sort(by[sort]);
}

/**
 * Academy candidates went to this requirement: a master count above 0, or found in its sheet; or it
 * can't be told (the master is blank and the sheet serves several requirements).
 */
export const academySentTo = (r: Pick<RequirementDto, "academySent" | "assessedSent" | "nonAssessedSent" | "verifiedAssessed">) =>
  (r.academySent ?? 0) > 0 ||
  (r.assessedSent ?? 0) > 0 ||
  (r.nonAssessedSent ?? 0) > 0 ||
  (r.verifiedAssessed ?? 0) > 0 ||
  (r.verifiedAssessed === null && r.academySent === null && r.assessedSent === null && r.nonAssessedSent === null);

/**
 * The export's rows: one per requirement Academy candidates went to (academySentTo). CTC / openings sorts order the requirements themselves.
 * With a CRP period, only the requirements whose own CRP overlaps it (a drive can span months).
 */
export function exportRows(
  list: CompanyFull[],
  sort: CompanySort,
  period: { from?: string | null; to?: string | null } = {},
): { company: CompanyFull; req: RequirementFull }[] {
  const inPeriod = (r: RequirementFull) =>
    (!period.from && !period.to) || (r.crpFrom !== null && r.crpTo !== null && (!period.from || r.crpTo >= period.from) && (!period.to || r.crpFrom <= period.to));
  const rows = list.flatMap((company) => company.requirements.filter((r) => inPeriod(r) && academySentTo(r)).map((req) => ({ company, req })));
  if (sort === "ctc") {
    return rows.sort(
      (a, b) => desc(a.req.ctcMax, b.req.ctcMax) || desc(a.req.ctcMin, b.req.ctcMin) || desc(a.req.openings, b.req.openings) || a.company.company.localeCompare(b.company.company),
    );
  }
  if (sort === "openings") {
    return rows.sort((a, b) => desc(a.req.openings, b.req.openings) || desc(a.req.ctcMax, b.req.ctcMax) || a.company.company.localeCompare(b.company.company));
  }
  return rows;
}

/** "3 in process · 1 awaiting · 1 selected · 2 rejected" (zero parts left out). */
export function countsText(c: CompanyCounts): string {
  const parts: [number, string][] = [
    [c.inProcess, "in process"],
    [c.awaiting, "awaiting result"],
    [c.onHold, "on hold"],
    [c.noUpdate, "no update"],
    [c.selected, "selected"],
    [c.rejected, "rejected"],
    [c.noShow, "no show"],
    [c.closed, "closed"],
    [c.applied, "applied only"],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, l]) => `${n} ${l}`)
    .join(" · ");
}
