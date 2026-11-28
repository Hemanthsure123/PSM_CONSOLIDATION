import "server-only";
import { query } from "@/lib/db/client";
import { UserError } from "@/lib/mobile/http";
import { lastApplicationsRead } from "@/lib/mobile/pool/applications-sync";
import { loadRequirements } from "@/lib/mobile/pool/requirements-store";
import { feedbackSchemaReady } from "@/lib/mobile/pool/schema";
import { poolCandidateAccess, type PoolCandidateAccess } from "@/lib/mobile/pool/service";
import { ownStatusOf, roundsOf } from "@/lib/mobile/pool/shares";
import { lastSharesSync } from "@/lib/mobile/pool/shares-store";
import { addDays, dayOf, isDay, normRound } from "@/lib/mobile/preps/parse";
import { readPrepSnapshot } from "@/lib/mobile/preps/sheet";
import { pushToUser } from "@/lib/mobile/push";
import { listRoster, type RosterUser } from "@/lib/mobile/roster";
import {
  assembleJobs,
  buildContent,
  checkContent,
  type Comparison,
  factsFromLive,
  factsFromReview,
  type FbApplication,
  type FbInterview,
  type FbJob,
  type FbRequirement,
  type FbShare,
  type FbSheet,
  type ImportedReview,
  type JobFacts,
  jobsInPeriod,
  periodLabel,
  REASON_TEXT,
  reasonOf,
  resumeLabels,
} from "@/lib/feedback-docs/model";
import { DOC_COLS, type DocRow, docById, docsOf, type FeedbackDocDto, firstName, namesOf, toDto } from "@/lib/feedback-docs/docs";
import { renderFeedbackDocx } from "@/lib/feedback-docs/render";
import { type JobToReview, reviewResumes } from "@/lib/feedback-docs/review";
import { createGoogleDocFromDocx, exportPdf, replaceGoogleDocFromDocx, shareEditWith, subFolder } from "@/lib/team/drive";
import { teamStatus } from "@/lib/team/google";

/**
 * Candidate feedback documents (PSM 1.13.0): for an assigned Academy assessed candidate and a period,
 * a "Resume Rejection Analysis" Google Doc built from their applications, the profiles the team
 * shared, every company result, the drill-down interview dates and a checked review of each resume
 * (model.ts / review.ts). One document per candidate and period: a rebuild rewrites the same Google
 * Doc (same link) and sets it back to draft. The doc lives in the team Drive ("Candidate feedback
 * documents"), shared for editing only with the person who built it and the candidate's mentor — never
 * by link. It goes to the candidate as a PDF (the reviewed Google Doc, exported at send time), only
 * after someone marked it reviewed. The database keeps the document's facts (content) for the app's
 * counts and the reviewer's notes, and the review / send trail.
 */

const STALE_MS = 15 * 60_000;
const MAX_DAYS = 366;
const AHEAD_DAYS = 31;

export interface FeedbackRunDto {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  step: string;
  error: string | null;
  mode: "create" | "update";
  periodFrom: string;
  periodTo: string;
  result: { documentId: string; url: string; version: number; warnings: string[] } | null;
  createdAt: string;
}

async function requireSchema(): Promise<void> {
  if (!(await feedbackSchemaReady().catch(() => false))) {
    throw new UserError(503, "Feedback documents aren't set up on the server yet (migration 023).", "not_ready");
  }
}

const today = () => dayOf(Date.now());

/** Whole months for the presets: this month, last month, the last 2 and 3 months (IST). */
export function presets(day: string): { key: string; label: string; from: string; to: string }[] {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7)) - 1;
  const first = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 1)).toISOString().slice(0, 10);
  const last = (yy: number, mm: number) => new Date(Date.UTC(yy, mm + 1, 0)).toISOString().slice(0, 10);
  const month = (back: number) => {
    const d = new Date(Date.UTC(y, m - back, 1));
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
  };
  const out = [
    { key: "this_month", a: month(0), b: month(0) },
    { key: "last_month", a: month(1), b: month(1) },
    { key: "last_2_months", a: month(1), b: month(0) },
    { key: "last_3_months", a: month(2), b: month(0) },
  ];
  return out.map((p) => {
    const from = first(p.a.y, p.a.m);
    const to = last(p.b.y, p.b.m);
    return { key: p.key, label: periodLabel(from, to, true).label, from, to };
  });
}

/** A period the app may ask for: real days, from ≤ to, at most 366 days, not more than 31 days ahead. */
const realDay = (v: unknown): v is string => isDay(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export function validPeriod(from: unknown, to: unknown, day = today()): { from: string; to: string } {
  if (!realDay(from) || !realDay(to)) throw new UserError(422, "Pick a start and an end date.", "invalid_period");
  if (from > to) throw new UserError(422, "The start date is after the end date.", "invalid_period");
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 > MAX_DAYS - 1) throw new UserError(422, "Pick at most one year.", "invalid_period");
  if (to > addDays(day, AHEAD_DAYS)) throw new UserError(422, "The period can't end more than a month from today.", "invalid_period");
  if (from < "2025-01-01") throw new UserError(422, "Pick a period from 2025 onwards.", "invalid_period");
  return { from, to };
}

// ── Inputs ──────────────────────────────────────────────────────────────────

interface Inputs {
  candidate: PoolCandidateAccess;
  requirements: FbRequirement[];
  applications: FbApplication[];
  shares: FbShare[];
  sheets: Map<string, FbSheet>;
  interviews: FbInterview[];
  /** Imported reviews of the candidate's applications (not the server's own). */
  reviews: ImportedReview[];
  sources: string[];
  applicationsReadAt: Date | null;
}

interface ReviewRow {
  job_id: string;
  source: string;
  applied: boolean | null;
  sent: boolean | null;
  decision: "selected" | "rejected" | null;
  primary_reason: string;
  reasons: string[];
  details: string[];
  read: ImportedReview["read"];
  screening: string;
  resume_url: string | null;
  checked: string;
  assignment: ImportedReview["assignment"];
}

async function loadInputs(candidate: PoolCandidateAccess): Promise<Inputs> {
  const [reqs, apps, shareRows, deals, appsAt, sharesAt, reviewRows] = await Promise.all([
    loadRequirements(),
    query<{ job_id: string; applied_at: Date | null; resume_url: string | null; source: "portal" | "form" }>(
      "select job_id, applied_at, resume_url, source from app.job_applications where uid = $1 and removed_at is null",
      [candidate.uid],
    ),
    query<{ id: string; sheet_id: string; tab: string; role: string; company: string; rounds: unknown; final_status: string; status: string | null; outcome: string; first_seen_at: Date; resume_url: string | null }>(
      `select id::text as id, sheet_id, tab, role, company, rounds, final_status, status, outcome, first_seen_at, resume_url
         from app.company_shares where uid = $1 and removed_at is null`,
      [candidate.uid],
    ),
    query<{ deal_id: string; jd_url: string | null }>("select deal_id, jd_url from app.hubspot_deals where jd_url is not null"),
    lastApplicationsRead(),
    lastSharesSync(),
    // The newest imported review per job (a later review replaces an earlier one).
    query<ReviewRow>(
      `select distinct on (job_id) job_id, source, applied, sent, decision, primary_reason, reasons, details, read, screening, resume_url, checked, assignment
         from app.application_reviews where uid = $1 and source <> 'live' order by job_id, updated_at desc`,
      [candidate.uid],
    ),
  ]);
  const dealJd = new Map(deals.map((d) => [d.deal_id, d.jd_url]));
  const requirements: FbRequirement[] = reqs.map((r) => ({
    key: r.key,
    sheetId: r.sheetId,
    company: r.company,
    role: r.role,
    jobId: r.jobId,
    crpMonth: r.crpMonth,
    crpYear: r.crpYear,
    crpWeek: r.crpWeek,
    finalStatus: r.finalStatus,
    stage: r.stage,
    idStatus: r.idStatus,
    academySent: r.academySent,
    assessedSent: r.assessedSent,
    nonAssessedSent: r.nonAssessedSent,
    techStack: r.techStack,
    jdUrl: r.jdUrl ?? (r.hubspotDealId ? dealJd.get(r.hubspotDealId) ?? null : null),
    idMonth: r.idMonth ?? "",
    idYear: r.idYear ?? null,
  }));
  const shares: FbShare[] = shareRows.map((s) => ({
    id: s.id,
    sheetId: s.sheet_id,
    tab: s.tab,
    role: s.role,
    company: s.company,
    rounds: roundsOf(s.rounds),
    finalStatus: s.final_status,
    own: ownStatusOf(s).status,
    firstSeen: s.first_seen_at,
    resumeUrl: s.resume_url,
  }));
  // The company sheets of the candidate's jobs: readable, and the Academy profiles sent per tab.
  const jobIds = new Set([...apps.map((a) => a.job_id), ...reviewRows.map((r) => r.job_id.toLowerCase())]);
  const sheetIds = [...new Set([...shares.map((s) => s.sheetId), ...requirements.filter((r) => r.sheetId && jobIds.has(r.jobId.trim().toLowerCase())).map((r) => r.sheetId!)])];
  const sheets = new Map<string, FbSheet>();
  if (sheetIds.length) {
    const [state, tabs] = await Promise.all([
      query<{ sheet_id: string; last_read_at: Date | null; read_error: string | null }>("select sheet_id, last_read_at, read_error from app.company_sheets where sheet_id = any($1::text[])", [sheetIds]),
      query<{ sheet_id: string; tab: string; n: number }>(
        "select sheet_id, tab, count(*)::int as n from app.company_shares where sheet_id = any($1::text[]) and removed_at is null group by sheet_id, tab",
        [sheetIds],
      ),
    ]);
    for (const s of state) sheets.set(s.sheet_id, { readable: Boolean(s.last_read_at) && !s.read_error, tabs: new Map() });
    for (const t of tabs) sheets.get(t.sheet_id)?.tabs.set(t.tab, t.n);
  }
  let interviews: FbInterview[] = [];
  const sources: string[] = [];
  if (candidate.phone) {
    try {
      const snap = await readPrepSnapshot();
      interviews = snap.preps
        .filter((p) => p.phone === candidate.phone)
        .map((p) => ({ jobId: p.jobId, company: p.company, round: normRound(p.round), day: p.interviewDay, cancelled: p.interviewState === "cancelled" || p.interviewState === "rescheduled" }));
    } catch {
      sources.push("The drill-down tab couldn't be read: interview dates are missing.");
    }
  }
  if (!sharesAt) sources.push("The company sheets haven't been synced yet: results are missing.");
  return {
    candidate,
    requirements,
    applications: apps.map((a) => ({ jobId: a.job_id, appliedAt: a.applied_at, resumeUrl: a.resume_url, source: a.source })),
    shares,
    sheets,
    interviews,
    reviews: reviewRows.map((r) => ({
      jobId: r.job_id,
      source: r.source,
      applied: r.applied,
      sent: r.sent,
      decision: r.decision,
      primaryReason: r.primary_reason,
      reasons: r.reasons ?? [],
      details: r.details ?? [],
      read: r.read ?? {},
      screening: r.screening,
      resumeUrl: r.resume_url,
      checked: r.checked,
      assignment: r.assignment,
    })),
    sources,
    applicationsReadAt: appsAt,
  };
}

/** How the selected candidates compared, for the jobs of the document (newest source per job). */
async function comparisonsFor(jobIds: string[]): Promise<Map<string, Comparison>> {
  const ids = [...new Set(jobIds.map((j) => j.trim().toLowerCase()).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await query<{ job_id: string; selected: number; with_internship: number; with_links: number; with_project: number; all_must_haves: number; fit_avg: string | null }>(
    `select distinct on (job_id) job_id, selected, with_internship, with_links, with_project, all_must_haves, fit_avg
       from app.job_comparisons where job_id = any($1::text[]) order by job_id, computed_at desc`,
    [ids],
  ).catch(() => []);
  return new Map(
    rows.map((r) => [
      r.job_id,
      { selected: r.selected, withInternship: r.with_internship, withLinks: r.with_links, withProject: r.with_project, allMustHaves: r.all_must_haves, fitAvg: r.fit_avg === null ? null : Number(r.fit_avg) },
    ]),
  );
}

const jobsOf = (inp: Inputs, period: { from: string; to: string }) =>
  jobsInPeriod(
    assembleJobs({
      candidate: { uid: inp.candidate.uid, name: inp.candidate.name },
      requirements: inp.requirements,
      applications: inp.applications,
      shares: inp.shares,
      sheets: inp.sheets,
      interviews: inp.interviews,
      reviews: inp.reviews,
      today: today(),
    }),
    period,
  );

// ── Reading ─────────────────────────────────────────────────────────────────

function blockedReason(c: PoolCandidateAccess, team: { connected: boolean; account: string }): string | null {
  if (!c.assigned) return "This candidate has no mentor yet. Feedback documents are for assigned candidates: assign a mentor in the Academy sheet first.";
  if (!c.canEdit) return c.notYours ?? "Only the assigned mentor, leads and admins can create feedback documents.";
  if (!team.connected) return `Connect the team Google account (${team.account || "not set"}) first: an admin can do it in Me → Team.`;
  return null;
}

export async function feedbackOverview(user: RosterUser, uid: string) {
  await requireSchema();
  const roster = await listRoster();
  const c = await poolCandidateAccess(user, uid, roster);
  const [docs, run, team, appsAt] = await Promise.all([docsOf(uid), latestRun(uid), teamStatus().catch(() => null), lastApplicationsRead()]);
  const google = team ? { connected: team.connected, account: team.account, status: team.status } : { connected: false, account: "", status: "not_configured" };
  const blocked = blockedReason(c, google);
  const names = namesOf(roster);
  return {
    uid: c.uid,
    candidate: c.name,
    /** 10 digits (the WhatsApp chat to open), null when the pool has none. */
    phone: c.phone,
    mentor: c.mentor?.name ?? (c.mentorName || null),
    assigned: c.assigned,
    canGenerate: blocked === null,
    blockedReason: blocked,
    google,
    applicationsSyncedAt: appsAt?.toISOString() ?? null,
    presets: presets(today()),
    documents: docs.map((r) => toDto(r, names, user, c.canEdit && c.assigned)),
    run,
  };
}

export async function getFeedbackDoc(user: RosterUser, id: string): Promise<FeedbackDocDto> {
  await requireSchema();
  const r = await docById(id);
  if (!r) throw new UserError(404, "This feedback document doesn't exist.", "not_found");
  const roster = await listRoster();
  const c = await poolCandidateAccess(user, r.uid, roster);
  return toDto(r, namesOf(roster), user, c.canEdit && c.assigned);
}

// ── Runs ────────────────────────────────────────────────────────────────────

interface RunRow {
  id: string;
  status: FeedbackRunDto["status"];
  step: string;
  error: string | null;
  mode: FeedbackRunDto["mode"];
  period_from: string;
  period_to: string;
  result: FeedbackRunDto["result"];
  created_at: Date;
  updated_at: Date;
}

const RUN_COLS = "id, status, step, error, mode, to_char(period_from, 'YYYY-MM-DD') as period_from, to_char(period_to, 'YYYY-MM-DD') as period_to, result, created_at, updated_at";

export async function getFeedbackRun(id: string): Promise<FeedbackRunDto | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  await requireSchema();
  const r = (await query<RunRow>(`select ${RUN_COLS} from app.candidate_feedback_runs where id = $1`, [id]))[0];
  if (!r) return null;
  if ((r.status === "running" || r.status === "queued") && Date.now() - r.updated_at.getTime() > STALE_MS) {
    const error = "The server restarted while building the document. Start it again.";
    await query("update app.candidate_feedback_runs set status = 'failed', error = $2, updated_at = now() where id = $1 and status in ('queued', 'running')", [id, error]);
    return { id, status: "failed", step: r.step, error, mode: r.mode, periodFrom: r.period_from, periodTo: r.period_to, result: null, createdAt: r.created_at.toISOString() };
  }
  return { id: r.id, status: r.status, step: r.step, error: r.error, mode: r.mode, periodFrom: r.period_from, periodTo: r.period_to, result: r.result, createdAt: r.created_at.toISOString() };
}

async function latestRun(uid: string): Promise<FeedbackRunDto | null> {
  const rows = await query<{ id: string }>("select id from app.candidate_feedback_runs where uid = $1 and created_at > now() - interval '1 day' order by created_at desc limit 1", [uid]);
  return rows[0] ? getFeedbackRun(rows[0].id) : null;
}

const audit = (actor: string, action: string, target: string, detail: Record<string, unknown>) =>
  query("insert into app.audit_log (actor_email, action, target, detail) values ($1, $2, $3, $4)", [actor, action, target, JSON.stringify(detail)]).catch(() => undefined);

const history = (uid: string, actor: string, value: string) =>
  query("insert into app.pool_events (uid, actor_email, action, value) values ($1, $2, 'feedback_doc', $3)", [uid, actor, value.slice(0, 500)]).catch(() => undefined);

/** Starts building the document for [period] (or returns the build already running for the candidate). */
export async function startFeedback(user: RosterUser, uid: string, body: { from?: unknown; to?: unknown }): Promise<FeedbackRunDto> {
  await requireSchema();
  const roster = await listRoster();
  const c = await poolCandidateAccess(user, uid, roster);
  if (!c.assigned) throw new UserError(409, "This candidate has no mentor yet. Feedback documents are for assigned candidates.", "not_assigned");
  if (!c.canEdit) throw new UserError(403, c.notYours ?? "Only the assigned mentor, leads and admins can do this.", "not_your_candidate");
  const period = validPeriod(body.from, body.to);
  const team = await teamStatus();
  if (!team.connected) throw new UserError(503, `Connect the team Google account (${team.account || "not set"}) first: an admin can do it in Me → Team.`, "team_not_connected");

  // Nothing to write about: say so now instead of failing a minute later.
  const inputs = await loadInputs(c);
  if (!jobsOf(inputs, period).length) {
    throw new UserError(422, `${c.name} has no applications or shared profiles for jobs in ${periodLabel(period.from, period.to).label}.`, "no_jobs");
  }
  const existing = (await query<{ id: string }>("select id from app.candidate_feedback_docs where uid = $1 and period_from = $2 and period_to = $3", [uid, period.from, period.to]))[0];
  for (let attempt = 0; attempt < 2; attempt++) {
    const rows = await query<{ id: string }>(
      `insert into app.candidate_feedback_runs (document_id, uid, period_from, period_to, mode, status, step, requested_by)
       values ($1, $2, $3, $4, $5, 'queued', 'Starting', $6)
       on conflict (uid) where status in ('queued', 'running') do nothing returning id`,
      [existing?.id ?? null, uid, period.from, period.to, existing ? "update" : "create", user.email],
    );
    if (rows[0]) {
      await audit(user.email, existing ? "feedback_doc_rebuild_started" : "feedback_doc_create_started", uid, { run: rows[0].id, from: period.from, to: period.to });
      void runFeedback(rows[0].id, user, c, period).catch((err) => console.error("[feedback] run crashed:", err instanceof Error ? err.message : err));
      return (await getFeedbackRun(rows[0].id))!;
    }
    const active = await query<{ id: string }>("select id from app.candidate_feedback_runs where uid = $1 and status in ('queued', 'running') limit 1", [uid]);
    if (!active[0]) continue;
    const run = await getFeedbackRun(active[0].id);
    if (run && run.status !== "failed") {
      // The same period: that build is this request's answer. Another period: one build at a time.
      if (run.periodFrom === period.from && run.periodTo === period.to) return run;
      throw new UserError(409, `The ${periodLabel(run.periodFrom, run.periodTo).label} feedback document for ${c.name} is being built. Start this one when it's done.`, "run_in_progress");
    }
  }
  throw new UserError(409, "Another feedback document for this candidate is being built. Try again in a minute.", "run_in_progress");
}

async function step(id: string, text: string) {
  await query("update app.candidate_feedback_runs set status = 'running', step = $2, updated_at = now() where id = $1 and status in ('queued', 'running')", [id, text.slice(0, 200)]);
}

/** [work], or a clear error after [ms] (a Google or model call that hangs must not hold a build forever). */
function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([work, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} took too long. Try again in a few minutes.`)), ms)))]).finally(() => clearTimeout(timer));
}

/**
 * The server's own reviews, kept like the imported ones (source 'live') so later months have the same
 * per-application analysis: applied / sent / decision, the main reason and what the resume showed.
 */
async function storeLiveReviews(uid: string, jobs: FbJob[], facts: Map<string, JobFacts>): Promise<void> {
  const rows = jobs
    .filter((j) => j.jobId && facts.get(j.key)?.source === "live")
    .map((j) => {
      const f = facts.get(j.key)!;
      const reason = j.outcome === "selected" || j.outcome === "awaited" || j.outcome === "not_known" ? "" : REASON_TEXT[reasonOf(j, f)];
      return {
        job_id: j.jobId.trim().toLowerCase().slice(0, 80),
        applied: j.applied,
        sent: j.shared,
        decision: j.outcome === "selected" ? "selected" : j.outcome === "not_forwarded" ? "rejected" : null,
        primary_reason: reason.slice(0, 200),
        read: { readable: f.readable, core: f.core, must_have_missing: f.mustNotShown, shown_in_projects: f.shownSkills, fit_1to5: f.fit, tags: f.tags, fallback: f.fallback },
        resume_url: j.resumeUrl && j.resumeUrl.length <= 1000 ? j.resumeUrl : null,
      };
    });
  if (!rows.length) return;
  await query(
    `insert into app.application_reviews (source, uid, job_id, applied, sent, decision, primary_reason, read, resume_url, checked, provenance)
     select 'live', $1, x.job_id, x.applied, x.sent, x.decision, x.primary_reason, x.read, x.resume_url, 'Checked against the resume text', 'Feedback document build'
       from jsonb_to_recordset($2::jsonb) as x(job_id text, applied boolean, sent boolean, decision text, primary_reason text, read jsonb, resume_url text)
     on conflict (source, uid, job_id) do update set applied = excluded.applied, sent = excluded.sent, decision = excluded.decision,
       primary_reason = excluded.primary_reason, read = excluded.read, resume_url = excluded.resume_url, updated_at = now()`,
    [uid, JSON.stringify(rows)],
  ).catch((err) => console.warn("[feedback] live reviews not stored:", err instanceof Error ? err.message.slice(0, 160) : err));
}

/**
 * At most MAX_PARALLEL builds at a time on this server (each reads resumes and calls the model): the
 * others wait their turn in order, their run kept fresh so it isn't taken for a lost one.
 */
const MAX_PARALLEL = 2;
const gq = globalThis as unknown as { __fbSlots?: { busy: number; waiting: (() => void)[] } };
const slots = (gq.__fbSlots ??= { busy: 0, waiting: [] });

async function takeSlot(id: string): Promise<() => void> {
  if (slots.busy >= MAX_PARALLEL) {
    await query("update app.candidate_feedback_runs set step = 'Waiting for other documents to finish', updated_at = now() where id = $1", [id]).catch(() => undefined);
    const beat = setInterval(() => void query("update app.candidate_feedback_runs set updated_at = now() where id = $1", [id]).catch(() => undefined), 60_000);
    await new Promise<void>((resolve) => slots.waiting.push(resolve));
    clearInterval(beat);
  } else slots.busy++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = slots.waiting.shift();
    if (next) next();
    else slots.busy--;
  };
}

async function runFeedback(id: string, user: RosterUser, c: PoolCandidateAccess, period: { from: string; to: string }): Promise<void> {
  const release = await takeSlot(id);
  // Kept fresh while it works (model calls can take minutes), so it is never taken for a lost run.
  const beat = setInterval(() => void query("update app.candidate_feedback_runs set updated_at = now() where id = $1 and status in ('queued', 'running')", [id]).catch(() => undefined), 60_000);
  try {
    await step(id, "Collecting applications");
    const inputs = await loadInputs(c);
    const jobs = jobsOf(inputs, period);
    if (!jobs.length) throw new Error(`No applications or shared profiles for jobs in ${periodLabel(period.from, period.to).label}.`);

    // Jobs with an imported review (the November Academy review) use it; the others get the server's
    // own review: each resume once, against every job it was used for.
    const facts = new Map<string, JobFacts>();
    for (const j of jobs) if (j.review) facts.set(j.key, factsFromReview(j.review));
    const live = jobs.filter((j) => !j.review && j.resumeUrl);
    const urls = [...new Set(live.map((j) => j.resumeUrl!))].sort(
      (a, b) => (jobs.find((j) => j.resumeUrl === a)?.appliedAt?.getTime() ?? 0) - (jobs.find((j) => j.resumeUrl === b)?.appliedAt?.getTime() ?? 0),
    );
    const allUrls = [...new Set(jobs.map((j) => j.resumeUrl).filter((u): u is string => Boolean(u)))];
    const names = resumeLabels(allUrls, c.name);
    const items = urls.map((url) => ({
      url,
      label: names.get(url)!,
      jobs: live.filter((j) => j.resumeUrl === url).map((j): JobToReview => ({ key: j.key, company: j.company, role: j.role, techStack: j.techStack, jdUrl: j.jdUrl })),
    }));
    await step(id, urls.length ? `Reading resumes (0 of ${urls.length})` : "Writing the document");
    const reviewed = await within(
      10 * 60_000,
      "Reading the resumes",
      reviewResumes(items, (done, total) => step(id, done < total ? `Reading resumes (${done} of ${total})` : "Reviewing resumes")),
    );
    for (const j of live) {
      const url = reviewed.canonical.get(j.resumeUrl!) ?? j.resumeUrl!;
      const rv = reviewed.reviews.get(url);
      j.resumeUrl = url;
      if (rv) facts.set(j.key, factsFromLive(rv, rv.jobs.get(j.key)));
    }

    await step(id, "Writing the document");
    const comparisons = await comparisonsFor(jobs.map((j) => j.jobId));
    const content = buildContent(jobs, {
      candidate: { uid: c.uid, name: c.name },
      period,
      today: today(),
      facts,
      comparisons,
      resumeLabels: names,
      model: reviewed.models[0] ?? null,
      applicationsReadAt: inputs.applicationsReadAt,
      sourcesMissing: inputs.sources,
    });
    const problems = checkContent(content);
    if (problems.length) {
      console.error("[feedback] inconsistent document:", problems.join("; "));
      throw new Error("The document's numbers didn't agree with each other, so it wasn't written. The team has been told in the server log; try again later.");
    }
    const docx = await renderFeedbackDocx(content);

    await step(id, "Saving to Google Docs");
    const existing = (await query<DocRow>(`select ${DOC_COLS} from app.candidate_feedback_docs where uid = $1 and period_from = $2 and period_to = $3`, [c.uid, period.from, period.to]))[0];
    // Back to draft BEFORE the Google Doc changes: a PDF can never be taken of an unreviewed version.
    if (existing) await query("update app.candidate_feedback_docs set status = 'draft', reviewed_by = null, reviewed_at = null where id = $1", [existing.id]);
    const saved = await within(
      2 * 60_000,
      "Saving to Google Docs",
      existing ? replaceGoogleDocFromDocx(existing.external_id, content.fileName, docx) : subFolder("Candidate feedback documents").then((folder) => createGoogleDocFromDocx(content.fileName, docx, folder)),
    );
    // Editable by the person who built it and the candidate's mentor (their Google accounts); never by link.
    const roster = await listRoster();
    const people = [user, c.mentor].filter((u): u is RosterUser => Boolean(u));
    const emails = [...new Set(people.flatMap((u) => [u.email, ...(roster.find((r) => r.email === u.email)?.signInEmails ?? [])]))];
    const shared = await within(60_000, "Giving edit access", shareEditWith(saved.id, emails)).catch(() => ({ granted: [] as string[], lastError: "" }));

    const rows = await query<{ id: string; version: number }>(
      `insert into app.candidate_feedback_docs (uid, period_from, period_to, candidate, external_id, url, title, content, status, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $9)
       on conflict (uid, period_from, period_to) do update set candidate = excluded.candidate, external_id = excluded.external_id, url = excluded.url,
         title = excluded.title, content = excluded.content, status = 'draft', reviewed_by = null, reviewed_at = null,
         version = app.candidate_feedback_docs.version + 1, updated_by = excluded.updated_by, updated_at = now()
       returning id, version`,
      [c.uid, period.from, period.to, c.name.slice(0, 200), saved.id, saved.url, content.title.slice(0, 300), JSON.stringify(content), user.email],
    );
    const doc = rows[0];
    const warnings = [...(shared.granted.length ? [] : ["Google didn't give edit access to anyone; use \"Review in Google Docs\" again."]), ...content.notes].slice(0, 12);
    await storeLiveReviews(c.uid, jobs, facts);
    await query("update app.candidate_feedback_runs set status = 'done', step = 'Done', document_id = $2, result = $3, updated_at = now() where id = $1 and status in ('queued', 'running')", [
      id,
      doc.id,
      JSON.stringify({ documentId: doc.id, url: saved.url, version: doc.version, warnings }),
    ]);
    await history(c.uid, user.email, `Built · ${content.period.short}${doc.version > 1 ? ` (v${doc.version})` : ""}`);
    await audit(user.email, existing ? "feedback_doc_rebuilt" : "feedback_doc_created", saved.url, {
      uid: c.uid,
      version: doc.version,
      jobs: content.counts.jobs,
      resumes: content.analysis.resumes,
      reviewed: content.analysis.reviewed,
      fallback: content.analysis.fallback,
      cached: reviewed.cached,
      calls: reviewed.calls,
      model: content.analysis.model,
    });
    await pushToUser({
      email: user.email,
      kind: "feedback_doc_ready",
      data: {
        uid: c.uid,
        name: c.name,
        documentId: doc.id,
        url: saved.url,
        title: existing ? "Feedback document updated" : "Feedback document ready",
        body: `${c.name} · ${content.period.label} · review it before sending`,
      },
    }).catch(() => undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[feedback] run failed:", message.slice(0, 300));
    await query("update app.candidate_feedback_runs set status = 'failed', error = $2, updated_at = now() where id = $1 and status in ('queued', 'running')", [id, message.slice(0, 600)]).catch(() => undefined);
  } finally {
    clearInterval(beat);
    release();
  }
}

// ── Review, edit, send ──────────────────────────────────────────────────────

async function editable(user: RosterUser, id: string) {
  await requireSchema();
  const r = await docById(id);
  if (!r) throw new UserError(404, "This feedback document doesn't exist.", "not_found");
  const roster = await listRoster();
  const c = await poolCandidateAccess(user, r.uid, roster);
  if (!c.canEdit || !c.assigned) throw new UserError(403, c.notYours ?? "Only the assigned mentor, leads and admins can do this.", "not_your_candidate");
  return { r, roster, c };
}

/** Edit access to the Google Doc for the signed-in person (roster email and linked Google accounts). */
export async function feedbackEditAccess(user: RosterUser, id: string): Promise<{ url: string; title: string; emails: string[] }> {
  const { r, roster } = await editable(user, id);
  const me = roster.find((u) => u.email === user.email) ?? user;
  const { granted, lastError } = await shareEditWith(r.external_id, [me.email, ...(me.signInEmails ?? [])]);
  if (!granted.length) throw new UserError(502, `Google didn't give edit access (${lastError || "unknown reason"}).`, "share_failed");
  await audit(user.email, "feedback_doc_edit_access", r.url, { emails: granted });
  return { url: r.url, title: r.title, emails: granted };
}

/** The version the person read must still be the document's (someone may have rebuilt it meanwhile). */
function sameVersion(r: DocRow, version: unknown) {
  if (version === undefined || version === null || version === "") return;
  if (Number(version) !== r.version) {
    throw new UserError(409, `The document was rebuilt (now version ${r.version}) after you opened it. Review the new version first.`, "version_changed");
  }
}

export async function markFeedbackReviewed(user: RosterUser, id: string, version?: unknown): Promise<FeedbackDocDto> {
  const { r, roster, c } = await editable(user, id);
  sameVersion(r, version);
  if (r.status === "draft") {
    await query("update app.candidate_feedback_docs set status = 'reviewed', reviewed_by = $2, reviewed_at = now() where id = $1 and status = 'draft' and version = $3", [id, user.email, r.version]);
    await history(r.uid, user.email, `Reviewed · ${r.content?.period?.short ?? r.period_from} (v${r.version})`);
    await audit(user.email, "feedback_doc_reviewed", r.url, { uid: r.uid, version: r.version });
  }
  const fresh = (await docById(id))!;
  return toDto(fresh, namesOf(roster), user, c.canEdit);
}

/** The document as it is now in Google Docs (with the reviewer's edits), as a PDF — only once reviewed. */
export async function feedbackPdf(user: RosterUser, id: string, version?: unknown): Promise<{ bytes: Buffer; fileName: string; displayName: string }> {
  const { r } = await editable(user, id);
  sameVersion(r, version);
  if (r.status === "draft") throw new UserError(409, "Review the document and mark it reviewed before sending it.", "not_reviewed");
  let bytes: Buffer;
  try {
    bytes = await within(60_000, "Exporting the PDF", exportPdf(r.external_id));
  } catch (err) {
    console.warn("[feedback] pdf export failed:", err instanceof Error ? err.message.slice(0, 200) : err);
    throw new UserError(502, "Google Docs didn't export the PDF. Try again in a minute.", "export_failed");
  }
  if (bytes.length < 500 || !bytes.subarray(0, 5).toString("latin1").startsWith("%PDF")) throw new UserError(502, "Google Docs didn't export the PDF. Try again in a minute.", "export_failed");
  const period = r.content?.period?.short ?? r.period_from;
  const safe = (s: string) => s.normalize("NFKD").replace(/[^\w\s-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "Candidate";
  // The name the candidate sees (UTF-8, for Content-Disposition filename*): no path or control characters.
  const plain = (s: string) => s.normalize("NFC").replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return {
    bytes,
    fileName: `Resume-Rejection-Analysis-${safe(firstName(r.candidate))}-${safe(period)}.pdf`,
    displayName: `${plain(`Resume Rejection Analysis – ${r.candidate} – ${period}`).slice(0, 150)}.pdf`,
  };
}

export async function markFeedbackShared(user: RosterUser, id: string, channel: unknown, version?: unknown): Promise<FeedbackDocDto> {
  const { r, roster, c } = await editable(user, id);
  if (channel !== "whatsapp" && channel !== "other") throw new UserError(400, "channel must be whatsapp or other.", "invalid_body");
  sameVersion(r, version);
  if (r.status === "draft") throw new UserError(409, "Review the document and mark it reviewed before sending it.", "not_reviewed");
  // A repeat from the same person within 2 minutes (a retried request, the share sheet opened twice)
  // isn't counted or recorded again.
  if (r.status === "shared" && r.shared_by === user.email && r.shared_at && Date.now() - r.shared_at.getTime() < 2 * 60_000) {
    return toDto(r, namesOf(roster), user, c.canEdit);
  }
  await query("update app.candidate_feedback_docs set status = 'shared', shared_by = $2, shared_at = now(), share_count = share_count + 1 where id = $1", [id, user.email]);
  const what = `Feedback document sent · ${r.content?.period?.short ?? r.period_from} (v${r.version})`;
  if (channel === "whatsapp") {
    // A WhatsApp send is also the candidate's last contact (the Pool's "last contact").
    await query("insert into app.pool_events (uid, actor_email, action, value) values ($1, $2, 'whatsapp', $3)", [r.uid, user.email, what]).catch(() => undefined);
  } else await history(r.uid, user.email, what);
  await audit(user.email, "feedback_doc_shared", r.url, { uid: r.uid, version: r.version, channel });
  const fresh = (await docById(id))!;
  return toDto(fresh, namesOf(roster), user, c.canEdit);
}
