-- 001 — The eligible pool: the internal assessments of Edge 1.0, Edge 2.0 and Academy.
--
-- Design:
--  * Everything lives in its own schema, "placement". Supabase's Data API only exposes
--    "public", so nothing here is reachable with the anon / authenticated keys. RLS is
--    still enabled on every table with no policies: deny-by-default if the schema is
--    ever exposed. The app connects as the database owner (server side only).
--  * One row per PERSON in placement.candidates. The phone number (10 digits) is the
--    primary way to find a person and the user id the secondary one. Both are UNIQUE
--    and indexed. A surrogate id is the key the other tables reference, so correcting a
--    phone number never breaks a link, and the 150 Edge 1.0 rows without a phone still
--    have a home.
--  * One row per person per PRODUCT: edge1_records, edge2_records, academy_records. They
--    store only the columns the placement team uses, plus a derived standing (tier,
--    label, internal score, eligible) computed by the app's tested rules
--    (src/lib/pool/standing.ts), so every reader agrees on it.
--  * Repeating groups are child tables: Edge 2.0's TR-2 verdict per track, Academy's
--    interview rounds per bucket, and Academy's competency exams per subject.
--  * row_hash: a hash of a record's source fields. A sync rewrites a row only when its
--    hash changed, so re-syncing an unchanged sheet writes nothing.
--  * candidate_standing (materialized view): each person's best standing across
--    products, precomputed for fast lookups by phone / user id in Domain Shortlisting
--    and for the dashboard counts. It is refreshed CONCURRENTLY after every sync.
--  * Indexes only where reads need them: identity look-ups (phone, user id), the view's
--    unique key and look-ups, and the sync log's newest-first listing. The product
--    tables are small (thousands of rows) and keyed by candidate_id; extra indexes
--    there would only slow down the writes.

create schema if not exists placement;
revoke all on schema placement from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema placement from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on schema placement from authenticated'; end if;
end $$;

-- ── Vocabularies ────────────────────────────────────────────────────────────
create type placement.product as enum ('edge1', 'edge2', 'academy');
create type placement.verdict as enum ('strong_hire', 'medium_hire', 'low_hire', 'rejected');
create type placement.tr2_track as enum ('data_analytics', 'dsml', 'genai', 'java_fullstack', 'mern_fullstack', 'product', 'python_fullstack');
create type placement.academy_bucket as enum ('A', 'B', 'C', 'D');
create type placement.competency_subject as enum ('dsa', 'frontend', 'backend', 'software');
create type placement.sync_mode as enum ('sheet', 'csv');
create type placement.sync_status as enum ('running', 'succeeded', 'failed');

-- ── People ──────────────────────────────────────────────────────────────────
create table placement.candidates (
  id          bigint generated always as identity primary key,
  phone       char(10) unique check (phone ~ '^[0-9]{10}$'),
  user_id     text unique check (char_length(user_id) between 1 and 64),
  name        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint candidates_has_identity check (phone is not null or user_id is not null)
);
comment on table placement.candidates is 'One row per person. Found by phone first, then by user id.';

-- Columns every product record shares: who, the derived standing, and bookkeeping.
-- (Kept explicit per table rather than inherited, so each table stays plain SQL.)

-- ── Edge 1.0 ────────────────────────────────────────────────────────────────
create table placement.edge1_records (
  candidate_id          bigint primary key references placement.candidates (id) on delete cascade,
  user_id               text,
  phone                 char(10),
  name                  text,
  assessment_status     text,          -- "SELECTED" = DSA offline assessment cleared
  tr1_status            text,          -- Strong / Medium / Low Hire, Rejected
  tr2_status            text,          -- "Shortlisted" = TR-2 cleared, Rejected
  reference_resume_url  text,          -- reference only; applications carry their own resume
  tier                  smallint not null check (tier between 1 and 4),
  stage_label           text not null,
  internal_score        smallint not null check (internal_score between 0 and 100),
  eligible              boolean not null,
  row_hash              text not null,
  source                placement.sync_mode not null,
  first_seen_at         timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  last_seen_at          timestamptz not null default now()
);

-- ── Edge 2.0 ────────────────────────────────────────────────────────────────
create table placement.edge2_records (
  candidate_id          bigint primary key references placement.candidates (id) on delete cascade,
  user_id               text,
  phone                 char(10),
  name                  text,
  candidate_stage       text not null,  -- Assessment Cleared / TR1 CLEARED / TR2 CLEARED
  offline_overall_score numeric(6, 2),  -- out of 160
  dsa_coding_score      numeric(6, 2),  -- out of 120
  cs_fundamentals_score numeric(6, 2),  -- out of 40
  sql_mcq_score         numeric(5, 2),  -- out of 15
  sql_coding_score      numeric(5, 2),  -- out of 15
  tr1_self_intro        numeric(4, 2),  -- TR-1 ratings, out of 10
  tr1_dsa_overall       numeric(4, 2),
  tr1_problem_solving   numeric(4, 2),
  tr1_coding            numeric(4, 2),
  tr1_communication     numeric(4, 2),
  tr1_debugging         numeric(4, 2),
  tr1_overall_technical numeric(5, 2),  -- out of 100
  tr2_best_verdict      placement.verdict,   -- best over the tracks; low_hire counts as rejected for TR-2
  tr2_best_track        placement.tr2_track,
  reference_resume_url  text,
  tier                  smallint not null check (tier between 1 and 4),
  stage_label           text not null,
  internal_score        smallint not null check (internal_score between 0 and 100),
  eligible              boolean not null,
  row_hash              text not null,
  source                placement.sync_mode not null,
  first_seen_at         timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  last_seen_at          timestamptz not null default now()
);

create table placement.edge2_tr2_verdicts (
  candidate_id  bigint not null references placement.edge2_records (candidate_id) on delete cascade,
  track         placement.tr2_track not null,
  verdict       placement.verdict not null,
  primary key (candidate_id, track)
);

-- ── Academy ─────────────────────────────────────────────────────────────────
create table placement.academy_records (
  candidate_id          bigint primary key references placement.candidates (id) on delete cascade,
  uid                   text,
  phone                 char(10),
  name                  text,
  yog                   smallint check (yog between 2000 and 2100),
  old_bucket            placement.academy_bucket,   -- "Old Assessment Checks": DSA offline (old process) bucket
  dsa_offline_status    text,                       -- "DSA Offline": DSA competency offline exam, e.g. "27th Sep - Cleared"
  dsa_offline_cleared   boolean not null default false,
  previous_placement    text,
  student_preference    text,
  active_pool           boolean,
  reference_resume_url  text,
  tier                  smallint not null check (tier between 1 and 4),
  stage_label           text not null,
  internal_score        smallint not null check (internal_score between 0 and 100),
  eligible              boolean not null,
  row_hash              text not null,
  source                placement.sync_mode not null,
  first_seen_at         timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  last_seen_at          timestamptz not null default now()
);

-- Bucket A: TR-1 + TR-2 (full stack). Bucket B: TR-1 + TR-2 (frontend). Bucket C: TR-1 only.
create table placement.academy_rounds (
  candidate_id  bigint not null references placement.academy_records (candidate_id) on delete cascade,
  bucket        placement.academy_bucket not null check (bucket <> 'D'),
  round         smallint not null check (round in (1, 2)),
  score         numeric(6, 2),
  status        text,
  cleared       boolean not null,
  primary key (candidate_id, bucket, round),
  constraint academy_rounds_c_has_no_tr2 check (not (bucket = 'C' and round = 2))
);

-- Competency exams (offline) + their panel interview level: L1 … L5 (L5 best), 0 = "Below L1".
create table placement.academy_competency (
  candidate_id      bigint not null references placement.academy_records (candidate_id) on delete cascade,
  subject           placement.competency_subject not null,
  overall_score     numeric(5, 2) check (overall_score between 0 and 100),
  verdict_band      text,
  clearance_status  text,
  cleared           boolean not null,
  level             smallint check (level between 0 and 5),
  level_label       text,
  primary key (candidate_id, subject)
);

-- ── Sync log ────────────────────────────────────────────────────────────────
create table placement.sync_runs (
  id            bigint generated always as identity primary key,
  product       placement.product not null,
  mode          placement.sync_mode not null,
  source_ref    text not null,                 -- sheet id + tab, or the CSV file name
  status        placement.sync_status not null default 'running',
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  rows_read     integer not null default 0,
  inserted      integer not null default 0,
  updated       integer not null default 0,
  unchanged     integer not null default 0,
  skipped       integer not null default 0,
  issues        jsonb not null default '[]'::jsonb,   -- row-level problems (first 200)
  error         text,
  triggered_by  text
);
create index sync_runs_product_started_idx on placement.sync_runs (product, started_at desc);

-- ── Each person's best standing, across products ───────────────────────────
create materialized view placement.candidate_standing as
with records as (
  select candidate_id, 'edge1'::placement.product as product, tier, internal_score, stage_label, eligible from placement.edge1_records
  union all
  select candidate_id, 'edge2'::placement.product, tier, internal_score, stage_label, eligible from placement.edge2_records
  union all
  select candidate_id, 'academy'::placement.product, tier, internal_score, stage_label, eligible from placement.academy_records
),
ranked as (
  select r.*, row_number() over (partition by r.candidate_id order by r.tier, r.internal_score desc, r.product) as rn
  from records r
),
standings as (
  select candidate_id,
         jsonb_agg(jsonb_build_object('product', product, 'tier', tier, 'label', stage_label, 'score', internal_score, 'eligible', eligible)
                   order by tier, internal_score desc) as standings,
         bool_or(eligible) as eligible
  from records
  group by candidate_id
)
select c.id as candidate_id, c.phone, c.user_id, c.name,
       b.product as best_product, b.tier as best_tier, b.internal_score as best_score, b.stage_label as best_label,
       s.eligible, s.standings
from ranked b
join placement.candidates c on c.id = b.candidate_id
join standings s on s.candidate_id = b.candidate_id
where b.rn = 1
with no data;

create unique index candidate_standing_pkey on placement.candidate_standing (candidate_id);   -- required by REFRESH … CONCURRENTLY
create index candidate_standing_phone_idx on placement.candidate_standing (phone) where phone is not null;
create index candidate_standing_user_id_idx on placement.candidate_standing (user_id) where user_id is not null;
refresh materialized view placement.candidate_standing;

-- ── Deny-by-default for the Data API roles ─────────────────────────────────
alter table placement.candidates          enable row level security;
alter table placement.edge1_records       enable row level security;
alter table placement.edge2_records       enable row level security;
alter table placement.edge2_tr2_verdicts  enable row level security;
alter table placement.academy_records     enable row level security;
alter table placement.academy_rounds      enable row level security;
alter table placement.academy_competency  enable row level security;
alter table placement.sync_runs           enable row level security;
