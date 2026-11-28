import { requirementPeriod } from "@/lib/mobile/pool/companies-model";
import {
  cellSignal,
  crpPeriod,
  isApplicationsTab,
  keyText,
  logical,
  parseCrpMonth,
  pickRequirement,
  requirementState,
  type MasterState,
  type Round,
  SCREENING_ROUND,
  type ShareStatus,
} from "@/lib/mobile/pool/shares";
import { andList, jobSkills, roleFamily } from "@/lib/feedback-docs/skills";

/**
 * Candidate feedback documents (PSM 1.13.0) — the pure part: a candidate's jobs in a period (from
 * their applications, the profiles the team shared and every company result), what happened in each,
 * why the ones that didn't move forward stopped (from the resume review), and the document's content.
 * No I/O: tested in scripts/feedback-selftest.ts; service.ts loads the inputs, review.ts reviews the
 * resumes, render.ts writes the .docx.
 *
 * Every statement in the document is a fact from the records or a check on the resume text; what
 * can't be told is said so (or left to the reviewer through `notes`), never guessed:
 *  - "selected by company": the company took the resume forward (a later round has a result, the
 *    screening round says cleared / selected, or the final status says selected);
 *  - "not taken forward by company": the company's screening (or final status) says rejected;
 *  - "not selected": the candidate applied, the profiles for that job were sent (the master's Academy
 *    counts or Academy candidates in the company sheet) or the job is closed, and they weren't among them;
 *  - "result awaited": sent, no result yet; or applied and nothing sent yet while the job is open;
 *  - "not known": no readable company sheet and the job isn't open (the reviewer checks it).
 */

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface FbRequirement {
  key: string;
  sheetId: string | null;
  company: string;
  role: string;
  jobId: string;
  crpMonth: string;
  crpYear: number | null;
  crpWeek: number | null;
  finalStatus: string;
  stage: string;
  idStatus: string;
  academySent: number | null;
  assessedSent: number | null;
  nonAssessedSent: number | null;
  techStack: string;
  jdUrl: string | null;
  /** "ID Month" as typed and its year: a job whose ID was done in the period belongs to it. */
  idMonth?: string;
  idYear?: number | null;
}

export interface FbApplication {
  jobId: string;
  appliedAt: Date | null;
  resumeUrl: string | null;
  source: "portal" | "form";
}

export interface FbShare {
  id: string;
  sheetId: string;
  tab: string;
  role: string;
  company: string;
  rounds: Round[];
  finalStatus: string;
  /** The candidate's own status in the tab (before the requirement's state). */
  own: ShareStatus;
  firstSeen: Date;
  resumeUrl: string | null;
}

export interface FbSheet {
  /** Read at least once and without a read error. */
  readable: boolean;
  /** Academy assessed rows (any candidate) per tab: in a shared tab, profiles the team sent. */
  tabs: Map<string, number>;
}

export interface FbInterview {
  jobId: string;
  company: string;
  round: string;
  /** YYYY-MM-DD */
  day: string | null;
  cancelled: boolean;
}

export interface FeedbackInput {
  candidate: { uid: string; name: string };
  period: { from: string; to: string };
  requirements: FbRequirement[];
  applications: FbApplication[];
  shares: FbShare[];
  sheets: Map<string, FbSheet>;
  interviews: FbInterview[];
  /** YYYY-MM-DD (IST) */
  today: string;
  /** Imported reviews of the candidate's applications (app.application_reviews, not the server's own). */
  reviews?: ImportedReview[];
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export type JobOutcome = "selected" | "awaited" | "not_forwarded" | "not_shortlisted" | "closed" | "no_show" | "not_known";
export const DID_NOT_MOVE: JobOutcome[] = ["not_forwarded", "not_shortlisted", "closed", "no_show"];

export type RoundKind = "interview" | "assignment" | "test";

export interface RoundItem {
  label: string;
  kind: RoundKind;
  result: string;
  /** YYYY-MM-DD from the drill-down, when known. */
  day: string | null;
  status: ShareStatus;
}

export interface FbJob {
  key: string;
  company: string;
  role: string;
  jobId: string;
  requirement: FbRequirement | null;
  period: { from: string; to: string } | null;
  appliedAt: Date | null;
  firstSeen: Date | null;
  /** An application is on record (internal sheet, or the company sheet's applications tab). */
  applied: boolean;
  /** In a shared tab of the company sheet: the team sent the profile. */
  shared: boolean;
  outcome: JobOutcome;
  /** "on_hold", "unverified" (no readable company sheet), "still_open" (not sent so far, job open). */
  flags: string[];
  items: RoundItem[];
  resumeUrl: string | null;
  techStack: string;
  jdUrl: string | null;
  /** The month its ID was done, when the requirement says "ID Done" (else null). */
  idDone: { from: string; to: string } | null;
  /** The imported review of this application, when there is one. */
  review: ImportedReview | null;
  /** The imported assignment result, when the job had one. */
  assignment: AssignmentFact | null;
}

/** The month a requirement's ID was done, when its Company ID Status says so. */
export function idDoneMonth(r: Pick<FbRequirement, "idStatus" | "idMonth" | "idYear"> | null): { from: string; to: string } | null {
  if (!r || !/\bid\s*done\b/i.test(r.idStatus) || !r.idMonth) return null;
  const m = parseCrpMonth(r.idMonth);
  const year = m?.year ?? r.idYear ?? null;
  return m && year ? crpPeriod(year, m.month, null) : null;
}

const IST_MS = 330 * 60_000;
export const istDay = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
const normJob = (j: string) => j.trim().toLowerCase();
const jobKeyOf = (r: Pick<FbRequirement, "jobId" | "company" | "role">) => (r.jobId.trim() ? `job:${normJob(r.jobId)}` : `req:${keyText(r.company)}/${keyText(r.role)}`);
const stateOf = (r: FbRequirement | null): MasterState => (r ? requirementState(r.finalStatus, r.stage, r.idStatus) : "unknown");
const RESUME_NEGATIVE = /not shortlisted|resume (is )?(rejected|not selected)|profile (is )?(rejected|not selected|not shortlisted)|screen(ed|ing)? ?(out|rejected)/i;
const STATUS_COLUMN = /\bstatus\b|\bremarks?\b|\bfeedback\b|\bcomments?\b/i;
const HIRED = /\b(hired|offer(ed)?|placed|joined|onboarded|accepted)\b|yet to join|joining (date|on)/i;

/** A round column's name for people: "TR Round 1" → TR1, "Assignment Round" → Assignment, "HR Round" → HR round. */
export function roundLabelOf(name: string): { label: string; kind: RoundKind } {
  const n = name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  if (/assign|take ?home|\btasks?\b|case study|project (round|submission)/.test(n)) return { label: "Assignment", kind: "assignment" };
  if (/assess|\btests?\b|coding|aptitude|online|hacker ?rank|\bmcq\b|quiz|\boa\b/.test(n)) return { label: "Online test", kind: "test" };
  const num = n.match(/\btr\s*-?\s*(?:round\s*)?(\d)|technical\s*(?:round|interview)?\s*-?\s*(\d)|\br\s*(\d)\b/);
  if (num) return { label: `TR${num[1] ?? num[2] ?? num[3]}`, kind: "interview" };
  if (/\bhr\b/.test(n)) return { label: "HR round", kind: "interview" };
  if (/\bmr\b|managerial|manager/.test(n)) return { label: "Managerial round", kind: "interview" };
  if (/founder|\bceo\b|\bcto\b|director/.test(n)) return { label: "Founder round", kind: "interview" };
  if (/\bgd\b|group discussion/.test(n)) return { label: "Group discussion", kind: "interview" };
  if (/\btr\b|technical/.test(n)) return { label: "Technical round", kind: "interview" };
  if (/offline drive|\bdrive\b/.test(n)) return { label: "Offline drive", kind: "interview" };
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 40);
  return { label: clean ? clean[0].toUpperCase() + clean.slice(1) : "Round", kind: "interview" };
}

/** What a round's result means, in plain words. */
export function roundResultText(status: ShareStatus, cleared: boolean, value: string, kind: RoundKind): string {
  const v = value.toLowerCase();
  if (kind === "assignment") {
    if (/not submitted|did ?n.?t submit|not attempted|did ?n.?t attempt/.test(v)) return "not submitted";
    if (status === "awaiting" && /submit/.test(v)) return "submitted, result awaited";
  }
  switch (status) {
    case "selected":
      return kind === "interview" ? "selected" : "cleared";
    case "in_process":
      if (cleared) return "cleared";
      if (/yet to|to be|tbd/.test(v)) return "to be scheduled";
      if (/schedul/.test(v)) return "scheduled";
      return "in progress";
    case "awaiting":
      return "result awaited";
    case "rejected":
      return "not cleared";
    case "no_show":
      return "did not attend";
    case "on_hold":
      return "on hold";
    case "closed":
      return "requirement closed";
    default:
      return value.slice(0, 40);
  }
}

const roundKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/round|interview|\s|-/g, "")
    .replace(/^technical(\d)$/, "tr$1")
    .replace(/^r(\d)$/, "tr$1");

/** The drill-down day of a job's round (latest live one). */
function interviewDay(job: Pick<FbJob, "jobId" | "company">, label: string, interviews: FbInterview[]): string | null {
  const co = keyText(job.company);
  const want = roundKey(label);
  const hits = interviews.filter((iv) => {
    if (iv.cancelled || !iv.day) return false;
    const sameJob = job.jobId && iv.jobId ? normJob(iv.jobId) === normJob(job.jobId) : false;
    const ivCo = keyText(iv.company.split(/\s+-\s+|\s*\|\s*/)[0] ?? "");
    const sameCompany = co.length >= 3 && ivCo.length >= 3 && (ivCo.startsWith(co) || co.startsWith(ivCo));
    return (sameJob || (!iv.jobId && sameCompany) || (sameCompany && !job.jobId)) && roundKey(iv.round) === want;
  });
  return hits.map((h) => h.day!).sort().at(-1) ?? null;
}

interface ShareVerdictFb {
  outcome: JobOutcome;
  items: RoundItem[];
  flags: string[];
}

const OUTCOME_RANK: Record<JobOutcome, number> = { selected: 7, awaited: 6, no_show: 4, not_forwarded: 3, closed: 2, not_shortlisted: 1, not_known: 0 };

/** What one company-sheet row says happened (see the module comment). */
export function evaluateShare(row: Pick<FbShare, "rounds" | "finalStatus" | "own">, reqState: MasterState, job: Pick<FbJob, "jobId" | "company">, interviews: FbInterview[]): ShareVerdictFb {
  const ordered = logical(row.rounds);
  const isScreen = (r: Round) => SCREENING_ROUND.test(r.name);
  const lastName = ordered.filter((r) => !isScreen(r)).at(-1)?.name;
  const screening = ordered.filter(isScreen);
  const later = ordered.filter((r) => !isScreen(r) && !STATUS_COLUMN.test(r.name));
  const screenSigs = screening.map((r) => ({ r, s: cellSignal(r.value, "round", false) }));
  const screenCleared = screenSigs.some((x) => Boolean(x.s?.cleared) || x.s?.status === "selected");
  const screenNeg = !screenCleared && screenSigs.some((x) => x.s?.status === "rejected" || RESUME_NEGATIVE.test(x.r.value));
  const valued = later
    .map((r) => ({ r, s: cellSignal(r.value, "round", r.name === lastName) }))
    .filter((x): x is { r: Round; s: NonNullable<ReturnType<typeof cellSignal>> } => x.s !== null);
  // "Not shortlisted" in the first round with a value (nothing cleared before it) is the resume stage;
  // after a cleared round it is that round's result.
  const firstNeg = !screenCleared && valued.length > 0 && RESUME_NEGATIVE.test(valued[0].r.value);
  // A round that only says the requirement closed / wasn't reached doesn't show the company took the profile forward.
  const laterSigs = valued.filter((x, i) => x.s.status !== "closed" && !(i === 0 && firstNeg));
  // "Rejected" in every round (HR, assessment …) is the whole row marked rejected at once: the company
  // didn't take the profile forward, it didn't fail each round.
  const bulkRejected = !screenCleared && laterSigs.length >= 2 && laterSigs.every((x) => x.s.status === "rejected");
  const fin = row.finalStatus ? cellSignal(row.finalStatus, "final") : null;
  const finNeg = !screenCleared && !laterSigs.length && RESUME_NEGATIVE.test(row.finalStatus);
  const resumeNeg = screenNeg || firstNeg || bulkRejected || finNeg;
  const flags: string[] = [];

  if (!resumeNeg && (laterSigs.length > 0 || screenCleared || fin?.status === "selected")) {
    const items: RoundItem[] = [];
    for (const { r, s } of laterSigs) {
      const { label, kind } = roundLabelOf(r.name);
      items.push({ label, kind, result: roundResultText(s.status, Boolean(s.cleared), r.value, kind), day: kind === "interview" ? interviewDay(job, label, interviews) : null, status: s.status });
      if (s.status === "rejected" || s.status === "no_show" || s.status === "closed") break;
    }
    const stopped = items.some((i) => i.status === "rejected" || i.status === "no_show" || i.status === "closed");
    if (!stopped && fin?.decisive) {
      if (fin.status === "selected") items.push({ label: "Final result", kind: "interview", result: HIRED.test(row.finalStatus) ? "selected (offer)" : "selected", day: null, status: "selected" });
      else if (fin.status === "rejected" || fin.status === "no_show") items.push({ label: "Final result", kind: "interview", result: fin.status === "no_show" ? "did not attend" : "not selected", day: null, status: fin.status });
      else if (fin.status === "closed") items.push({ label: "Final result", kind: "interview", result: "requirement closed", day: null, status: "closed" });
    }
    if (!items.some((i) => i.status === "rejected" || i.status === "no_show" || i.status === "closed" || i.status === "selected") && reqState === "closed") flags.push("closed_after_shortlist");
    return { outcome: "selected", items, flags };
  }
  if (resumeNeg || row.own === "rejected") return { outcome: "not_forwarded", items: [], flags };
  if (row.own === "no_show") return { outcome: "no_show", items: [], flags };
  if (row.own === "closed" || reqState === "closed") return { outcome: "closed", items: [], flags };
  if (row.own === "on_hold" || reqState === "on_hold") return { outcome: "awaited", items: [], flags: ["on_hold"] };
  return { outcome: "awaited", items: [], flags };
}

/** The requirement row a job's period is read from, when its job id has several CRP rows (batches). */
export function chooseRequirement(rows: FbRequirement[], hint: { picked?: FbRequirement | null; when?: Date | null }): FbRequirement | null {
  if (!rows.length) return null;
  if (rows.length === 1) return rows[0];
  if (hint.picked && rows.includes(hint.picked)) return hint.picked;
  const dated = rows
    .map((r) => ({ r, p: requirementPeriod(r) }))
    .filter((x): x is { r: FbRequirement; p: NonNullable<ReturnType<typeof requirementPeriod>> } => x.p !== null)
    .sort((a, b) => a.p.from.localeCompare(b.p.from));
  if (hint.when && dated.length) {
    const day = istDay(hint.when);
    return (dated.find((x) => x.p.to >= day) ?? dated[dated.length - 1]).r;
  }
  return dated.length ? dated[dated.length - 1].r : rows[rows.length - 1];
}

/** Every job of the candidate (any period), with what happened in it. */
export function assembleJobs(input: Omit<FeedbackInput, "period">): FbJob[] {
  const byJob = new Map<string, FbRequirement[]>();
  const bySheet = new Map<string, FbRequirement[]>();
  for (const r of [...input.requirements].sort((a, b) => a.key.localeCompare(b.key))) {
    if (r.jobId.trim()) byJob.set(normJob(r.jobId), [...(byJob.get(normJob(r.jobId)) ?? []), r]);
    if (r.sheetId) bySheet.set(r.sheetId, [...(bySheet.get(r.sheetId) ?? []), r]);
  }
  const appliedJobIds = new Set(input.applications.map((a) => normJob(a.jobId)).filter((j) => byJob.has(j)));

  interface Acc {
    key: string;
    reqs: FbRequirement[];
    picked: FbRequirement | null;
    apps: FbApplication[];
    shared: FbShare[];
    appliedTab: FbShare[];
    company: string;
    role: string;
    review: ImportedReview | null;
  }
  const acc = new Map<string, Acc>();
  const get = (key: string, init: () => Omit<Acc, "key" | "apps" | "shared" | "appliedTab" | "picked" | "review">) => {
    let a = acc.get(key);
    if (!a) {
      a = { key, apps: [], shared: [], appliedTab: [], picked: null, review: null, ...init() };
      acc.set(key, a);
    }
    return a;
  };

  for (const app of input.applications) {
    const reqs = byJob.get(normJob(app.jobId));
    if (!reqs?.length) continue; // a job the CRPs master doesn't list: it can't be named
    get(`job:${normJob(app.jobId)}`, () => ({ reqs, company: reqs[0].company, role: reqs[0].role })).apps.push(app);
  }

  for (const s of input.shares) {
    const reqs = bySheet.get(s.sheetId) ?? [];
    let key: string;
    let picked: FbRequirement | null = null;
    let group: FbRequirement[] = [];
    if (!reqs.length) {
      key = `sheet:${s.sheetId}:${keyText(s.tab)}`;
    } else {
      picked = pickRequirement({ tab: s.tab, role: s.role }, reqs);
      const ids = [...new Set(reqs.map((r) => normJob(r.jobId)).filter(Boolean))];
      const names = new Set(reqs.map((r) => `${keyText(r.company)}/${keyText(r.role)}`));
      if (picked) {
        key = jobKeyOf(picked);
      } else if (ids.length === 1 && reqs.every((r) => r.jobId.trim())) {
        key = `job:${ids[0]}`;
      } else if (ids.filter((j) => appliedJobIds.has(j)).length === 1) {
        key = `job:${ids.find((j) => appliedJobIds.has(j))}`;
      } else if (names.size === 1) {
        key = jobKeyOf(reqs[0]);
      } else {
        key = `sheet:${s.sheetId}:${keyText(s.tab)}`;
      }
      group = key.startsWith("job:") ? byJob.get(key.slice(4)) ?? reqs.filter((r) => jobKeyOf(r) === key) : key.startsWith("req:") ? reqs.filter((r) => jobKeyOf(r) === key) : [];
    }
    const a = get(key, () => ({ reqs: group, company: group[0]?.company ?? s.company, role: group[0]?.role ?? s.role }));
    if (picked && !a.picked) a.picked = picked;
    if (isApplicationsTab(s.tab)) a.appliedTab.push(s);
    else a.shared.push(s);
  }

  // Sheets where one of the candidate's own rows couldn't be tied to a role: their other jobs can't be concluded.
  const unresolved = new Set([...acc.keys()].filter((k) => k.startsWith("sheet:")).map((k) => k.split(":")[1]));

  /** Profiles the team sent for [req]'s job: Academy rows in the sheet's shared tabs that belong to it (null: can't tell). */
  const sentFor = (req: FbRequirement, sheet: FbSheet): number | null => {
    const reqs = bySheet.get(req.sheetId ?? "") ?? [req];
    const ids = new Set(reqs.map((r) => normJob(r.jobId)).filter(Boolean));
    let n = 0;
    let unknown = 0;
    for (const [tab, count] of sheet.tabs) {
      if (isApplicationsTab(tab)) continue;
      const own = reqs.length === 1 || ids.size === 1 ? req : pickRequirement({ tab, role: tab }, reqs);
      if (!own) unknown += count;
      else if (own === req || (normJob(own.jobId) && normJob(own.jobId) === normJob(req.jobId))) n += count;
    }
    return n > 0 ? n : unknown > 0 ? null : 0;
  };

  // Imported reviews: a job the review knows about (an application, a profile sent) is the candidate's job too.
  for (const rv of input.reviews ?? []) {
    const id = normJob(rv.jobId);
    const reqs = byJob.get(id);
    if (!reqs?.length) continue;
    const a = get(`job:${id}`, () => ({ reqs, company: reqs[0].company, role: reqs[0].role }));
    a.review = rv;
  }

  const jobs: FbJob[] = [];
  for (const a of acc.values()) {
    const appliedAt = a.apps.map((x) => x.appliedAt).filter((d): d is Date => d !== null).sort((x, y) => x.getTime() - y.getTime())[0] ?? null;
    const firstSeen = [...a.shared, ...a.appliedTab].map((x) => x.firstSeen).sort((x, y) => x.getTime() - y.getTime())[0] ?? null;
    const req = chooseRequirement(a.reqs, { picked: a.picked, when: appliedAt ?? firstSeen });
    const p = req ? requirementPeriod(req) : null;
    const reqState = stateOf(req);
    // Rows of the same batch (same CRP period) that disagree: an "ID Done" on any of them counts.
    const batch = p ? a.reqs.filter((r) => {
      const q = requirementPeriod(r);
      return q !== null && q.from === p.from && q.to === p.to;
    }) : [];
    const idDone = idDoneMonth(req) ?? batch.map(idDoneMonth).find((x) => x !== null) ?? null;
    const job: FbJob = {
      key: a.key,
      company: (req?.company ?? a.company).trim() || "Company",
      role: cleanRole(req?.role ?? a.role),
      jobId: req?.jobId ?? "",
      requirement: req,
      period: p ? { from: p.from, to: p.to } : null,
      appliedAt,
      firstSeen,
      applied: a.apps.length > 0 || a.appliedTab.length > 0,
      shared: a.shared.length > 0,
      outcome: "not_known",
      flags: [],
      items: [],
      // An imported review's reasons are about the resume it read: that resume is the one listed.
      resumeUrl:
        a.review?.resumeUrl ??
        a.apps.filter((x) => x.resumeUrl).sort((x, y) => (x.appliedAt?.getTime() ?? 0) - (y.appliedAt?.getTime() ?? 0))[0]?.resumeUrl ??
        a.shared.find((x) => x.resumeUrl)?.resumeUrl ??
        a.appliedTab.find((x) => x.resumeUrl)?.resumeUrl ??
        null,
      techStack: req?.techStack ?? "",
      jdUrl: req?.jdUrl ?? null,
      idDone,
      review: a.review,
      assignment: a.review?.assignment ?? null,
    };
    const rows = [...a.shared, ...a.appliedTab.filter((r) => r.rounds.length > 0 || r.finalStatus)];
    if (rows.length) {
      const verdicts = rows.map((r) => evaluateShare(r, reqState, job, input.interviews));
      const best = verdicts.sort((x, y) => OUTCOME_RANK[y.outcome] - OUTCOME_RANK[x.outcome])[0];
      job.outcome = best.outcome;
      job.items = best.items;
      job.flags = best.flags;
    } else {
      const sheet = req?.sheetId ? input.sheets.get(req.sheetId) : undefined;
      // The batch the candidate applied for (the chosen CRP row), not every batch of the job id.
      const masterSent = Boolean(req && ((req.academySent ?? 0) > 0 || (req.assessedSent ?? 0) > 0 || (req.nonAssessedSent ?? 0) > 0));
      if (!req) job.outcome = "not_known";
      else if (req.sheetId && unresolved.has(req.sheetId)) {
        // A row of theirs in this sheet couldn't be tied to a role: it may be this job's.
        job.outcome = "not_known";
        job.flags.push("ambiguous");
      } else if (!sheet?.readable) {
        if (reqState === "open" || reqState === "unknown") {
          job.outcome = "awaited";
          job.flags.push("unverified");
        } else if (reqState === "on_hold") {
          job.outcome = "awaited";
          job.flags.push("unverified", "on_hold");
        } else job.outcome = "not_known";
      } else {
        const sharedHere = sentFor(req, sheet);
        const sent = masterSent || (sharedHere ?? 0) > 0;
        if (!sent && sharedHere === null) {
          job.outcome = reqState === "closed" ? "not_known" : "awaited";
          job.flags.push("ambiguous");
        } else if (reqState === "closed") job.outcome = sent ? "not_shortlisted" : "closed";
        else if (sent) {
          job.outcome = "not_shortlisted";
          if (reqState === "open" || reqState === "unknown") job.flags.push("still_open");
        } else {
          job.outcome = "awaited";
          if (reqState === "on_hold") job.flags.push("on_hold");
        }
      }
    }
    // An imported review settles what the live records can't (no company sheet, an uploaded export, a
    // correction): its decision is used unless the company sheet already shows a result for the profile.
    const rv = a.review;
    if (rv) {
      if (rv.applied) job.applied = true;
      const liveSettled = job.shared && job.outcome !== "awaited" && job.outcome !== "not_known";
      let o: JobOutcome | null = null;
      if (!liveSettled) {
        if (rv.decision === "selected") o = "selected";
        else if (rv.decision === "rejected") o = rv.sent ? "not_forwarded" : "not_shortlisted";
        else if (!job.shared && rv.sent === false && rv.applied) o = "not_shortlisted";
        else if (!job.shared && rv.sent === true) o = job.outcome === "awaited" || job.outcome === "not_known" ? "awaited" : null;
      }
      if (o) {
        job.outcome = o;
        job.flags = job.flags.filter((f) => f !== "unverified");
        if (o !== "awaited" && reqState === "closed") job.flags = job.flags.filter((f) => f !== "still_open");
        job.flags.push("review");
      }
    }
    jobs.push(job);
  }
  return jobs;
}

/** "Data Analyst Intern (Batch 2)" → "Data Analyst Intern"; spaces tidied. */
export function cleanRole(role: string): string {
  return (
    role
      .normalize("NFKC")
      .replace(/\s*\((?:batch|jd)[^)]*\)\s*/gi, " ")
      .replace(/\s*\|\|.*$/, "")
      .replace(/\s+/g, " ")
      .trim() || "Role not named"
  );
}

/**
 * The jobs of [period]: its CRP period overlaps it, or its ID was done in it ("November" = November
 * CRP + November ID done, as in the November Academy review); a job with neither, by its application
 * (else share) date.
 */
export function jobsInPeriod(jobs: FbJob[], period: { from: string; to: string }): FbJob[] {
  const overlaps = (p: { from: string; to: string }) => p.from <= period.to && p.to >= period.from;
  return jobs.filter((j) => {
    if (j.period && overlaps(j.period)) return true;
    if (j.idDone && overlaps(j.idDone)) return true;
    if (j.period || j.idDone) return false;
    const when = j.appliedAt ?? j.firstSeen;
    if (!when) return false;
    const d = istDay(when);
    return d >= period.from && d <= period.to;
  });
}

// ── What the reasons are written from ───────────────────────────────────────

export type CoreShown = "in_projects" | "listed_only" | "not_shown" | "unverified";

/** The server's own review of one job's resume (review.ts). */
export interface JobReview {
  core: { skill: string; shown: CoreShown }[];
  /** Listed tech-stack items (not core) that aren't anywhere in the resume. */
  mustNotShown: string[];
  /** Listed tech-stack items only in the Skills list / summary. */
  listedOnly: string[];
  /** 1–5, null when the model wasn't available. */
  fit: number | null;
  /** ≤ 8 words ("data profile, not frontend"), only used when fit ≤ 2. */
  fitNote: string;
  /** false: no internship / job in the job's field (null: unknown). */
  sameFieldInternship: boolean | null;
  /** Skills found in the projects / work part itself (for "… in your projects matched the role"). */
  shownSkills: string[];
  /** The core skills came from the job's tech stack alone (the model wasn't available). */
  fallback: boolean;
}

export interface ResumeReview {
  url: string;
  label: string;
  readable: boolean;
  /** It couldn't be downloaded (not the candidate's doing): "Resume not available for review" + a note. */
  unavailable?: boolean;
  /** Why it couldn't be read ("a photograph, not a resume", "couldn't be downloaded"). */
  problem: string | null;
  noLinks: boolean | null;
  genericBullets: boolean | null;
  spellingIssues: boolean | null;
  jobs: Map<string, JobReview>;
}

export type ReasonKey = "fits" | "core_missing" | "low_fit" | "experience" | "unreadable" | "no_resume" | "closed" | "no_show";

export const REASON_TEXT: Record<ReasonKey, string> = {
  fits: "Fits the job, but stronger candidates were chosen by the company",
  core_missing: "The job’s core skills not used in any project",
  low_fit: "Your profile matches other roles better",
  experience: "The job needed full-time work experience",
  unreadable: "Your resume file could not be read",
  no_resume: "Resume not available for review",
  closed: "The company closed the requirement",
  no_show: "Did not attend the round",
};

export type TagKey = "generic" | "must_missing" | "listed_only" | "low_fit" | "no_links" | "no_internship" | "spelling" | "low_score" | "unreadable";

export const TAG_TEXT: Record<TagKey, string> = {
  generic: "Generic project bullets",
  must_missing: "Must-have skills of the job not shown",
  listed_only: "Skills listed but not used in projects",
  low_fit: "Low fit for the role",
  no_links: "No GitHub or project links",
  no_internship: "No internship in the same field",
  spelling: "Spelling or format issues",
  low_score: "Lower resume match score for the role",
  unreadable: "Resume file could not be read",
};

/**
 * Everything one job's reasons are written from — an imported review (the November Academy review's
 * checked resume reads) or the server's own review of the resume.
 */
export interface JobFacts {
  source: "review" | "live";
  readable: boolean;
  problem: string | null;
  /** Set by an imported review's main reason; null = worked out from the core skills and fit. */
  reason: ReasonKey | null;
  core: { skill: string; shown: CoreShown }[];
  /** Listed skills of the job the resume doesn't show ("Linux, Kubernetes not shown"). */
  mustNotShown: string[];
  /** Skills of the job shown in projects (for "… in your projects matched the role"). */
  shownSkills: string[];
  fit: number | null;
  fitNote: string;
  /** What else the resume shows for this application (each counted once). */
  tags: TagKey[];
  /** The resume has no project for this job (imported reads say so). */
  noRelevantProject: boolean;
  fallback: boolean;
  /** The resume couldn't be downloaded (the reviewer gets a note; the candidate isn't blamed). */
  unavailable?: boolean;
}

/** The server's review of a resume for one job → facts. */
export function factsFromLive(rv: ResumeReview, jr: JobReview | undefined): JobFacts {
  const empty = { core: [], mustNotShown: [], shownSkills: [], fit: null, fitNote: "", noRelevantProject: false, fallback: false };
  if (rv.unavailable) return { source: "live", readable: false, problem: null, reason: "no_resume", tags: [], unavailable: true, ...empty };
  if (!rv.readable || !jr) return { source: "live", readable: rv.readable, problem: rv.problem, reason: null, tags: rv.readable ? [] : ["unreadable"], ...empty };
  const tags = new Set<TagKey>();
  if (rv.genericBullets) tags.add("generic");
  if (jr.mustNotShown.length || jr.core.some((c) => c.shown === "not_shown")) tags.add("must_missing");
  if (jr.listedOnly.length || jr.core.some((c) => c.shown === "listed_only")) tags.add("listed_only");
  if (jr.fit !== null && jr.fit <= 2) tags.add("low_fit");
  if (rv.noLinks) tags.add("no_links");
  if (jr.sameFieldInternship === false) tags.add("no_internship");
  if (rv.spellingIssues) tags.add("spelling");
  return {
    source: "live",
    readable: true,
    problem: null,
    reason: null,
    core: jr.core,
    mustNotShown: jr.mustNotShown,
    shownSkills: jr.shownSkills ?? [],
    fit: jr.fit,
    fitNote: jr.fitNote,
    tags: [...tags],
    noRelevantProject: false,
    fallback: jr.fallback,
  };
}

/** One job's row of an imported review (app.application_reviews), as the builder reads it. */
export interface ImportedReview {
  jobId: string;
  source: string;
  applied: boolean | null;
  sent: boolean | null;
  decision: "selected" | "rejected" | null;
  primaryReason: string;
  reasons: string[];
  details: string[];
  read: ReviewRead;
  /** Our screening sheet's verdict ("Not shortlisted / low band"). */
  screening: string;
  resumeUrl: string | null;
  checked: string;
  assignment: AssignmentFact | null;
}

export interface ReviewRead {
  readable?: boolean;
  must_have_met?: string[];
  must_have_missing?: string[];
  relevant_project?: boolean;
  course_projects_only?: boolean;
  relevant_internship?: boolean;
  coding_profile_or_github?: boolean;
  resume_quality_issues?: string[];
  fit_1to5?: number;
}

export interface AssignmentFact {
  /** Selected · Rejected · Awaiting result · Not submitted · On hold … (the review's bucket). */
  result: string;
  /** The main gap the reviewer found ("Core requirements missing"), "" when none. */
  gap: string;
}

/**
 * The review's must-haves as the document names skills: known technical skills only (a degree, a city,
 * "2+ years" or "communication" isn't one), each once — "RAG + LLM" → RAG, LLM; "Power BI / Tableau" →
 * "Power BI or Tableau".
 */
export function skillNames(xs: string[] | undefined): string[] {
  const out: string[] = [];
  for (const x of xs ?? []) {
    for (const s of jobSkills(String(x))) {
      if (s.checkable && s.label.length <= 30 && !out.some((o) => o.toLowerCase() === s.label.toLowerCase())) out.push(s.label);
    }
  }
  return out;
}

/**
 * An imported review → facts. The main reasons map onto the document's: "Meets the basics, others
 * were stronger" → fits; "JD skills not shown in projects or work" → core skills; a job rule (marks,
 * branch, college list, graduation year) is told by what the resume shows, as in the approved sample:
 * the must-have skills it lacks, else "fits".
 */
export function factsFromReview(r: ImportedReview): JobFacts {
  const read = r.read ?? {};
  const missing = skillNames(read.must_have_missing);
  const p = r.primaryReason;
  let reason: ReasonKey;
  if (/meets the basics/i.test(p)) reason = "fits";
  else if (/jd skills not shown/i.test(p)) reason = "core_missing";
  else if (/full-?time experience/i.test(p)) reason = "experience";
  else if (/unreadable|not a resume/i.test(p)) reason = "unreadable";
  else if (/resume link missing/i.test(p)) reason = "no_resume";
  // A job rule, or a reason the document has no words for: what the resume shows decides.
  else reason = missing.length ? "core_missing" : "fits";
  const q = (read.resume_quality_issues ?? []).map((x) => String(x).toLowerCase());
  const tags = new Set<TagKey>();
  const readable = read.readable !== false && reason !== "unreadable";
  if (!readable) tags.add("unreadable");
  else {
    if (q.some((x) => /generic|template|no project details/.test(x))) tags.add("generic");
    if (missing.length) tags.add("must_missing");
    if (q.some((x) => /not backed by projects/.test(x))) tags.add("listed_only");
    if (typeof read.fit_1to5 === "number" && read.fit_1to5 <= 2) tags.add("low_fit");
    if (q.some((x) => /no links/.test(x)) || read.coding_profile_or_github === false) tags.add("no_links");
    if (read.relevant_internship === false) tags.add("no_internship");
    if (q.some((x) => /spelling|format|unclear dates|very short/.test(x))) tags.add("spelling");
    if (/not shortlisted|low band/i.test(r.screening)) tags.add("low_score");
  }
  return {
    source: "review",
    readable,
    problem: readable ? null : "the file isn't a readable resume",
    reason,
    // The review's "not shown" means not shown in projects or work: "… not used in any project".
    core: reason === "core_missing" ? (missing.length ? missing : ["the job's core skills"]).map((s) => ({ skill: s, shown: "listed_only" as const })) : [],
    mustNotShown: reason === "core_missing" ? [] : missing,
    shownSkills: skillNames(read.must_have_met).slice(0, 3),
    fit: typeof read.fit_1to5 === "number" ? read.fit_1to5 : null,
    fitNote: "",
    tags: [...tags],
    noRelevantProject: read.relevant_project === false,
    fallback: false,
  };
}

/** How the candidates a company took forward compared, for one job (counts only). */
export interface Comparison {
  selected: number;
  withInternship: number;
  withLinks: number;
  withProject: number;
  allMustHaves: number;
  fitAvg: number | null;
}

/**
 * What most of the candidates the company took forward had and this resume didn't (at least 2 of
 * them, and 60% or more): a same-field internship, links to their work, a project for the job, every
 * must-have skill. Null when nothing stands out.
 */
export function comparisonGap(f: JobFacts, c: Comparison | undefined): string | null {
  if (!c || c.selected < 2) return null;
  const most = (n: number) => n * 10 >= c.selected * 6;
  if (f.tags.includes("no_internship") && most(c.withInternship)) return "most selected had a same-field internship";
  if (f.tags.includes("no_links") && most(c.withLinks)) return "most selected had GitHub or project links";
  if (f.noRelevantProject && most(c.withProject)) return "most selected had a project for this role";
  if (f.mustNotShown.length && most(c.allMustHaves)) return "most selected showed every must-have skill";
  return null;
}

// ── The document's content ──────────────────────────────────────────────────

export interface TextRun {
  text: string;
  bold?: boolean;
}

export interface ContentJob {
  key: string;
  company: string;
  role: string;
  outcome: JobOutcome;
  result: string;
  reason: string;
  reasonKey: ReasonKey | null;
  resumeLabel: string | null;
}

export interface FeedbackContent {
  version: 1;
  title: string;
  /** The Google Doc's name in Drive. */
  fileName: string;
  candidate: { uid: string; name: string };
  period: { from: string; to: string; label: string; short: string; line: string };
  asOf: string;
  counts: { jobs: number; applied: number; sharedOnly: number; selected: number; awaited: number; notMovedForward: number; notKnown: number };
  summary: TextRun[][];
  numbers: { headers: string[]; values: string[] };
  reasons: { key: ReasonKey; text: string; count: number; pct: number }[];
  tags: { key: TagKey; text: string; count: number }[];
  /** How many did-not-move-forward applications the tags are counted over. */
  tagBase: number;
  interviews: string[];
  assignments: string[];
  resumes: { label: string; url: string; jobs: number }[];
  jobs: ContentJob[];
  improve: { label: string; text: string }[];
  /** For the reviewer only (never in the document). */
  notes: string[];
  analysis: { resumes: number; reviewed: number; fallback: number; unreadable: number; imported: number; model: string | null };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const parts = (d: string) => ({ y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)) - 1, d: Number(d.slice(8, 10)) });
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** "3 Nov" */
export const shortDay = (d: string) => `${parts(d).d} ${SHORT[parts(d).m]}`;
/** "28 Nov 2026" */
export const longDay = (d: string) => `${parts(d).d} ${SHORT[parts(d).m]} ${parts(d).y}`;

/**
 * A period in words: whole months → "November 2026" / "October–November 2026" / "December 2026 –
 * January 2027"; any other range → "3 Nov – 20 Nov 2026" / "28 Dec 2026 – 4 Jan 2027". [short]
 * uses month abbreviations ("Nov 2026", "Oct–Nov 2026").
 */
export function periodLabel(from: string, to: string, short = false): { label: string; wholeMonths: boolean } {
  const a = parts(from);
  const b = parts(to);
  const M = short ? SHORT : MONTHS;
  const whole = a.d === 1 && b.d === lastDay(b.y, b.m);
  if (whole) {
    if (a.y === b.y && a.m === b.m) return { label: `${M[a.m]} ${a.y}`, wholeMonths: true };
    if (a.y === b.y) return { label: `${M[a.m]}–${M[b.m]} ${a.y}`, wholeMonths: true };
    return { label: `${M[a.m]} ${a.y} – ${M[b.m]} ${b.y}`, wholeMonths: true };
  }
  if (a.y === b.y) return { label: `${a.d} ${SHORT[a.m]} – ${b.d} ${SHORT[b.m]} ${a.y}`, wholeMonths: false };
  return { label: `${a.d} ${SHORT[a.m]} ${a.y} – ${b.d} ${SHORT[b.m]} ${b.y}`, wholeMonths: false };
}

/** Rounded percentages of [counts] that add up to 100 (largest remainder). */
export function percentages(counts: number[]): number[] {
  const total = counts.reduce((x, y) => x + y, 0);
  if (!total) return counts.map(() => 0);
  const raw = counts.map((c) => (c * 100) / total);
  const floor = raw.map(Math.floor);
  let left = 100 - floor.reduce((x, y) => x + y, 0);
  const order = raw.map((r, i) => ({ i, rem: r - Math.floor(r) })).sort((x, y) => y.rem - x.rem || counts[y.i] - counts[x.i]);
  for (const o of order) {
    if (left <= 0) break;
    floor[o.i]++;
    left--;
  }
  return floor;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const coRole = (j: Pick<FbJob, "company" | "role">) => `${j.company} (${j.role})`;
const listCoRoles = (js: Pick<FbJob, "company" | "role">[], max = 4) => {
  const names = js.map(coRole);
  return names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : andList(names);
};
const distinctCompanies = (js: Pick<FbJob, "company">[]) => [...new Set(js.map((j) => j.company))];

/** A resume link's short name: "…/1790754724426_Asha_K_Resume_Data_Analyst_ab12….pdf" → "Data Analyst". */
export function resumeLabel(url: string, candidateName: string, n: number): string {
  let file = "";
  try {
    file = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    file = "";
  }
  if (!file || /drive\.google\.com|docs\.google\.com/i.test(url)) return `Resume ${n}`;
  let s = file
    .replace(/\.(pdf|docx?|png|jpe?g)$/i, "")
    .replace(/^\d{10,}[_-]/, "")
    .replace(/[_-][0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  const tail = s.match(/\b(?:resume|cv)\b\s*(.*)$/i);
  if (tail) s = tail[1];
  const nameWords = new Set(keyText(candidateName).split(" ").filter((w) => w.length > 1));
  s = s
    .split(" ")
    .filter((w) => !nameWords.has(w.toLowerCase()) && !/^(resume|cv|final|updated|new|latest|copy)$/i.test(w))
    .join(" ")
    .replace(/\s+\d$/, "")
    // Copy numbers, however many: "ML trainee (1) (1)" → "ML trainee".
    .replace(/(?:\s*\(\d+\))+$/, "")
    .trim();
  // "Resume_2.pdf" leaves just "2": not a name.
  return s && s.length <= 40 && !/^\d+$/.test(s) ? s : `Resume ${n}`;
}

/**
 * Short names for the resumes, in the order given ("Data Analyst", "Resume 3"). The same file name
 * uploaded again (each application keeps its own copy) gets the same name: the document lists it once.
 */
export function resumeLabels(urls: string[], candidateName: string): Map<string, string> {
  return new Map(urls.map((u, i) => [u, resumeLabel(u, candidateName, i + 1)]));
}

/** The main reason a did-not-move-forward job stopped. */
export function reasonOf(job: FbJob, f: JobFacts | undefined): ReasonKey {
  if (job.outcome === "closed") return "closed";
  if (job.outcome === "no_show") return "no_show";
  if (!f) return job.resumeUrl ? "unreadable" : "no_resume";
  if (f.reason) return f.reason;
  if (!f.readable) return "unreadable";
  if (f.core.some((c) => c.shown === "not_shown" || c.shown === "listed_only")) return "core_missing";
  if (!f.core.length && f.fit !== null && f.fit <= 2) return "low_fit";
  return "fits";
}

/** The Reason column of "Result for Each Job". [comparison]: the job's selected candidates. */
export function reasonText(job: FbJob, key: ReasonKey | null, f: JobFacts | undefined, comparison?: Comparison, fitNote = ""): string {
  if (job.outcome === "selected") {
    const shown = f?.shownSkills ?? [];
    return shown.length ? `${andList(shown.slice(0, 3))} in your projects matched the role` : "–";
  }
  const note = f?.fitNote || fitNote;
  switch (key) {
    case "fits": {
      let extra: string | null = null;
      if (f?.mustNotShown.length) extra = `${andList(f.mustNotShown.slice(0, 3))} not shown`;
      else if (f && f.fit !== null && f.fit <= 2 && note) extra = note;
      else if (f) extra = comparisonGap(f, comparison) ?? (f.tags.includes("no_links") ? "no GitHub link" : null);
      return ["Stronger candidates chosen by company", ...(extra ? [extra] : [])].join("; ");
    }
    case "core_missing": {
      const listed = f?.core.filter((c) => c.shown === "listed_only").map((c) => c.skill) ?? [];
      const missing = f?.core.filter((c) => c.shown === "not_shown").map((c) => c.skill) ?? [];
      const bits: string[] = [];
      if (missing.length) bits.push(`${andList(missing)} not shown in your resume`);
      if (listed.length) bits.push(`${andList(listed)} not used in any project`);
      const text = bits.join("; ") || "Core skills of the role not used in any project";
      return text[0].toUpperCase() + text.slice(1);
    }
    case "low_fit":
      return note ? note[0].toUpperCase() + note.slice(1) : "Profile matches other roles better";
    case "experience":
      return "Full-time work experience was required";
    case "unreadable":
      return f?.problem ? `Resume couldn’t be read (${f.problem})` : "Resume couldn’t be read";
    case "no_resume":
      return "Resume not available for review";
    case "closed":
      return "Company closed the requirement";
    case "no_show":
      return "Did not attend";
    default:
      return "–";
  }
}

/** The Result column. */
export function resultText(job: FbJob): string {
  switch (job.outcome) {
    case "selected": {
      const last = job.items.at(-1);
      if (!last) {
        // The company sheet has no round results, but the imported review has the assignment's.
        const a = job.assignment ? assignmentText(job.assignment) : null;
        if (a) return `Selected by company; assignment ${a.replace(/ \(main gap: .*\)$/, "")}`;
        return job.flags.includes("closed_after_shortlist") ? "Selected by company; requirement closed later" : "Selected by company; next round awaited";
      }
      // "3 Nov" kept on one line in the table.
      const day = last.day ? ` (${shortDay(last.day).replace(" ", "\u00a0")})` : "";
      return `Selected by company; ${last.label}${day} ${last.result}`;
    }
    case "awaited":
      return job.flags.includes("on_hold") ? "On hold by company" : "Result awaited";
    case "not_forwarded":
      return "Not taken forward by company";
    case "not_shortlisted":
      return "Not selected";
    case "closed":
      return "Requirement closed by company";
    case "no_show":
      return "Did not attend";
    default:
      return "Result not known yet";
  }
}

const ORDER: JobOutcome[] = ["selected", "not_forwarded", "awaited", "not_shortlisted", "closed", "no_show", "not_known"];

function roundBullet(job: FbJob, items: RoundItem[]): string {
  const text = items
    .map((i) => {
      if (i.kind === "interview" && /^TR\d$|^Technical round$/.test(i.label)) return `${i.label} interview${i.day ? ` on ${shortDay(i.day)}` : ""} – ${i.result}`;
      return `${i.label}${i.day ? ` on ${shortDay(i.day)}` : ""} – ${i.result}`;
    })
    .join("; ");
  return `${job.company} – ${job.role}: ${text}.`;
}

/** An imported assignment result in words: "not cleared (core requirements missing)". */
function assignmentText(a: AssignmentFact): string | null {
  const r = a.result.toLowerCase();
  const gap = a.gap
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/\s*\(others were stronger\)\s*$/i, "")
    .trim();
  const g = gap && !/no clear gap/i.test(gap) ? ` (main gap: ${gap[0].toLowerCase()}${gap.slice(1)})` : "";
  if (/^selected/.test(r)) return "cleared";
  if (/^rejected/.test(r)) return `not cleared${g}`;
  if (/await/.test(r)) return "submitted, result awaited";
  if (/not submitted/.test(r)) return "not submitted";
  if (/hold/.test(r)) return "on hold";
  return null;
}

export interface BuildMeta {
  candidate: { uid: string; name: string };
  period: { from: string; to: string };
  today: string;
  /** What each job's reasons are written from (job key → facts). */
  facts: Map<string, JobFacts>;
  /** Per job id (lower case): how the selected candidates compared. */
  comparisons?: Map<string, Comparison>;
  /** Short names of the resume links ("Data Analyst"). */
  resumeLabels?: Map<string, string>;
  model: string | null;
  applicationsReadAt: Date | null;
  /** Shares were never synced, or the internal sheets were never read. */
  sourcesMissing: string[];
}

/** The document's content from the period's jobs and the facts behind each job's reasons. */
export function buildContent(jobs: FbJob[], meta: BuildMeta): FeedbackContent {
  const sorted = [...jobs].sort((a, b) => ORDER.indexOf(a.outcome) - ORDER.indexOf(b.outcome) || a.company.localeCompare(b.company) || a.role.localeCompare(b.role));
  const factsOf = (j: FbJob) => meta.facts.get(j.key);
  const comparisonOf = (j: FbJob) => (j.jobId ? meta.comparisons?.get(j.jobId.trim().toLowerCase()) : undefined);
  const selected = sorted.filter((j) => j.outcome === "selected");
  const awaited = sorted.filter((j) => j.outcome === "awaited");
  const moved = sorted.filter((j) => DID_NOT_MOVE.includes(j.outcome));
  const notKnown = sorted.filter((j) => j.outcome === "not_known");
  const sharedOnly = sorted.filter((j) => !j.applied);
  const name = meta.candidate.name.trim() || "Candidate";
  const pl = periodLabel(meta.period.from, meta.period.to);
  const plShort = periodLabel(meta.period.from, meta.period.to, true);

  // The candidate's own area (where the resume fits best), for "data profile, not frontend".
  const famCount = new Map<string, number>();
  for (const j of sorted) {
    const f = factsOf(j);
    if (j.outcome === "selected" || (f?.fit ?? 0) >= 4) {
      const fam = roleFamily(j.role);
      if (fam) famCount.set(fam, (famCount.get(fam) ?? 0) + 1);
    }
  }
  const profile = [...famCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const fitNoteOf = (j: FbJob) => {
    const fam = roleFamily(j.role);
    return profile && fam && fam !== profile ? `${profile.replace(/ development$/, "")} profile, not ${fam.replace(/ development$/, "")}` : "";
  };

  // Reasons for the ones that didn't move forward.
  const reasonKeys = new Map<string, ReasonKey>();
  for (const j of moved) reasonKeys.set(j.key, reasonOf(j, factsOf(j)));
  const reasonCounts = new Map<ReasonKey, number>();
  for (const k of reasonKeys.values()) reasonCounts.set(k, (reasonCounts.get(k) ?? 0) + 1);
  const reasonList = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1] || Object.keys(REASON_TEXT).indexOf(a[0]) - Object.keys(REASON_TEXT).indexOf(b[0]));
  const pcts = percentages(reasonList.map(([, n]) => n));
  const reasons = reasonList.map(([key, count], i) => ({ key, text: REASON_TEXT[key], count, pct: pcts[i] }));

  // What else the resumes of those applications show (each tag once per application).
  const tagged = moved.filter((j) => (j.outcome === "not_forwarded" || j.outcome === "not_shortlisted") && factsOf(j));
  const tagCounts = new Map<TagKey, number>();
  for (const j of tagged) for (const t of new Set(factsOf(j)!.tags)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const tags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || Object.keys(TAG_TEXT).indexOf(a[0]) - Object.keys(TAG_TEXT).indexOf(b[0]))
    .map(([key, count]) => ({ key, text: TAG_TEXT[key], count }));

  // Interviews, tests and assignments.
  const interviews: string[] = [];
  const assignments: string[] = [];
  for (const j of sorted) {
    if (j.outcome === "no_show") interviews.push(`${j.company} – ${j.role}: did not attend.`);
    const iv = j.items.filter((i) => i.kind !== "assignment");
    const asg = j.items.filter((i) => i.kind === "assignment");
    if (iv.length) interviews.push(roundBullet(j, iv));
    if (asg.length) assignments.push(roundBullet(j, asg));
    else if (j.assignment) {
      const t = assignmentText(j.assignment);
      if (t) assignments.push(`${j.company} – ${j.role}: assignment – ${t}.`);
    }
  }

  // Resumes used (one per link; job counts over the period's jobs).
  // One per name: the same file uploaded again for another application is the same resume (the newest
  // upload is linked). Job counts are over the period's jobs.
  const urlsUsed = [...new Set(sorted.map((j) => j.resumeUrl).filter((u): u is string => Boolean(u)))];
  const labelOf = new Map(urlsUsed.map((u, i) => [u, meta.resumeLabels?.get(u) ?? resumeLabel(u, name, i + 1)]));
  const byName = new Map<string, { url: string; label: string; jobs: number; at: number }>();
  for (const j of sorted) {
    if (!j.resumeUrl) continue;
    const label = labelOf.get(j.resumeUrl)!;
    const at = (j.appliedAt ?? j.firstSeen)?.getTime() ?? 0;
    const g = byName.get(label.toLowerCase());
    if (!g) byName.set(label.toLowerCase(), { url: j.resumeUrl, label, jobs: 1, at });
    else {
      g.jobs++;
      if (at > g.at) Object.assign(g, { url: j.resumeUrl, at });
    }
  }
  // A resume without a usable file name is "Resume <its place in the list>".
  const renamed = new Map<string, string>();
  const resumes = [...byName.values()].map(({ url, label, jobs }, i) => {
    const l = /^Resume \d+$/.test(label) ? `Resume ${i + 1}` : label;
    renamed.set(label, l);
    return { url, label: l, jobs };
  });
  for (const [u, l] of labelOf) labelOf.set(u, renamed.get(l) ?? l);

  const contentJobs: ContentJob[] = sorted.map((j) => {
    const key = reasonKeys.get(j.key) ?? null;
    return {
      key: j.key,
      company: j.company,
      role: j.role,
      outcome: j.outcome,
      result: resultText(j),
      reason: j.outcome === "awaited" || j.outcome === "not_known" ? "–" : reasonText(j, key, factsOf(j), comparisonOf(j), fitNoteOf(j)),
      reasonKey: key,
      resumeLabel: j.resumeUrl ? labelOf.get(j.resumeUrl) ?? null : null,
    };
  });

  // Summary.
  const summary: TextRun[][] = [];
  const jobsN = sorted.length;
  if (sharedOnly.length) {
    summary.push([
      { text: "Your profile was considered for " },
      { text: `${jobsN} ${plural(jobsN, "job", "jobs")}`, bold: true },
      { text: ` (${jobsN - sharedOnly.length} you applied to, ${sharedOnly.length} shared by the placement team).` },
    ]);
  } else {
    summary.push([{ text: "You applied to " }, { text: `${jobsN} ${plural(jobsN, "job", "jobs")}`, bold: true }, { text: "." }]);
  }
  if (selected.length) {
    const cos = distinctCompanies(selected);
    const lead = cos.length === selected.length ? `${cos.length} ${plural(cos.length, "company", "companies")} selected your resume` : `Your resume was selected for ${selected.length} jobs`;
    summary.push([{ text: lead, bold: true }, { text: `: ${listCoRoles(selected)}.` }]);
  }
  if (awaited.length) {
    summary.push([{ text: `${awaited.length} ${plural(awaited.length, "result is", "results are")} awaited`, bold: true }, { text: `: ${listCoRoles(awaited)}.` }]);
  }
  if (moved.length) {
    const reviewedBy = distinctCompanies(moved.filter((j) => j.outcome === "not_forwarded"));
    summary.push([
      { text: `${moved.length} ${plural(moved.length, "application", "applications")} did not move forward`, bold: true },
      { text: reviewedBy.length ? `, including ${andList(reviewedBy.slice(0, 3))}${reviewedBy.length > 3 ? " and others" : ""}.` : "." },
    ]);
    const main = reasons[0];
    if (main) {
      const lower = main.text[0].toLowerCase() + main.text.slice(1);
      const phrase = main.key === "fits" ? "you fit the job, but stronger candidates were chosen by the company" : lower;
      summary.push([{ text: "Main reason: " }, { text: phrase, bold: true }, { text: ` (${main.count} of ${moved.length}, ${main.pct}%).` }]);
    }
  }
  if (notKnown.length) {
    summary.push([{ text: `${notKnown.length} ${plural(notKnown.length, "result is", "results are")} not known yet`, bold: true }, { text: `: ${listCoRoles(notKnown)}.` }]);
  }

  // Your Numbers.
  const headers = [sharedOnly.length ? "Jobs" : "Applied", "Selected by company", "Result awaited", "Did not move forward"];
  const values = [String(jobsN), String(selected.length), String(awaited.length), String(moved.length)];
  if (notKnown.length) {
    headers.push("Result not known");
    values.push(String(notKnown.length));
  }

  const improve = improvements(sorted, reasonKeys, tagCounts, meta.facts);

  // Notes for the reviewer.
  const notes: string[] = [];
  const imported = sorted.filter((j) => factsOf(j)?.source === "review" || j.flags.includes("review")).length;
  if (imported) notes.push(`${imported} ${plural(imported, "job's", "jobs'")} decisions and reasons come from the November Academy review (checked resume reads).`);
  for (const j of sorted) {
    const n = `${j.company} – ${j.role}`;
    if (j.flags.includes("unverified")) notes.push(`${n}: the company sheet can't be read (or isn't linked in the CRPs master), so the result shows "awaited". Check it.`);
    if (j.outcome === "not_known") notes.push(`${n}: the result is "not known" (no readable company sheet, or its rows don't say which role). Check it before sending; if it's wrong, fix the source and rebuild.`);
    if (factsOf(j)?.unavailable) notes.push(`${n}: the resume couldn't be downloaded, so it wasn't reviewed ("Resume not available for review"). Rebuild later.`);
    if (j.flags.includes("still_open")) notes.push(`${n}: still open; the candidate wasn't among the profiles sent so far ("not selected"). Check before sending.`);
    if (j.flags.includes("ambiguous")) notes.push(`${n}: the company sheet's tabs don't say which role each list is for, so this result couldn't be told. Check it.`);
    if (DID_NOT_MOVE.includes(j.outcome) && !j.resumeUrl) notes.push(`${n}: no resume on record for this application.`);
    if (!j.period && !j.idDone) notes.push(`${n}: the CRPs master has no CRP month for it; it was placed in the period by its ${j.appliedAt ? "application" : "share"} date.`);
  }
  for (const r of resumes) {
    // (One that couldn't be downloaded has its own note above: it isn't the file's fault.)
    const f = sorted.map(factsOf).find((x, i) => x && sorted[i].resumeUrl === r.url && !x.readable && !x.unavailable);
    if (f) notes.push(`Resume "${r.label}" couldn't be read${f.problem ? ` (${f.problem})` : ""}.`);
  }
  const fallback = sorted.filter((j) => factsOf(j)?.fallback).length;
  if (fallback) notes.push(`${fallback} ${plural(fallback, "job was", "jobs were")} checked against the job's tech stack only (the review model wasn't available): read those reasons carefully.`);
  for (const s of meta.sourcesMissing) notes.push(s);
  if (!meta.applicationsReadAt) notes.push("The internal sheets (applications) haven't been read yet: only the profiles shared with companies are counted.");

  const facts = sorted.map(factsOf).filter((x): x is JobFacts => Boolean(x));
  return {
    version: 1,
    title: `Resume Rejection Analysis – ${name}`,
    fileName: `Resume Rejection Analysis – ${name} – ${plShort.label}`.slice(0, 200),
    candidate: { uid: meta.candidate.uid, name },
    period: {
      from: meta.period.from,
      to: meta.period.to,
      label: pl.label,
      short: plShort.label,
      line: `${pl.wholeMonths ? `All ${pl.label} applications` : `Applications for jobs from ${pl.label}`} · as of ${longDay(meta.today)}`,
    },
    asOf: meta.today,
    counts: { jobs: jobsN, applied: jobsN - sharedOnly.length, sharedOnly: sharedOnly.length, selected: selected.length, awaited: awaited.length, notMovedForward: moved.length, notKnown: notKnown.length },
    summary,
    numbers: { headers, values },
    reasons,
    tags,
    tagBase: tagged.length,
    interviews,
    assignments,
    resumes,
    jobs: contentJobs,
    improve,
    notes: notes.slice(0, 40),
    analysis: {
      resumes: resumes.length,
      reviewed: facts.filter((f) => f.readable).length,
      fallback,
      unreadable: facts.filter((f) => !f.readable && !f.unavailable).length,
      imported,
      model: meta.model,
    },
  };
}

/** "What to Improve": from what the reasons and the resumes show, most useful first (at most 6). */
function improvements(jobs: FbJob[], reasonKeys: Map<string, ReasonKey>, tags: Map<TagKey, number>, facts: Map<string, JobFacts>): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  const count = (k: ReasonKey) => [...reasonKeys.values()].filter((x) => x === k).length;
  if (count("fits") > 0) {
    out.push({ label: "Stronger projects", text: "Your projects are okay, but you need to work on some stronger projects, or implement more features in your current projects, to stand out against other candidates." });
  }
  // The skills the jobs asked for that the resumes didn't show in a project, most frequent first.
  const gaps = new Map<string, number>();
  for (const j of jobs) {
    if (!reasonKeys.has(j.key)) continue;
    const f = facts.get(j.key);
    for (const c of f?.core ?? []) if ((c.shown === "listed_only" || c.shown === "not_shown") && !/core skills/.test(c.skill)) gaps.set(c.skill, (gaps.get(c.skill) ?? 0) + 1);
    for (const s of f?.mustNotShown ?? []) gaps.set(s, (gaps.get(s) ?? 0) + 1);
  }
  const topGaps = [...gaps.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s).slice(0, 3);
  if (count("core_missing") > 0 || (tags.get("listed_only") ?? 0) > 0 || (tags.get("must_missing") ?? 0) > 0) {
    out.push({
      label: "Tailor to each job",
      text: `Show each job’s key skills inside your projects, not only in skills${topGaps.length ? ` (for example ${andList(topGaps)})` : ""}.`,
    });
  }
  if ((tags.get("generic") ?? 0) > 0) out.push({ label: "Clear project points", text: "What you built, tools used and the result, with numbers." });
  if ((tags.get("no_links") ?? 0) > 0) out.push({ label: "Links", text: "Add your GitHub link and project links on every resume." });
  if ((tags.get("spelling") ?? 0) > 0 || (tags.get("unreadable") ?? 0) > 0 || (tags.get("must_missing") ?? 0) > 0 || (tags.get("low_score") ?? 0) > 0) {
    out.push({
      label: "ATS-friendly resume",
      text: `Keep a simple single-column layout, standard section headings, no images or icons, and use keywords from the job description${(tags.get("unreadable") ?? 0) > 0 ? "; upload it as a text PDF, not a photo or a scan" : ""}.`,
    });
  }
  if (count("experience") > 0) out.push({ label: "Experience", text: "Some jobs asked for full-time work experience: an internship or a real project in the same field helps you meet that bar." });
  // Where the resume matched best: the role areas of jobs it was selected for or fit.
  const families = new Map<string, number>();
  for (const j of jobs) {
    if (j.outcome === "selected" || reasonKeys.get(j.key) === "fits") {
      const fam = roleFamily(j.role);
      if (fam) families.set(fam, (families.get(fam) ?? 0) + 1);
    }
  }
  const best = [...families.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f).slice(0, 3);
  const interviewMiss = jobs.filter((j) => j.items.some((i) => i.kind === "interview" && i.status === "rejected")).length;
  if (best.length) {
    // "or" with a comma before it: the areas' own names have "and" in them ("QA and testing").
    const areas = best.length <= 2 ? best.join(" or ") : `${best.slice(0, -1).join(", ")}, or ${best[best.length - 1]}`;
    out.push({ label: "Right roles", text: `Apply for roles in ${areas}, where your resume matched best${interviewMiss ? "; practise technical interviews" : ""}.` });
  } else if (interviewMiss) {
    out.push({ label: "Interviews", text: `You reached the interview stage ${interviewMiss} ${plural(interviewMiss, "time", "times")}: practise technical interviews to convert these chances.` });
  }
  if (jobs.some((j) => j.outcome === "no_show" || j.items.some((i) => i.status === "no_show"))) {
    out.push({ label: "Attend every round", text: "Attend every scheduled round, or tell the placement team early if you can’t." });
  }
  if (count("low_fit") > 0 && !best.length) out.push({ label: "Right roles", text: "Apply for roles that match your projects and skills." });
  if (out.length < 2) {
    out.push({ label: "Keep your resume current", text: "Add your latest projects, with what you built, the tools used and the result." });
    if (out.length < 2) out.push({ label: "Interview practice", text: "Practise technical interviews for the rounds ahead." });
  }
  return out.slice(0, 6);
}

/**
 * The document's numbers must agree with each other before it is written (a wrong count is worse
 * than no document). Returns the problems found ([] = consistent).
 */
export function checkContent(c: FeedbackContent): string[] {
  const p: string[] = [];
  const k = c.counts;
  if (k.jobs !== c.jobs.length) p.push(`jobs ${k.jobs} ≠ rows ${c.jobs.length}`);
  if (k.selected + k.awaited + k.notMovedForward + k.notKnown !== k.jobs) p.push("outcome counts don't add up to the jobs");
  if (k.applied + k.sharedOnly !== k.jobs) p.push("applied + shared-only ≠ jobs");
  const rsum = c.reasons.reduce((n, r) => n + r.count, 0);
  if (rsum !== k.notMovedForward) p.push(`reasons ${rsum} ≠ did not move forward ${k.notMovedForward}`);
  if (c.reasons.length && c.reasons.reduce((n, r) => n + r.pct, 0) !== 100) p.push("reason percentages don't add up to 100");
  for (const t of c.tags) if (t.count > c.tagBase) p.push(`tag "${t.text}" ${t.count} > ${c.tagBase}`);
  const withResume = c.jobs.filter((j) => j.resumeLabel !== null).length;
  if (c.resumes.reduce((n, r) => n + r.jobs, 0) !== withResume) p.push("resume job counts ≠ jobs with a resume");
  const byOutcome = (o: JobOutcome[]) => c.jobs.filter((j) => o.includes(j.outcome)).length;
  if (byOutcome(["selected"]) !== k.selected || byOutcome(["awaited"]) !== k.awaited || byOutcome(DID_NOT_MOVE) !== k.notMovedForward) p.push("rows' outcomes ≠ counts");
  if (c.numbers.values[0] !== String(k.jobs)) p.push("numbers table ≠ counts");
  for (const j of c.jobs) if (!j.company.trim() || !j.role.trim()) p.push("a row without company or role");
  return p;
}
