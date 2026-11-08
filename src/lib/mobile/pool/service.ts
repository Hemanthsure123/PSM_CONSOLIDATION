import "server-only";
import { createHash } from "node:crypto";
import { query, transaction } from "@/lib/db/client";
import { UserError } from "@/lib/mobile/http";
import { dayOf, normRound, type PrepRow } from "@/lib/mobile/preps/parse";
import { readPrepSnapshot } from "@/lib/mobile/preps/sheet";
import { listRoster, matchMentor, type RosterUser } from "@/lib/mobile/roster";
import {
  cleanTags,
  isPoolTrack,
  isPriority,
  POOL_TRACKS,
  type PoolTrack,
  type Priority,
  TRACK_LABEL,
} from "@/lib/mobile/pool/parse";
import { lastPoolSync } from "@/lib/mobile/pool/sync";
import { assessmentInfo, type AssessmentScore } from "@/lib/pool/scores/catalogue";
import { scoresFor } from "@/lib/pool/scores/queries";

/**
 * Academy priority pool — what the app reads and what mentors change.
 *
 * Who sees whom: admins and leads see every mentored candidate; everyone else sees the candidates
 * whose MENTOR cell names them (roster name or alias). The mentor is matched when read, so a
 * mentor added to the team later sees their candidates at once.
 *
 * Joined at read time, never copied: assessment marks (placement.*, by UID then phone) and
 * interviews (the EDGE drill-down tab, by phone; cached 30 s by the preps code).
 */

const canSeeAll = (u: RosterUser) => u.role === "admin" || u.role === "lead";

interface CandidateRow {
  uid: string;
  name: string;
  email: string | null;
  phone: string | null;
  yog: number | null;
  location: string | null;
  college: string | null;
  course: string | null;
  specialization: string | null;
  sheet_tech_stack: string | null;
  sheet_track: PoolTrack | null;
  mentor_name: string;
  track: PoolTrack | null;
  priority: Priority | null;
  tags: string[] | null;
  version: number | null;
  state_updated_at: Date | null;
  state_updated_by: string | null;
  candidate_id: string | null;
  standing: string | null;
  tier: number | null;
  resumes: number;
  best_resumes: number;
  last_contact_at: Date | null;
  last_contact_action: string | null;
  last_contact_by: string | null;
  updated_at: Date;
}

const SELECT_CANDIDATES = `
  select p.uid, p.name, p.email, p.phone, p.yog, p.location, p.college, p.course, p.specialization,
         p.sheet_tech_stack, p.sheet_track, p.mentor_name, p.updated_at,
         s.track, s.priority, s.tags, s.version, s.updated_at as state_updated_at, s.updated_by as state_updated_by,
         link.candidate_id, ar.stage_label as standing, ar.tier,
         coalesce(r.n, 0)::int as resumes, coalesce(r.best, 0)::int as best_resumes,
         lc.at as last_contact_at, lc.action as last_contact_action, lc.actor_email as last_contact_by
    from app.pool_candidates p
    left join app.pool_state s on s.uid = p.uid
    left join lateral (
      select c.id as candidate_id from placement.candidates c
       where c.user_id = p.uid or (p.phone is not null and c.phone = p.phone)
       order by (c.user_id = p.uid) desc limit 1
    ) link on true
    left join placement.academy_records ar on ar.candidate_id = link.candidate_id
    left join lateral (
      select count(*) as n, count(*) filter (where best) as best from app.pool_resumes x where x.uid = p.uid and x.deleted_at is null
    ) r on true
    left join lateral (
      select e.at, e.action, e.actor_email from app.pool_events e
       where e.uid = p.uid and e.action in ('call', 'whatsapp', 'email', 'meeting')
       order by e.at desc limit 1
    ) lc on true`;

/** The candidates [user] may see (removed rows excluded), mentor matched to the roster. */
async function visibleCandidates(user: RosterUser, roster: RosterUser[], uids?: string[]): Promise<(CandidateRow & { mentor: RosterUser | null })[]> {
  const rows = uids
    ? await query<CandidateRow>(`${SELECT_CANDIDATES} where p.removed_at is null and p.uid = any($1::text[])`, [uids])
    : await query<CandidateRow>(`${SELECT_CANDIDATES} where p.removed_at is null`);
  const all = canSeeAll(user);
  const out: (CandidateRow & { mentor: RosterUser | null })[] = [];
  for (const r of rows) {
    const mentor = matchMentor(r.mentor_name, roster);
    if (all || mentor?.email === user.email) out.push({ ...r, mentor });
  }
  return out;
}

/** One candidate the user may see, or a 404 (not "forbidden": we don't reveal who exists). */
async function visibleCandidate(user: RosterUser, uid: string, roster?: RosterUser[]) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/.test(uid)) throw new UserError(404, "This candidate isn't in your pool.", "not_found");
  const r = roster ?? (await listRoster());
  const [row] = await visibleCandidates(user, r, [uid]);
  if (!row) throw new UserError(404, "This candidate isn't in your pool.", "not_found");
  return row;
}

/** Access check for actions on one candidate (same 404 as the detail screen); returns their name. */
export async function assertPoolAccess(user: RosterUser, uid: string): Promise<{ name: string }> {
  const r = await visibleCandidate(user, uid);
  return { name: r.name };
}

// ── Interviews (EDGE drill-down, by phone) ──────────────────────────────────

export interface PoolInterviewDto {
  prepId: string;
  company: string;
  round: string;
  /** YYYY-MM-DD (IST), null when the sheet has no date yet. */
  day: string | null;
  /** "4:00 PM – 5:00 PM" as read, or the cell's text. */
  time: string;
  status: string;
  state: PrepRow["interviewState"];
  prepStatus: PrepRow["prepStatus"];
  prepBy: string[];
}

const clock = (m: number) => {
  const h = Math.floor(m / 60) % 24;
  const mm = String(m % 60).padStart(2, "0");
  return `${h % 12 || 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
};

function interviewOf(p: PrepRow): PoolInterviewDto {
  return {
    prepId: p.key,
    company: p.company,
    round: normRound(p.round),
    day: p.interviewDay,
    time: p.interviewTime ? [clock(p.interviewTime.start), p.interviewTime.end != null ? clock(p.interviewTime.end) : null].filter(Boolean).join(" – ") : p.interviewTimeText,
    status: p.candidateStatus,
    state: p.interviewState,
    prepStatus: p.prepStatus,
    prepBy: p.prepBy,
  };
}

/** Newest first; undated rows last. */
const byDayDesc = (a: PoolInterviewDto, b: PoolInterviewDto) => (b.day ?? "").localeCompare(a.day ?? "");

/** Interviews per phone. Null when the drill-down tab can't be read right now (shown as such). */
async function interviewsByPhone(phones: string[]): Promise<Map<string, PoolInterviewDto[]> | null> {
  const wanted = new Set(phones.filter(Boolean));
  if (!wanted.size) return new Map();
  try {
    const snap = await readPrepSnapshot();
    const out = new Map<string, PoolInterviewDto[]>();
    for (const p of snap.preps) {
      if (!wanted.has(p.phone)) continue;
      const list = out.get(p.phone) ?? [];
      list.push(interviewOf(p));
      out.set(p.phone, list);
    }
    for (const list of out.values()) list.sort(byDayDesc);
    return out;
  } catch (err) {
    console.warn("[pool] interviews unavailable:", err instanceof Error ? err.message.slice(0, 160) : err);
    return null;
  }
}

// ── Assessments (placement.*, by UID then phone) ────────────────────────────

export interface PoolScoreDto {
  key: string;
  label: string;
  kind: "exam" | "interview";
  score: number;
  maxScore: number;
  /** 0–100, rounded. */
  percent: number;
  takenOn: string | null;
  result: string;
  passed: boolean | null;
  recordingUrl: string | null;
  attempt: string;
}

function scoreDto(s: AssessmentScore): PoolScoreDto {
  const info = assessmentInfo(s.assessment);
  return {
    key: s.assessment,
    label: info.label,
    kind: info.kind,
    score: s.score,
    maxScore: s.maxScore,
    percent: s.maxScore > 0 ? Math.round((s.score / s.maxScore) * 100) : 0,
    takenOn: s.takenOn,
    result: s.result,
    passed: s.passed,
    recordingUrl: s.recordingUrl,
    attempt: s.attempt,
  };
}

/** The latest attempt of each assessment (catalogue order: interviews and exams as the team reads them). */
function latestPerAssessment(scores: AssessmentScore[]): PoolScoreDto[] {
  const latest = new Map<string, AssessmentScore>();
  for (const s of scores) {
    const prev = latest.get(s.assessment);
    if (!prev || (s.takenOn ?? "") >= (prev.takenOn ?? "")) latest.set(s.assessment, s);
  }
  return [...latest.values()].map(scoreDto);
}

/** Interviews first (competency, then bucket rounds), strongest first: the "headline" marks of a card. */
function highlights(latest: PoolScoreDto[]): PoolScoreDto[] {
  return [...latest].sort((a, b) => (a.kind === b.kind ? b.percent - a.percent : a.kind === "interview" ? -1 : 1)).slice(0, 3);
}

/** The average of the latest attempts, as a percentage (the "Score" sort). Null: never assessed. */
const averagePercent = (latest: PoolScoreDto[]) => (latest.length ? Math.round(latest.reduce((n, s) => n + s.percent, 0) / latest.length) : null);

// ── List ────────────────────────────────────────────────────────────────────

export interface PoolMentorDto {
  name: string;
  email: string | null;
}

export interface PoolItemDto {
  uid: string;
  name: string;
  phone: string | null;
  email: string | null;
  yog: number | null;
  location: string | null;
  college: string | null;
  mentor: PoolMentorDto;
  /** The track the candidate is on: the mentor's choice, else the sheet's TechStack. */
  track: PoolTrack | null;
  sheetTrack: PoolTrack | null;
  sheetTechStack: string | null;
  priority: Priority | null;
  tags: string[];
  version: number;
  standing: string | null;
  scorePercent: number | null;
  assessments: number;
  topScores: PoolScoreDto[];
  interviews: { count: number; upcoming: number; last: PoolInterviewDto | null } | null;
  resumes: number;
  bestResumes: number;
  lastContact: { at: string; channel: string; by: string } | null;
  updatedAt: string;
}

export interface PoolListDto {
  items: PoolItemDto[];
  /** Admins: mentor names in the sheet that nobody on the team matches (add them in Team). */
  unmatchedMentors: { name: string; candidates: number }[];
  mentors: PoolMentorDto[];
  tagSuggestions: string[];
  tracks: { key: PoolTrack; label: string }[];
  scope: "all" | "mine";
  syncedAt: string | null;
  interviewsAvailable: boolean;
}

export async function listPool(user: RosterUser): Promise<{ body: PoolListDto; etag: string }> {
  const roster = await listRoster();
  const [rows, synced, allMentorNames, tagRows] = await Promise.all([
    visibleCandidates(user, roster),
    lastPoolSync(),
    canSeeAll(user)
      ? query<{ mentor_name: string; n: number }>("select mentor_name, count(*)::int n from app.pool_candidates where removed_at is null group by mentor_name")
      : Promise.resolve([]),
    query<{ tag: string }>("select distinct unnest(tags) as tag from app.pool_state order by 1 limit 200"),
  ]);
  const ids = rows.map((r) => Number(r.candidate_id)).filter((n) => n > 0);
  const [scores, interviews] = await Promise.all([scoresFor(ids), interviewsByPhone(rows.map((r) => r.phone ?? ""))]);
  const today = dayOf(new Date());
  const roster2 = new Map(roster.map((u) => [u.email, u]));
  const items: PoolItemDto[] = rows.map((r) => {
    const latest = latestPerAssessment(r.candidate_id ? scores[Number(r.candidate_id)] ?? [] : []);
    const ivs = interviews ? interviews.get(r.phone ?? "") ?? [] : null;
    return {
      uid: r.uid,
      name: r.name,
      phone: r.phone,
      email: r.email,
      yog: r.yog,
      location: r.location,
      college: r.college,
      mentor: { name: r.mentor?.name ?? r.mentor_name, email: r.mentor?.email ?? null },
      track: r.track ?? r.sheet_track,
      sheetTrack: r.sheet_track,
      sheetTechStack: r.sheet_tech_stack,
      priority: r.priority,
      tags: r.tags ?? [],
      version: r.version ?? 0,
      standing: r.standing,
      scorePercent: averagePercent(latest),
      assessments: latest.length,
      topScores: highlights(latest),
      interviews: ivs
        ? { count: ivs.length, upcoming: ivs.filter((i) => i.day && i.day >= today && i.state === "scheduled").length, last: ivs[0] ?? null }
        : null,
      resumes: r.resumes,
      bestResumes: r.best_resumes,
      lastContact: r.last_contact_at
        ? { at: r.last_contact_at.toISOString(), channel: r.last_contact_action ?? "", by: roster2.get(r.last_contact_by ?? "")?.name ?? r.last_contact_by ?? "" }
        : null,
      updatedAt: (r.state_updated_at && r.state_updated_at > r.updated_at ? r.state_updated_at : r.updated_at).toISOString(),
    };
  });
  const unmatchedMentors = allMentorNames
    .filter((m) => !matchMentor(m.mentor_name, roster))
    .map((m) => ({ name: m.mentor_name.trim(), candidates: m.n }))
    .sort((a, b) => b.candidates - a.candidates);
  const mentors = canSeeAll(user)
    ? [...new Map(items.map((i) => [i.mentor.email ?? `name:${i.mentor.name.toLowerCase()}`, i.mentor])).values()].sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const body: PoolListDto = {
    items,
    unmatchedMentors,
    mentors,
    tagSuggestions: tagRows.map((t) => t.tag),
    tracks: POOL_TRACKS.map((key) => ({ key, label: TRACK_LABEL[key] })),
    scope: canSeeAll(user) ? "all" : "mine",
    syncedAt: synced?.toISOString() ?? null,
    interviewsAvailable: interviews !== null,
  };
  // Day-bucketed so "upcoming" counts roll over at midnight even when nothing else changed.
  const etag = `"${createHash("sha1").update(JSON.stringify(body)).update(today).digest("hex").slice(0, 32)}"`;
  return { body, etag };
}

// ── Detail ──────────────────────────────────────────────────────────────────

export interface PoolResumeDto {
  id: string;
  stack: string;
  best: boolean;
  fileName: string;
  mime: string;
  sizeBytes: number;
  note: string | null;
  uploadedBy: string;
  uploadedByName: string;
  createdAt: string;
}

export interface PoolEventDto {
  at: string;
  action: string;
  value: string;
  by: string;
  byName: string;
}

interface ResumeRow {
  id: string;
  stack: string;
  best: boolean;
  file_name: string;
  mime: string;
  size_bytes: number;
  note: string | null;
  uploaded_by: string;
  created_at: Date;
}

export function resumeDto(r: ResumeRow, roster: RosterUser[]): PoolResumeDto {
  return {
    id: r.id,
    stack: r.stack,
    best: r.best,
    fileName: r.file_name,
    mime: r.mime,
    sizeBytes: r.size_bytes,
    note: r.note,
    uploadedBy: r.uploaded_by,
    uploadedByName: roster.find((u) => u.email === r.uploaded_by)?.name ?? r.uploaded_by,
    createdAt: r.created_at.toISOString(),
  };
}

export async function poolDetail(user: RosterUser, uid: string) {
  const roster = await listRoster();
  const r = await visibleCandidate(user, uid, roster);
  const candidateId = Number(r.candidate_id);
  const [scores, interviews, resumes, events, meetings] = await Promise.all([
    candidateId > 0 ? scoresFor([candidateId]) : Promise.resolve({} as Record<number, AssessmentScore[]>),
    interviewsByPhone([r.phone ?? ""]),
    query<ResumeRow>(
      "select id, stack, best, file_name, mime, size_bytes, note, uploaded_by, created_at from app.pool_resumes where uid = $1 and deleted_at is null order by best desc, created_at desc",
      [uid],
    ),
    query<{ at: Date; action: string; value: string; actor_email: string }>(
      "select at, action, value, actor_email from app.pool_events where uid = $1 order by at desc limit 50",
      [uid],
    ),
    query<{ id: string; kind: string; title: string; starts_at: Date; ends_at: Date; status: string; meet_url: string | null; created_by: string }>(
      "select id, kind, title, starts_at, ends_at, status, meet_url, created_by from app.meetings where $1 = any(pool_uids) order by starts_at desc limit 30",
      [uid],
    ),
  ]);
  const all = (candidateId > 0 ? scores[candidateId] ?? [] : []).map(scoreDto);
  const latest = latestPerAssessment(candidateId > 0 ? scores[candidateId] ?? [] : []);
  const name = (email: string) => roster.find((u) => u.email === email)?.name ?? email;
  return {
    uid: r.uid,
    name: r.name,
    phone: r.phone,
    email: r.email,
    yog: r.yog,
    location: r.location,
    college: r.college,
    course: r.course,
    specialization: r.specialization,
    mentor: { name: r.mentor?.name ?? r.mentor_name, email: r.mentor?.email ?? null },
    track: r.track ?? r.sheet_track,
    sheetTrack: r.sheet_track,
    sheetTechStack: r.sheet_tech_stack,
    priority: r.priority,
    tags: r.tags ?? [],
    version: r.version ?? 0,
    standing: r.standing,
    scorePercent: averagePercent(latest),
    /** Every attempt, newest first within each assessment. */
    assessments: all.sort((a, b) => a.label.localeCompare(b.label) || (b.takenOn ?? "").localeCompare(a.takenOn ?? "")),
    latestAssessments: latest,
    interviews: interviews ? interviews.get(r.phone ?? "") ?? [] : null,
    resumes: resumes.map((x) => resumeDto(x, roster)),
    meetings: meetings.map((m) => ({
      id: m.id,
      kind: m.kind,
      title: m.title,
      startsAt: m.starts_at.toISOString(),
      endsAt: m.ends_at.toISOString(),
      status: m.status,
      meetUrl: m.meet_url,
      createdByName: name(m.created_by),
    })),
    history: events.map((e): PoolEventDto => ({ at: e.at.toISOString(), action: e.action, value: e.value, by: e.actor_email, byName: name(e.actor_email) })),
    updatedBy: r.state_updated_by ? name(r.state_updated_by) : null,
    updatedAt: r.state_updated_at?.toISOString() ?? null,
  };
}

// ── Mentors' edits ──────────────────────────────────────────────────────────

export interface PoolUpdateInput {
  version?: unknown;
  priority?: unknown;
  track?: unknown;
  tags?: unknown;
}

/**
 * Sets priority / track / tags (only the fields sent; null clears priority or track). [version] is
 * the version the app last saw: someone else's newer change is never overwritten silently (409).
 */
export async function updatePoolCandidate(user: RosterUser, uid: string, input: PoolUpdateInput) {
  await visibleCandidate(user, uid);
  const has = (k: keyof PoolUpdateInput) => Object.prototype.hasOwnProperty.call(input, k);
  if (!has("priority") && !has("track") && !has("tags")) throw new UserError(422, "Nothing to change.", "invalid_body");
  if (has("priority") && input.priority !== null && !isPriority(input.priority)) throw new UserError(422, "Priority is P0, P1, P2 or P3.", "invalid_priority");
  if (has("track") && input.track !== null && !isPoolTrack(input.track)) throw new UserError(422, "Track is Frontend, Backend, Full Stack or AI/ML.", "invalid_track");
  const tags = has("tags") ? cleanTags(input.tags) : null;
  if (has("tags") && tags === null) throw new UserError(422, "Up to 20 tech stack tags, 40 characters each.", "invalid_tags");
  const version = Number(input.version ?? 0);
  if (!Number.isInteger(version) || version < 0) throw new UserError(422, "version is required.", "invalid_body");

  await transaction(async (tx) => {
    const cur = (
      await tx.query<{ track: PoolTrack | null; priority: Priority | null; tags: string[]; version: number }>(
        "select track, priority, tags, version from app.pool_state where uid = $1 for update",
        [uid],
      )
    ).rows[0];
    if ((cur?.version ?? 0) !== version) {
      throw new UserError(409, "Someone else changed this candidate just now. Their change is shown; make yours again.", "version_conflict");
    }
    const next = {
      track: has("track") ? (input.track as PoolTrack | null) : cur?.track ?? null,
      priority: has("priority") ? (input.priority as Priority | null) : cur?.priority ?? null,
      tags: tags ?? cur?.tags ?? [],
    };
    await tx.query(
      `insert into app.pool_state (uid, track, priority, tags, version, updated_by) values ($1, $2, $3, $4, 1, $5)
       on conflict (uid) do update set track = excluded.track, priority = excluded.priority, tags = excluded.tags,
         version = app.pool_state.version + 1, updated_by = excluded.updated_by, updated_at = now()`,
      [uid, next.track, next.priority, next.tags, user.email],
    );
    const events: [string, string][] = [];
    if (has("priority") && next.priority !== (cur?.priority ?? null)) events.push(["priority", next.priority ? next.priority.toUpperCase() : "cleared"]);
    if (has("track") && next.track !== (cur?.track ?? null)) events.push(["track", next.track ? TRACK_LABEL[next.track] : "cleared"]);
    if (tags && JSON.stringify(tags) !== JSON.stringify(cur?.tags ?? [])) events.push(["tags", tags.join(", ").slice(0, 500) || "cleared"]);
    for (const [action, value] of events) {
      await tx.query("insert into app.pool_events (uid, actor_email, action, value) values ($1, $2, $3, $4)", [uid, user.email, action, value]);
    }
  });
  return poolDetail(user, uid);
}

/** The person called / messaged the candidate from the app (for "last contacted" and the history). */
export async function logPoolContact(user: RosterUser, uid: string, channel: unknown): Promise<void> {
  if (channel !== "call" && channel !== "whatsapp" && channel !== "email") throw new UserError(422, "channel is call, whatsapp or email.", "invalid_body");
  await visibleCandidate(user, uid);
  // A double tap logs once.
  await query(
    `insert into app.pool_events (uid, actor_email, action)
     select $1, $2, $3 where not exists (
       select 1 from app.pool_events where uid = $1 and actor_email = $2 and action = $3 and at > now() - interval '1 minute')`,
    [uid, user.email, channel],
  );
}

// ── Meetings (mock interview / guidance meet) ───────────────────────────────

export interface PoolMember {
  uid: string;
  name: string;
  email: string | null;
  phone: string | null;
  track: PoolTrack | null;
  mentor: string;
}

/** The pool candidates of a meeting: every id must be one the user can see (at most 100). */
export async function poolMembersFor(user: RosterUser, raw: unknown): Promise<PoolMember[]> {
  if (!Array.isArray(raw) || !raw.length) return [];
  const ids = [...new Set(raw.map((x) => String(x ?? "").trim()).filter(Boolean))];
  if (ids.length > 100) throw new UserError(422, "A meeting can have at most 100 candidates.", "invalid_meeting");
  const roster = await listRoster();
  const rows = await visibleCandidates(user, roster, ids);
  if (rows.length !== ids.length) throw new UserError(404, "Some of these candidates aren't in your pool any more. Refresh and pick again.", "not_found");
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows
    .sort((a, b) => (order.get(a.uid) ?? 0) - (order.get(b.uid) ?? 0))
    .map((r) => ({ uid: r.uid, name: r.name, email: r.email, phone: r.phone, track: r.track ?? r.sheet_track, mentor: r.mentor?.name ?? r.mentor_name }));
}

/** History lines for a scheduled meeting (one per candidate). */
export async function logPoolMeeting(user: RosterUser, uids: string[], what: string): Promise<void> {
  if (!uids.length) return;
  await query(
    "insert into app.pool_events (uid, actor_email, action, value) select u, $2, 'meeting', $3 from unnest($1::text[]) u",
    [uids, user.email, what.slice(0, 500)],
  );
}
