import "server-only";
import { databaseConfigured, query } from "@/lib/db/client";
import { normalisePhone, normaliseUserId } from "@/lib/pool/parse";
import { poolSource, sheetUrl } from "@/lib/pool/sources";
import {
  COMPETENCY_SUBJECTS,
  PRODUCTS,
  TR2_TRACKS,
  type AcademyBucket,
  type AcademyCompetency,
  type AcademyRound,
  type CandidateStanding,
  type Edge2Record,
  type PersonRecords,
  type PoolSummary,
  type Product,
  type ProductStanding,
  type SyncRun,
  type Tier,
} from "@/lib/pool/types";

/** Read side of the eligible pool: dashboard counts and standings by phone / user id. */

const emptyTiers = (): Record<Tier, number> => ({ 1: 0, 2: 0, 3: 0, 4: 0 });
const RECENT_RUNS = 12;

const sources = () =>
  PRODUCTS.map((product) => {
    const s = poolSource(product);
    return { product, sheetUrl: sheetUrl(s), tab: s.tab };
  });

export async function poolSummary(): Promise<PoolSummary> {
  if (!databaseConfigured()) {
    return {
      configured: false,
      sources: sources(),
      recentRuns: [],
      people: { total: 0, byTier: emptyTiers(), inMoreThanOneProduct: 0 },
      products: PRODUCTS.map((product) => ({ product, total: 0, eligible: 0, byTier: emptyTiers(), lastSync: null, lastSuccessAt: null })),
      edge2Tracks: [],
      edge2CombinedTr2: 0,
      academyTop: { bucketATr2: 0, competencyL3: 0 },
      academyOldBuckets: [],
      academyDsaOfflineCleared: 0,
      academyRounds: [],
      academyCompetency: [],
    };
  }
  // Independent reads, in parallel (each is a single small aggregate).
  const [tiers, people, multi, syncs, tracks, buckets, rounds, competency, runs, extras] = await Promise.all([
    query<{ product: Product; tier: number; n: string; eligible: string }>(
      `select product, tier, count(*) n, count(*) filter (where eligible) eligible from (
         select 'edge1' product, tier, eligible from placement.edge1_records
         union all select 'edge2', tier, eligible from placement.edge2_records
         union all select 'academy', tier, eligible from placement.academy_records) t
       group by product, tier`,
    ),
    query<{ tier: number; n: string }>("select best_tier tier, count(*) n from placement.candidate_standing group by best_tier"),
    query<{ n: string }>("select count(*) n from placement.candidate_standing where jsonb_array_length(standings) > 1"),
    query<{ product: Product; started_at: Date; mode: "sheet" | "csv"; status: string; inserted: number; updated: number; unchanged: number; last_ok: Date | null }>(
      `select distinct on (product) product, started_at, mode, status, inserted, updated, unchanged,
              (select max(finished_at) from placement.sync_runs ok where ok.product = r.product and ok.status = 'succeeded') last_ok
         from placement.sync_runs r order by product, started_at desc`,
    ),
    query<{ track: string; strong: string; medium: string }>(
      `select v.track, count(*) filter (where v.verdict = 'strong_hire') strong, count(*) filter (where v.verdict = 'medium_hire') medium
         from placement.edge2_tr2_verdicts v group by v.track`,
    ),
    query<{ bucket: string | null; total: string; dsa: string }>(
      `select old_bucket::text bucket, count(*) total, count(*) filter (where dsa_offline_cleared) dsa
         from placement.academy_records group by old_bucket`,
    ),
    query<{ bucket: "A" | "B" | "C"; round: number; taken: string; cleared: string }>(
      `select bucket::text bucket, round, count(*) taken, count(*) filter (where cleared) cleared
         from placement.academy_rounds group by bucket, round`,
    ),
    query<{ subject: string; label: string; n: string }>(
      `select subject::text, coalesce(case when level is null then null when level = 0 then 'Below L1' else 'L' || level end, 'No level') label, count(*) n
         from placement.academy_competency group by subject, label`,
    ),
    query<{
      id: string;
      product: Product;
      mode: "sheet" | "csv";
      source_ref: string;
      status: SyncRun["status"];
      started_at: Date;
      finished_at: Date | null;
      rows_read: number;
      inserted: number;
      updated: number;
      unchanged: number;
      skipped: number;
      issue_count: number;
      error: string | null;
      triggered_by: string | null;
    }>(
      `select id, product, mode, source_ref, status, started_at, finished_at, rows_read, inserted, updated, unchanged, skipped,
              jsonb_array_length(issues) issue_count, error, triggered_by
         from placement.sync_runs order by started_at desc limit $1`,
      [RECENT_RUNS],
    ),
    query<{ combined: string; a_tr2: string; l3: string }>(
      `select (select count(*) from placement.edge2_records
                where tier = 1 and (tr2_best_verdict is null or tr2_best_verdict not in ('strong_hire', 'medium_hire'))) combined,
              (select count(distinct candidate_id) from placement.academy_rounds where bucket = 'A' and round = 2 and cleared) a_tr2,
              (select count(distinct candidate_id) from placement.academy_competency where cleared and level >= 3) l3`,
    ),
  ]);

  const byTier = emptyTiers();
  for (const r of people) byTier[r.tier as Tier] = Number(r.n);
  return {
    configured: true,
    sources: sources(),
    recentRuns: runs.map((r) => ({
      id: Number(r.id),
      product: r.product,
      mode: r.mode,
      sourceRef: r.source_ref,
      status: r.status,
      startedAt: new Date(r.started_at).toISOString(),
      finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      rowsRead: r.rows_read,
      inserted: r.inserted,
      updated: r.updated,
      unchanged: r.unchanged,
      skipped: r.skipped,
      issueCount: r.issue_count,
      error: r.error,
      triggeredBy: r.triggered_by,
    })),
    people: { total: people.reduce((s, r) => s + Number(r.n), 0), byTier, inMoreThanOneProduct: Number(multi[0]?.n ?? 0) },
    products: PRODUCTS.map((product) => {
      const rows = tiers.filter((t) => t.product === product);
      const t = emptyTiers();
      for (const r of rows) t[r.tier as Tier] = Number(r.n);
      const s = syncs.find((x) => x.product === product);
      return {
        product,
        total: rows.reduce((sum, r) => sum + Number(r.n), 0),
        eligible: rows.reduce((sum, r) => sum + Number(r.eligible), 0),
        byTier: t,
        lastSync: s
          ? { at: new Date(s.started_at).toISOString(), mode: s.mode, status: s.status, inserted: s.inserted, updated: s.updated, unchanged: s.unchanged }
          : null,
        lastSuccessAt: s?.last_ok ? new Date(s.last_ok).toISOString() : null,
      };
    }),
    edge2CombinedTr2: Number(extras[0]?.combined ?? 0),
    academyTop: { bucketATr2: Number(extras[0]?.a_tr2 ?? 0), competencyL3: Number(extras[0]?.l3 ?? 0) },
    edge2Tracks: TR2_TRACKS.map((track) => {
      const r = tracks.find((x) => x.track === track);
      return { track, strong: Number(r?.strong ?? 0), medium: Number(r?.medium ?? 0) };
    }),
    academyOldBuckets: (["A", "B", "C", "D", "none"] as const).map((b) => ({
      bucket: b as AcademyBucket | "none",
      total: Number(buckets.find((x) => (x.bucket ?? "none") === b)?.total ?? 0),
    })),
    academyDsaOfflineCleared: buckets.reduce((s, r) => s + Number(r.dsa), 0),
    academyRounds: (["A", "B", "C"] as const).map((bucket) => {
      const r = (n: number) => rounds.find((x) => x.bucket === bucket && x.round === n);
      return {
        bucket,
        tr1Taken: Number(r(1)?.taken ?? 0),
        tr1Cleared: Number(r(1)?.cleared ?? 0),
        tr2Taken: Number(r(2)?.taken ?? 0),
        tr2Cleared: Number(r(2)?.cleared ?? 0),
      };
    }),
    academyCompetency: COMPETENCY_SUBJECTS.map((subject) => {
      const rows = competency.filter((c) => c.subject === subject);
      return { subject, taken: rows.reduce((s, r) => s + Number(r.n), 0), byLevel: Object.fromEntries(rows.map((r) => [r.label, Number(r.n)])) };
    }),
  };
}

/** pg returns numeric columns as strings. */
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/**
 * The assessment records behind a batch of people (by candidate id), for the products asked
 * for — what the Standing lookup's Requirements column is built from. One query per product.
 */
export async function poolRecords(candidateIds: number[], include: Product[]): Promise<Record<number, PersonRecords>> {
  const ids = [...new Set(candidateIds.filter((n) => Number.isSafeInteger(n) && n > 0))];
  const out: Record<number, PersonRecords> = {};
  if (!ids.length || !include.length) return out;
  const slot = (id: unknown) => (out[Number(id)] ??= {});
  const identity = (r: { user_id: string | null; phone: string | null; name: string | null; reference_resume_url: string | null }) => ({
    userId: r.user_id,
    phone: r.phone,
    name: r.name ?? "",
    referenceResumeUrl: r.reference_resume_url,
  });
  type Ident = { candidate_id: string; user_id: string | null; phone: string | null; name: string | null; reference_resume_url: string | null };

  await Promise.all([
    include.includes("edge1")
      ? query<Ident & { assessment_status: string | null; tr1_status: string | null; tr2_status: string | null }>(
          `select candidate_id, user_id, phone, name, reference_resume_url, assessment_status, tr1_status, tr2_status
             from placement.edge1_records where candidate_id = any($1::bigint[])`,
          [ids],
        ).then((rows) => {
          for (const r of rows) {
            slot(r.candidate_id).edge1 = {
              product: "edge1",
              ...identity(r),
              assessmentStatus: str(r.assessment_status),
              tr1Status: str(r.tr1_status),
              tr2Status: str(r.tr2_status),
            };
          }
        })
      : null,
    include.includes("edge2")
      ? query<Ident & Record<string, unknown> & { candidate_stage: string; tr2: { track: string; verdict: string }[] }>(
          `select r.candidate_id, r.user_id, r.phone, r.name, r.reference_resume_url, r.candidate_stage,
                  r.offline_overall_score, r.dsa_coding_score, r.cs_fundamentals_score, r.sql_mcq_score, r.sql_coding_score,
                  r.tr1_self_intro, r.tr1_dsa_overall, r.tr1_problem_solving, r.tr1_coding, r.tr1_communication, r.tr1_debugging,
                  r.tr1_overall_technical,
                  coalesce((select jsonb_agg(jsonb_build_object('track', v.track, 'verdict', v.verdict) order by v.verdict, v.track)
                              from placement.edge2_tr2_verdicts v where v.candidate_id = r.candidate_id), '[]'::jsonb) tr2
             from placement.edge2_records r where r.candidate_id = any($1::bigint[])`,
          [ids],
        ).then((rows) => {
          for (const r of rows) {
            slot(r.candidate_id).edge2 = {
              product: "edge2",
              ...identity(r),
              candidateStage: str(r.candidate_stage),
              offlineOverallScore: num(r.offline_overall_score),
              dsaCodingScore: num(r.dsa_coding_score),
              csFundamentalsScore: num(r.cs_fundamentals_score),
              sqlMcqScore: num(r.sql_mcq_score),
              sqlCodingScore: num(r.sql_coding_score),
              tr1: {
                selfIntro: num(r.tr1_self_intro),
                dsaOverall: num(r.tr1_dsa_overall),
                problemSolving: num(r.tr1_problem_solving),
                coding: num(r.tr1_coding),
                communication: num(r.tr1_communication),
                debugging: num(r.tr1_debugging),
                overallTechnical: num(r.tr1_overall_technical),
              },
              tr2: (r.tr2 ?? []) as Edge2Record["tr2"],
            };
          }
        })
      : null,
    include.includes("academy")
      ? query<
          Ident & {
            yog: number | null;
            old_bucket: AcademyBucket | null;
            dsa_offline_status: string | null;
            dsa_offline_cleared: boolean;
            previous_placement: string | null;
            student_preference: string | null;
            active_pool: boolean | null;
            rounds: { bucket: "A" | "B" | "C"; round: 1 | 2; score: number | null; status: string | null; cleared: boolean }[];
            competency: {
              subject: AcademyCompetency["subject"];
              overall_score: number | null;
              verdict_band: string | null;
              clearance_status: string | null;
              cleared: boolean;
              level: number | null;
              level_label: string | null;
            }[];
          }
        >(
          `select r.candidate_id, r.uid user_id, r.phone, r.name, r.reference_resume_url, r.yog, r.old_bucket::text old_bucket,
                  r.dsa_offline_status, r.dsa_offline_cleared, r.previous_placement, r.student_preference, r.active_pool,
                  coalesce((select jsonb_agg(jsonb_build_object('bucket', x.bucket, 'round', x.round, 'score', x.score, 'status', x.status, 'cleared', x.cleared)
                                    order by x.bucket, x.round)
                              from placement.academy_rounds x where x.candidate_id = r.candidate_id), '[]'::jsonb) rounds,
                  coalesce((select jsonb_agg(jsonb_build_object('subject', c.subject, 'overall_score', c.overall_score, 'verdict_band', c.verdict_band,
                                                                'clearance_status', c.clearance_status, 'cleared', c.cleared, 'level', c.level,
                                                                'level_label', c.level_label) order by c.subject)
                              from placement.academy_competency c where c.candidate_id = r.candidate_id), '[]'::jsonb) competency
             from placement.academy_records r where r.candidate_id = any($1::bigint[])`,
          [ids],
        ).then((rows) => {
          for (const r of rows) {
            slot(r.candidate_id).academy = {
              product: "academy",
              ...identity(r),
              yog: r.yog,
              oldBucket: r.old_bucket,
              dsaOfflineStatus: str(r.dsa_offline_status),
              dsaOfflineCleared: r.dsa_offline_cleared,
              previousPlacement: str(r.previous_placement),
              studentPreference: str(r.student_preference),
              activePool: r.active_pool,
              rounds: (r.rounds ?? []).map((x): AcademyRound => ({ ...x, score: num(x.score), status: str(x.status) })),
              competency: (r.competency ?? []).map(
                (c): AcademyCompetency => ({
                  subject: c.subject,
                  overallScore: num(c.overall_score),
                  verdictBand: str(c.verdict_band),
                  clearanceStatus: str(c.clearance_status),
                  cleared: c.cleared,
                  level: num(c.level),
                  levelLabel: str(c.level_label),
                }),
              ),
            };
          }
        })
      : null,
  ]);
  return out;
}

/**
 * Standings for a batch of people, looked up by phone first and user id second.
 * Returns one entry per input key that matched, keyed "p:<phone>" / "u:<userId>".
 */
export async function lookupStandings(people: { phone?: string; userId?: string }[]): Promise<Record<string, CandidateStanding>> {
  const phones = [...new Set(people.map((p) => normalisePhone(p.phone ?? "")).filter((v): v is string => Boolean(v)))];
  const users = [...new Set(people.map((p) => normaliseUserId(p.userId ?? "")).filter((v): v is string => Boolean(v)))];
  if (!phones.length && !users.length) return {};
  const rows = await query<{
    candidate_id: string;
    phone: string | null;
    user_id: string | null;
    name: string | null;
    best_product: Product;
    best_tier: number;
    best_score: number;
    best_label: string;
    eligible: boolean;
    standings: ProductStanding[];
  }>(
    `select candidate_id, phone, user_id, name, best_product, best_tier, best_score, best_label, eligible, standings
       from placement.candidate_standing
      where phone = any($1::text[]) or user_id = any($2::text[])`,
    [phones, users],
  );
  const out: Record<string, CandidateStanding> = {};
  for (const r of rows) {
    const s: CandidateStanding = {
      candidateId: Number(r.candidate_id),
      phone: r.phone,
      userId: r.user_id,
      name: r.name ?? "",
      bestProduct: r.best_product,
      bestTier: r.best_tier as Tier,
      bestScore: r.best_score,
      bestLabel: r.best_label,
      eligible: r.eligible,
      standings: r.standings.map((x) => ({ ...x, tier: x.tier as Tier })),
    };
    if (r.phone) out[`p:${r.phone}`] = s;
    if (r.user_id) out[`u:${r.user_id}`] = s;
  }
  return out;
}
