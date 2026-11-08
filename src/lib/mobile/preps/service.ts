import "server-only";
import { createHash } from "node:crypto";
import { query } from "@/lib/db/client";
import { UserError } from "@/lib/mobile/http";
import { type CandidateClass, classKey, classifyMany, detailTags, type Tag } from "@/lib/mobile/preps/enrich";
import { docMetaFor, driveFileId } from "@/lib/mobile/preps/links";
import {
  addDays,
  atIst,
  CATEGORY_ORDER,
  type Day,
  dayOf,
  DEFAULT_INTERVIEW_LENGTH_MIN,
  docKey,
  interviewOptions,
  interviewStateOf,
  IST_OFFSET_MS,
  interviewStart,
  isOpen,
  PREP_STATUS_LABEL,
  prepGivenValue,
  type PrepRow,
  type PrepStatus,
  slaFor,
} from "@/lib/mobile/preps/parse";
import { type CellWrite, istSerialNow, readDropdowns, readPrepSnapshot, writePrepCells, type PrepSnapshot } from "@/lib/mobile/preps/sheet";
import { mentorsOf, rememberAction, trackPreps, type Tracked } from "@/lib/mobile/preps/track";
import { listRoster, matchMentor, type RosterUser } from "@/lib/mobile/roster";

/**
 * The /preps endpoints (docs/mobile-api.yaml): interviews and preps from the drill-down tab for
 * the app's Calendar, one prep's page, a job's page, and the three writes (prep status,
 * interview status, assignment). The sheet stays the source of truth; every write goes to it.
 */

/** Longest window one calendar request may ask for. */
export const MAX_WINDOW_DAYS = 62;

export interface PrepItemDto {
  id: string;
  row: number;
  company: string;
  jobId: string;
  candidate: string;
  phone: string;
  round: string;
  interviewDay: string | null;
  interviewStart: string | null;
  interviewEnd: string | null;
  interviewTimeText: string;
  interviewTbd: boolean;
  category: CandidateClass["category"];
  edgeVersion: string | null;
  stage: string;
  tags: Tag[];
  mentors: { name: string; email: string | null }[];
  mine: boolean;
  prepStatus: PrepStatus;
  prepStatusText: string;
  candidateStatus: string;
  interviewState: string;
  dueAt: string | null;
  slaKind: string;
  informedLate: boolean;
  firstSeenAt: string | null;
  doneAt: string | null;
  mode: string;
  hasResume: boolean;
  hasLinks: boolean;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function toItem(p: PrepRow, cls: CandidateClass, tracked: Tracked | undefined, roster: RosterUser[], user: RosterUser): PrepItemDto {
  const start = p.interviewTime ? interviewStart(p) : null;
  const end = start && p.interviewDay ? atIst(p.interviewDay, p.interviewTime?.end ?? p.interviewTime!.start + DEFAULT_INTERVIEW_LENGTH_MIN) : null;
  const sla = slaFor(p, tracked?.firstSeenAt ?? null, tracked?.baseline ?? true);
  const matched = mentorsOf(p, roster);
  const mentors = p.prepBy.map((name) => {
    const u = matchMentor(name, roster);
    return { name: u?.name ?? titleCase(name), email: u?.email ?? null };
  });
  return {
    id: p.key,
    row: p.row,
    company: p.company,
    jobId: p.jobId,
    candidate: p.candidate,
    phone: p.phone,
    round: p.round,
    interviewDay: p.interviewDay,
    interviewStart: iso(start),
    interviewEnd: iso(end && end > start! ? end : null),
    interviewTimeText: p.interviewTime ? "" : p.interviewTimeText,
    interviewTbd: p.interviewTbd,
    category: cls.category,
    edgeVersion: cls.edgeVersion,
    stage: cls.stage,
    tags: cls.tags,
    mentors,
    mine: matched.some((m) => m.email === user.email),
    prepStatus: p.prepStatus,
    prepStatusText: p.prepGivenRaw,
    candidateStatus: p.candidateStatus,
    interviewState: p.interviewState,
    dueAt: iso(sla.dueAt),
    slaKind: sla.kind,
    informedLate: sla.informedLate,
    firstSeenAt: tracked && !tracked.baseline ? iso(tracked.firstSeenAt) : null,
    doneAt: iso(tracked?.doneAt ?? null),
    mode: p.mode,
    hasResume: Boolean(p.resumeUrl),
    hasLinks: Boolean(p.drilldownUrl || p.transcriptUrl),
  };
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Academy → Edge → External, then the earliest deadline / interview first. */
export function comparePreps(a: PrepItemDto, b: PrepItemDto): number {
  const c = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
  if (c) return c;
  const t = (x: PrepItemDto) => Date.parse(x.dueAt ?? x.interviewStart ?? `${x.interviewDay ?? "9999-12-31"}T23:59:00+05:30`);
  return t(a) - t(b) || a.candidate.localeCompare(b.candidate);
}

async function context() {
  const [snap, roster] = await Promise.all([readPrepSnapshot(), listRoster()]);
  const tracked = await trackPreps(snap, roster);
  return { snap, roster, tracked };
}

export interface PrepStats {
  openToday: number;
  openTomorrow: number;
  overdue: number;
  unassigned: number;
  interviewsToday: number;
  doneToday: number;
  /** Preps with a deadline that were given in the last 7 days, and how many of those on time. */
  week: { done: number; onTime: number };
}

/**
 * The calendar window: every row with an interview between [from] and [to] (IST days), plus every
 * prep still to be given (whatever its date), so the prep list never misses one.
 */
export async function listPreps(user: RosterUser, from: Day, to: Day): Promise<{ items: PrepItemDto[]; stats: PrepStats; syncedAt: string; etag: string; interviewStatusOptions: string[] }> {
  const { snap, roster, tracked } = await context();
  const now = new Date();
  const today = dayOf(now);
  const recentEntry = addDays(today, -14);
  const picked = snap.preps.filter(
    (p) =>
      (p.interviewDay !== null && p.interviewDay >= from && p.interviewDay <= to) ||
      (isOpen(p, today) && p.interviewDay !== null) ||
      // Interview date still to be confirmed, entered recently, prep not given yet.
      (p.interviewDay === null && p.interviewTbd && p.prepStatus === "pending" && (p.entryDay ?? "") >= recentEntry),
  );
  const classes = await classifyMany(picked.map((p) => ({ phone: p.phone, product: p.product })));
  const items = picked.map((p) => toItem(p, classes.get(classKey(p.phone, p.product))!, tracked.get(p.key), roster, user));
  items.sort((a, b) => (a.interviewStart ?? a.interviewDay ?? "").localeCompare(b.interviewStart ?? b.interviewDay ?? "") || comparePreps(a, b));
  const stats = await statsOf(snap, tracked, today, now);
  const syncedAt = snap.readAt.toISOString();
  const interviewStatusOptions = interviewOptions((await readDropdowns(snap).catch(() => ({ candidateStatus: null }))).candidateStatus);
  const etag = `"${createHash("sha256").update(JSON.stringify([items, stats, interviewStatusOptions, user.email])).digest("base64url").slice(0, 27)}"`;
  return { items, stats, syncedAt, etag, interviewStatusOptions };
}

async function statsOf(snap: PrepSnapshot, tracked: Map<string, Tracked>, today: Day, now: Date): Promise<PrepStats> {
  const tomorrow = addDays(today, 1);
  let openToday = 0;
  let openTomorrow = 0;
  let overdue = 0;
  let unassigned = 0;
  let interviewsToday = 0;
  let doneToday = 0;
  for (const p of snap.preps) {
    const t = tracked.get(p.key);
    if (p.interviewDay === today) interviewsToday++;
    if (p.prepStatus === "done" && (p.prepDay === today || (t?.doneAt && dayOf(t.doneAt) === today))) doneToday++;
    if (!isOpen(p, today) || !p.interviewDay) continue;
    if (p.interviewDay === today) openToday++;
    if (p.interviewDay === tomorrow) openTomorrow++;
    if (p.interviewDay <= tomorrow && !p.prepBy.length) unassigned++;
    if (t?.dueAt && t.dueAt <= now) overdue++;
  }
  const week = await query<{ done: string; on_time: string }>(
    `select count(*) done, count(*) filter (where done_at <= due_at) on_time
       from app.prep_rows where not baseline and due_at is not null and done_at is not null and done_at > now() - interval '7 days'`,
  ).catch(() => [{ done: "0", on_time: "0" }]);
  return { openToday, openTomorrow, overdue, unassigned, interviewsToday, doneToday, week: { done: Number(week[0]?.done ?? 0), onTime: Number(week[0]?.on_time ?? 0) } };
}

// ── One prep ────────────────────────────────────────────────────────────────

export interface DocLinkDto {
  url: string;
  kind: "drilldown" | "transcript";
  title: string;
  updatedAt: string | null;
  /** This candidate's own row has this link. */
  own: boolean;
  /** Where it was seen: "TR1 · 2026-11-04 · Ritesh K." (other candidates of the same job). */
  seenOn: { round: string; interviewDay: string | null; candidate: string }[];
  /** A Google Doc with several tabs (often one per round): which to read is chosen per document. */
  tabs?: { id: string; title: string; level: number }[];
  /** Its tabs couldn't be read (Docs API off, or not shared): the whole document is used. */
  tabsUnknown?: boolean;
}

export function linksFor(p: PrepRow, sameJob: PrepRow[]): DocLinkDto[] {
  const byKey = new Map<string, DocLinkDto>();
  const add = (row: PrepRow, url: string, kind: DocLinkDto["kind"]) => {
    if (!url) return;
    const k = `${kind}:${docKey(url)}`;
    const link = byKey.get(k) ?? { url, kind, title: "", updatedAt: null, own: false, seenOn: [] };
    if (row.key === p.key) link.own = true;
    if (link.seenOn.length < 6) link.seenOn.push({ round: row.round, interviewDay: row.interviewDay, candidate: row.key === p.key ? "" : shortName(row.candidate) });
    byKey.set(k, link);
  };
  add(p, p.drilldownUrl, "drilldown");
  add(p, p.transcriptUrl, "transcript");
  for (const r of sameJob) {
    if (r.key === p.key) continue;
    add(r, r.drilldownUrl, "drilldown");
    add(r, r.transcriptUrl, "transcript");
  }
  return [...byKey.values()];
}

const shortName = (s: string) => {
  const parts = s.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0] ?? "";
};

export async function prepDetail(user: RosterUser, key: string) {
  const { snap, roster, tracked } = await context();
  const p = snap.byKey.get(key);
  if (!p) throw new UserError(404, "This prep is no longer in the drill-down sheet.", "not_found");
  const cls = (await classifyMany([{ phone: p.phone, product: p.product }])).get(classKey(p.phone, p.product))!;
  const sameJob = p.jobId ? snap.preps.filter((r) => r.jobId === p.jobId) : snap.preps.filter((r) => r.company === p.company);
  const links = linksFor(p, sameJob);
  const [tags, meta, events] = await Promise.all([
    detailTags(p.phone, cls),
    docMetaFor(links.map((l) => l.url)),
    query<{ at: Date; actor_email: string; action: string; value: string }>(
      "select at, actor_email, action, value from app.prep_events where prep_key = $1 order by at desc limit 20",
      [key],
    ).catch(() => []),
  ]);
  for (const l of links) {
    const m = meta.get(driveFileId(l.url) ?? "");
    if (m) {
      l.title = m.name;
      l.updatedAt = m.modifiedAt;
    }
  }
  links.sort((a, b) => Number(b.own) - Number(a.own) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const journey = p.phone
    ? snap.preps
        .filter((r) => r.phone === p.phone && r.key !== p.key)
        .map((r) => ({
          id: r.key,
          company: r.company,
          round: r.round,
          interviewDay: r.interviewDay,
          candidateStatus: r.candidateStatus,
          interviewState: r.interviewState,
          prepStatus: r.prepStatus,
        }))
        .sort((a, b) => (b.interviewDay ?? "").localeCompare(a.interviewDay ?? ""))
        .slice(0, 20)
    : [];
  const names = new Map(roster.map((u) => [u.email, u.name]));
  const item = toItem(p, cls, tracked.get(key), roster, user);
  return {
    ...item,
    tags,
    source: cls.source,
    entryDay: p.entryDay,
    resumeUrl: p.resumeUrl,
    process: p.process,
    prepDay: p.prepDay,
    prepTime: p.prepTime ? minutesText(p.prepTime.start) : "",
    prepDocument: p.prepDocument,
    remarks: p.remarks,
    hubspotUrl: p.hubspotUrl,
    meetingUrl: p.meetingUrl,
    recordingUrl: p.recordingUrl,
    recordingNote: p.recordingNote,
    completion: p.completion,
    links,
    journey,
    activity: events.map((e) => ({ at: e.at.toISOString(), by: names.get(e.actor_email) ?? e.actor_email, action: e.action, value: e.value })),
    canEdit: canEditPrep(user, mentorsOf(p, roster), p.prepBy),
    interviewStatusOptions: interviewOptions((await readDropdowns(snap)).candidateStatus),
  };
}

const minutesText = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
};

// ── A job (company view) ────────────────────────────────────────────────────

export async function jobView(user: RosterUser, jobId: string) {
  const { snap, roster, tracked } = await context();
  const id = jobId.trim().toLowerCase();
  const rows = snap.preps.filter((r) => r.jobId === id);
  if (!rows.length) throw new UserError(404, "No interviews for this job in the drill-down sheet.", "not_found");
  const classes = await classifyMany(rows.map((p) => ({ phone: p.phone, product: p.product })));
  const items = rows.map((p) => toItem(p, classes.get(classKey(p.phone, p.product))!, tracked.get(p.key), roster, user));
  items.sort((a, b) => (b.interviewStart ?? b.interviewDay ?? "").localeCompare(a.interviewStart ?? a.interviewDay ?? ""));
  const rounds = new Map<string, { round: string; total: number; selected: number; rejected: number; pending: number }>();
  for (const it of items) {
    const r = rounds.get(it.round) ?? { round: it.round || "—", total: 0, selected: 0, rejected: 0, pending: 0 };
    r.total++;
    if (it.interviewState === "selected" || it.interviewState === "next_round") r.selected++;
    else if (it.interviewState === "rejected") r.rejected++;
    else r.pending++;
    rounds.set(it.round, r);
  }
  const companies = [...new Set(rows.map((r) => r.company))];
  const process = rows.map((r) => r.process).sort((a, b) => b.length - a.length)[0] ?? [];
  const links = linksFor(rows[0], rows).map((l) => ({ ...l, own: false }));
  const meta = await docMetaFor(links.map((l) => l.url));
  for (const l of links) {
    const m = meta.get(driveFileId(l.url) ?? "");
    if (m) {
      l.title = m.name;
      l.updatedAt = m.modifiedAt;
    }
  }
  links.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return { jobId: id, company: companies[0], companies, process, rounds: [...rounds.values()], items, links };
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** Mentors, leads and admins; anyone when "Prep given by" is empty (names not on the roster still count as assigned). */
function canEditPrep(user: RosterUser, mentors: RosterUser[], prepBy: string[]): boolean {
  return user.role === "admin" || user.role === "lead" || !prepBy.length || mentors.some((m) => m.email === user.email);
}

/** A write needs its column; a renamed header must fail loudly, not "succeed" without writing. */
function requireColumn(col: number, header: string): number {
  if (!col) throw new UserError(503, `The drill-down sheet has no "${header}" column. Ask an admin to restore the header.`, "sheets_unavailable");
  return col;
}

async function loadForWrite(user: RosterUser, key: string) {
  const { snap, roster } = await context();
  const p = snap.byKey.get(key);
  if (!p) throw new UserError(404, "This prep is no longer in the drill-down sheet.", "not_found");
  return { p, roster, mentors: mentorsOf(p, roster) };
}

async function logEvent(key: string, user: RosterUser, action: string, value: string) {
  await query("insert into app.prep_events (prep_key, actor_email, action, value) values ($1, $2, $3, $4)", [key, user.email, action, value.slice(0, 300)]);
}

export type PrepStatusInput = PrepStatus;

/**
 * Sets "Prep Given". Done also fills Prep Date / Prep Time (now, IST) and — when empty — "Prep given
 * by" with the user's name; a document name and a remark are added when given. "pending" clears
 * the prep (undo).
 */
export async function setPrepStatus(user: RosterUser, key: string, body: { status?: unknown; document?: unknown; note?: unknown }) {
  const status = String(body.status ?? "") as PrepStatus;
  if (status !== "pending" && !(status in PREP_STATUS_LABEL)) throw new UserError(422, "Pick a prep status.", "invalid_status");
  const document = String(body.document ?? "").trim().slice(0, 200);
  const note = String(body.note ?? "").trim().slice(0, 300);
  const { p, mentors } = await loadForWrite(user, key);
  if (!canEditPrep(user, mentors, p.prepBy)) throw new UserError(403, `This prep is ${mentors.map((m) => m.name).join(" and ")}'s. Ask them or a lead to update it.`, "not_assignee");
  const { snap } = await context();
  const c = snap.columns;
  requireColumn(c.prepGiven, "Prep Given");
  const label = status === "pending" ? "" : prepGivenValue(status as Exclude<PrepStatus, "pending" | "other">, (await readDropdowns(snap)).prepGiven);
  if (label === null) throw new UserError(422, "The sheet's Prep Given dropdown has no value for that status.", "invalid_status");
  const cells: CellWrite[] = [];
  if (status === "pending") {
    cells.push({ col: c.prepGiven, text: "" }, { col: c.prepDate, text: "" }, { col: c.prepTime, text: "" });
  } else {
    cells.push({ col: c.prepGiven, text: label });
    if (status === "done") {
      const { day, time } = istSerialNow();
      cells.push(
        { col: c.prepDate, date: { serial: day, pattern: "dd-mm-yyyy", type: "DATE" } },
        { col: c.prepTime, date: { serial: time, pattern: "h:mm am/pm", type: "TIME" } },
      );
      if (!p.prepBy.length) cells.push({ col: c.prepBy, text: user.name.toUpperCase() });
    }
  }
  if (document) cells.push({ col: c.prepDocument, text: document });
  if (note) cells.push({ col: c.remarks, text: p.remarks ? `${p.remarks} | ${note}` : note });
  const today = dayOf(new Date());
  const minutes = Math.floor(((Date.now() + IST_OFFSET_MS) % 86_400_000) / 60_000);
  await writePrepCells(key, cells, (row) => ({
    ...row,
    prepGivenRaw: label,
    prepStatus: status,
    prepBy: status === "done" && !row.prepBy.length ? [user.name.toUpperCase()] : row.prepBy,
    prepByRaw: status === "done" && !row.prepBy.length ? user.name.toUpperCase() : row.prepByRaw,
    prepDay: status === "done" ? today : status === "pending" ? null : row.prepDay,
    prepTime: status === "done" ? { start: minutes, end: null } : status === "pending" ? null : row.prepTime,
    prepDocument: document || row.prepDocument,
    remarks: note ? (row.remarks ? `${row.remarks} | ${note}` : note) : row.remarks,
  }));
  await logEvent(key, user, "prep_status", status === "pending" ? "Reopened" : label);
  await rememberAction(key, { doneAt: status === "done" ? new Date() : null, ...(status === "done" && !p.prepBy.length ? { mentorEmails: [user.email] } : {}) });
  return prepDetail(user, key);
}

/** Sets "Candidate's Status" — the interview check (any roster member may record it). */
export async function setInterviewStatus(user: RosterUser, key: string, body: { status?: unknown }) {
  const asked = String(body.status ?? "").trim();
  if (!asked || asked.length > 200) throw new UserError(422, "Pick the interview's status.", "invalid_status");
  const { snap } = await context();
  // The sheet has a dropdown: write its exact value (spacing included), never a value it would reject.
  const options = (await readDropdowns(snap)).candidateStatus;
  const status = options ? options.find((o) => o.trim().toLowerCase() === asked.toLowerCase()) : asked;
  if (!status) throw new UserError(422, `"${asked}" isn't one of the sheet's statuses. Refresh and pick again.`, "invalid_status");
  await loadForWrite(user, key);
  await writePrepCells(key, [{ col: requireColumn(snap.columns.candidateStatus, "Candidate's Status"), text: status }], (row) => ({
    ...row,
    candidateStatus: status.trim(),
    interviewState: interviewStateOf(status),
  }));
  await logEvent(key, user, "interview_status", status.trim());
  return prepDetail(user, key);
}

/**
 * Sets "Prep given by". Anyone may take an unassigned prep or hand back their own; leads and
 * admins may assign anyone on the roster.
 */
export async function assignPrep(user: RosterUser, key: string, body: { emails?: unknown }) {
  const emails = Array.isArray(body.emails) ? [...new Set(body.emails.map((e) => String(e ?? "").trim().toLowerCase()).filter(Boolean))] : null;
  if (!emails || emails.length > 4) throw new UserError(422, "Pick up to 4 people.", "invalid_assignees");
  const { p, roster, mentors } = await loadForWrite(user, key);
  const people = emails.map((e) => roster.find((u) => u.email === e && u.active));
  if (people.some((u) => !u)) throw new UserError(422, "Someone picked isn't on the team roster.", "invalid_assignees");
  const isLead = user.role === "admin" || user.role === "lead";
  const current = mentors.map((m) => m.email).sort();
  const next = emails.slice().sort();
  const onlySelfChange =
    next.filter((e) => !current.includes(e)).every((e) => e === user.email) && current.filter((e) => !next.includes(e)).every((e) => e === user.email);
  if (!isLead && !onlySelfChange) throw new UserError(403, "Only leads and admins can assign preps to others. You can take one or hand back your own.", "lead_only");
  const { snap } = await context();
  // Keep names the roster doesn't know (e.g. someone outside the app) unless the change removes them.
  const unknown = p.prepBy.filter((n) => !mentorsOf({ prepBy: [n] }, roster).length);
  const names = [...people.map((u) => u!.name.toUpperCase()), ...(isLead ? [] : unknown)];
  await writePrepCells(key, [{ col: snap.columns.prepBy, text: names.join(", ") }], (row) => ({ ...row, prepBy: names, prepByRaw: names.join(", ") }));
  await logEvent(key, user, "assign", names.join(", ") || "Unassigned");
  await rememberAction(key, { mentorEmails: emails });
  return prepDetail(user, key);
}
