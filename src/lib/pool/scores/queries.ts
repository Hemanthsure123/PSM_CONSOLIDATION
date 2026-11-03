import "server-only";
import { databaseConfigured, query } from "@/lib/db/client";
import { normalisePhone, normaliseUserId } from "@/lib/pool/parse";
import {
  ASSESSMENTS,
  isAssessmentKey,
  type AssessmentKey,
  type EligibilityFilter,
  type AssessmentScore,
  type CandidateProfile,
  type PersonRef,
  type ScoresSummary,
} from "@/lib/pool/scores/catalogue";
import { scoreSheetUrl, scoreSheets } from "@/lib/pool/scores/sources";

/**
 * Read side of the assessment marks: the people assessed outside the eligible pool, per-person
 * scores and profiles, the college / year / eligibility filter and the screen's summary. Job
 * eligibility comes from the view placement.assessed_people (migration 005), the one place its
 * rule is written down.
 */

/** pg returns numeric columns as strings. */
const num = (v: unknown): number => Number(v);

/** The database is missing the marks migrations (undefined table / column). */
export const marksTablesMissing = (err: unknown) => ["42P01", "42703"].includes((err as { code?: string } | null)?.code ?? "");
export const MARKS_NOT_SET_UP = "The assessment marks tables aren't up to date — run npm run db:migrate (migrations 004 and 005).";

/**
 * The people behind a batch of pasted ids who have marks but no standing — assessed, not in the
 * eligible pool (so not eligible). Keys "p:<phone>" / "u:<userId>", like lookupStandings.
 */
export async function assessedOutsidePool(people: { phone?: string; userId?: string }[]): Promise<Record<string, PersonRef>> {
  const phones = [...new Set(people.map((p) => normalisePhone(p.phone ?? "")).filter((v): v is string => Boolean(v)))];
  const users = [...new Set(people.map((p) => normaliseUserId(p.userId ?? "")).filter((v): v is string => Boolean(v)))];
  if (!phones.length && !users.length) return {};
  const rows = await query<{ id: string; phone: string | null; user_id: string | null; name: string | null }>(
    `select c.id, c.phone, c.user_id, c.name
       from placement.candidates c
      where (c.phone = any($1::text[]) or c.user_id = any($2::text[]))
        and not exists (select 1 from placement.candidate_standing cs where cs.candidate_id = c.id)
        and exists (select 1 from placement.assessment_scores s where s.candidate_id = c.id)`,
    [phones, users],
  );
  const out: Record<string, PersonRef> = {};
  for (const r of rows) {
    const p: PersonRef = { candidateId: Number(r.id), phone: r.phone, userId: r.user_id, name: r.name ?? "", eligible: false };
    if (r.phone) out[`p:${r.phone}`] = p;
    if (r.user_id) out[`u:${r.user_id}`] = p;
  }
  return out;
}

/** Every stored final score of a batch of people (by candidate id), oldest first. */
export async function scoresFor(candidateIds: number[]): Promise<Record<number, AssessmentScore[]>> {
  const ids = [...new Set(candidateIds.filter((n) => Number.isSafeInteger(n) && n > 0))];
  const out: Record<number, AssessmentScore[]> = {};
  if (!ids.length) return out;
  const rows = await query<{
    candidate_id: string;
    assessment: string;
    score: string;
    max_score: string;
    taken_on: string | null;
    result: string | null;
    passed: boolean | null;
    recording_url: string | null;
    source_key: string;
    attempt: string;
  }>(
    `select candidate_id, assessment, score, max_score, to_char(taken_on, 'YYYY-MM-DD') taken_on, result, passed, recording_url, source_key, attempt
       from placement.assessment_scores where candidate_id = any($1::bigint[])
      order by candidate_id, taken_on nulls first, source_key, attempt`,
    [ids],
  );
  for (const r of rows) {
    if (!isAssessmentKey(r.assessment)) continue;
    (out[Number(r.candidate_id)] ??= []).push({
      assessment: r.assessment,
      score: num(r.score),
      maxScore: num(r.max_score),
      takenOn: r.taken_on,
      result: r.result ?? "",
      passed: r.passed,
      recordingUrl: r.recording_url,
      sourceKey: r.source_key,
      attempt: r.attempt,
    });
  }
  return out;
}

/** Profiles of a batch of people; the year of graduation falls back to the Academy pool sheet's YOG. */
export async function profilesFor(candidateIds: number[]): Promise<Record<number, CandidateProfile>> {
  const ids = [...new Set(candidateIds.filter((n) => Number.isSafeInteger(n) && n > 0))];
  const out: Record<number, CandidateProfile> = {};
  if (!ids.length) return out;
  const rows = await query<{ id: string; yog: number | null; college: string | null; degree: string | null; department: string | null }>(
    `select c.id, coalesce(p.yog, a.yog) yog, p.college, p.degree, p.department
       from unnest($1::bigint[]) as c(id)
       left join placement.candidate_profiles p on p.candidate_id = c.id
       left join placement.academy_records a on a.candidate_id = c.id
      where p.candidate_id is not null or a.yog is not null`,
    [ids],
  );
  for (const r of rows) out[Number(r.id)] = { yog: r.yog, college: r.college ?? "", degree: r.degree ?? "", department: r.department ?? "" };
  return out;
}

export interface PeopleFilter {
  /** Any of these (case-insensitive, "contains"). */
  colleges?: string[];
  yogs?: number[];
  /** Only people with a score in this assessment, of at least minScore (any attempt). */
  assessment?: AssessmentKey;
  minScore?: number;
  /** Eligible for job opportunities, not eligible, or everyone ("all", the default). */
  eligibility?: EligibilityFilter;
}

export const MAX_FILTER_PEOPLE = 20_000;

const likeTerm = (s: string) => `%${s.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Everyone assessed by college / year of graduation / minimum marks / job eligibility — the
 * Standing lookup's "Find" mode. Best score first when an assessment is given, else the eligible
 * first, then by college and name.
 */
export async function filterPeople(f: PeopleFilter): Promise<{ people: PersonRef[]; total: number }> {
  const colleges = (f.colleges ?? []).map((c) => c.trim()).filter(Boolean).slice(0, 50);
  const yogs = (f.yogs ?? []).filter((y) => Number.isInteger(y) && y >= 2000 && y <= 2100).slice(0, 20);
  const assessment = f.assessment && isAssessmentKey(f.assessment) ? f.assessment : null;
  const eligible = f.eligibility === "eligible" ? true : f.eligibility === "not-eligible" ? false : null;
  if (!colleges.length && !yogs.length && !assessment && eligible === null) return { people: [], total: 0 };
  const rows = await query<{ id: string; phone: string | null; user_id: string | null; name: string | null; eligible: boolean; total: string }>(
    `select v.candidate_id id, v.phone, v.user_id, v.name, v.eligible, count(*) over () total
       from placement.assessed_people v
       left join lateral (select max(s.score) score from placement.assessment_scores s
                           where s.candidate_id = v.candidate_id and s.assessment = $3) best on $3::text is not null
      where ($1::text[] is null or v.college ilike any ($1::text[]))
        and ($2::int[] is null or v.yog = any ($2::int[]))
        and ($3::text is null or best.score >= coalesce($4::numeric, 0))
        and ($6::boolean is null or v.eligible = $6)
      order by best.score desc nulls last, v.eligible desc, v.college nulls last, v.name nulls last, v.candidate_id
      limit $5`,
    [colleges.length ? colleges.map(likeTerm) : null, yogs.length ? yogs : null, assessment, f.minScore ?? null, MAX_FILTER_PEOPLE, eligible],
  );
  return {
    people: rows.map((r) => ({ candidateId: Number(r.id), phone: r.phone, userId: r.user_id, name: r.name ?? "", eligible: r.eligible })),
    total: Number(rows[0]?.total ?? 0),
  };
}

export async function scoresSummary(): Promise<ScoresSummary> {
  const sheets = scoreSheets().map((s) => ({ id: s.id, label: s.label, sheetUrl: scoreSheetUrl(s), tab: s.tab }));
  if (!databaseConfigured()) {
    return { configured: false, assessments: [], people: { total: 0, eligible: 0, eligibleAcademy: 0, notEligible: 0, withProfile: 0 }, colleges: [], yogs: [], recentImports: [], sheets };
  }
  const [per, last, people, colleges, yogs, runs] = await Promise.all([
    query<{ assessment: string; people: string; eligible: string; scores: string; recordings: string; sources: string }>(
      `select s.assessment, count(distinct s.candidate_id) people, count(distinct s.candidate_id) filter (where v.eligible) eligible,
              count(*) scores, count(s.recording_url) recordings, count(distinct s.source_key) sources
         from placement.assessment_scores s join placement.assessed_people v using (candidate_id)
        group by s.assessment`,
    ),
    query<{ assessment: string; at: Date }>("select assessment, max(finished_at) at from placement.score_imports where status = 'succeeded' group by assessment"),
    query<{ total: string; eligible: string; eligible_academy: string; with_profile: string }>(
      `select count(*) total, count(*) filter (where eligible) eligible, count(*) filter (where eligible and in_academy_pool) eligible_academy,
              count(*) filter (where yog is not null or college is not null) with_profile
         from placement.assessed_people where scores > 0`,
    ),
    query<{ college: string; people: string }>(
      "select college, count(*) people from placement.assessed_people where college is not null group by college order by people desc, college limit 3000",
    ),
    query<{ yog: number; people: string }>("select yog, count(*) people from placement.assessed_people where yog is not null group by yog order by yog desc"),
    query<{
      id: string;
      source_key: string;
      assessment: string;
      mode: "sheet" | "csv";
      source_ref: string;
      status: "running" | "succeeded" | "failed";
      started_at: Date;
      rows_read: number;
      inserted: number;
      updated: number;
      unchanged: number;
      removed: number;
      people_added: number;
      issue_count: number;
      error: string | null;
    }>(
      `select id, source_key, assessment, mode, source_ref, status, started_at, rows_read, inserted, updated, unchanged, removed, people_added,
              jsonb_array_length(issues) issue_count, error
         from placement.score_imports order by started_at desc limit 20`,
    ),
  ]);
  const total = Number(people[0]?.total ?? 0);
  const eligible = Number(people[0]?.eligible ?? 0);
  return {
    configured: true,
    assessments: ASSESSMENTS.map((a) => {
      const r = per.find((x) => x.assessment === a.key);
      const l = last.find((x) => x.assessment === a.key);
      return {
        key: a.key,
        people: Number(r?.people ?? 0),
        eligible: Number(r?.eligible ?? 0),
        scores: Number(r?.scores ?? 0),
        recordings: Number(r?.recordings ?? 0),
        sources: Number(r?.sources ?? 0),
        lastImportAt: l?.at ? new Date(l.at).toISOString() : null,
      };
    }),
    people: {
      total,
      eligible,
      eligibleAcademy: Number(people[0]?.eligible_academy ?? 0),
      notEligible: total - eligible,
      withProfile: Number(people[0]?.with_profile ?? 0),
    },
    colleges: colleges.map((c) => ({ college: c.college, people: Number(c.people) })),
    yogs: yogs.map((y) => ({ yog: y.yog, people: Number(y.people) })),
    recentImports: runs.map((r) => ({
      id: Number(r.id),
      sourceKey: r.source_key,
      assessment: r.assessment,
      mode: r.mode,
      sourceRef: r.source_ref,
      status: r.status,
      startedAt: new Date(r.started_at).toISOString(),
      rowsRead: r.rows_read,
      inserted: r.inserted,
      updated: r.updated,
      unchanged: r.unchanged,
      removed: r.removed,
      peopleAdded: r.people_added,
      issueCount: r.issue_count,
      error: r.error,
    })),
    sheets,
  };
}
