-- 004 — Assessment final scores and education profiles: the Standing lookup's marks and its
-- college / year-of-graduation filter.
--
-- Design:
--  * Only the ONE final score of each assessment is stored (overall_candidate_score, "Total
--    (/15)", "Overall Score (out of 100)" …), never its sections. Each score keeps its maximum,
--    the date it was taken, and the sheet's own verdict for it (Qualified, Cleared, Bucket A …).
--  * assessments: the catalogue of what is measured (DSA offline exam, Bucket B TR-1 …). The app
--    owns it (src/lib/pool/scores/catalogue.ts) and upserts it on every import.
--  * assessment_scores: one row per person × source × attempt. A "source" (source_key) is one
--    complete export: one offline exam ("dsa_offline@2026-10-25"), or one interview log
--    ("bucket_b_tr1:audit"). Re-importing a source replaces exactly that source's rows, so a
--    corrected sheet never leaves stale rows behind and the import is idempotent. Repeat
--    attempts are separate rows; the reader picks best / latest / all.
--  * candidate_profiles: year of graduation, college, degree, department — one row per person.
--    source_rank (1 = the assessed roster, 2 = an interview sheet, 3 = an exam export) decides
--    which source may overwrite a field; a weaker source only fills gaps.
--  * People: only assessed people are added — a person is created for a score, never for a
--    roster row without one. They live in placement.candidates beside the eligible pool (same
--    identity rules: user id / phone unique), but they get no standing unless a product sheet
--    lists them, so the eligible pool's counts and Domain shortlisting are unchanged.
--  * score_imports: the import log (counts, row issues), like sync_runs for the products.
--  * Indexes: none beyond the primary keys. Reads are by candidate id (the scores' primary key
--    leads with it); an import reads its own source's rows, and the college / year filter scans
--    profiles — both are a few thousand rows, where a sequential scan takes about a millisecond
--    and an index would only slow the writes down.

create table placement.assessments (
  key         text primary key check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label       text not null check (char_length(label) between 1 and 80),
  product     placement.product not null,
  max_score   numeric(7, 2) not null check (max_score > 0),
  updated_at  timestamptz not null default now()
);
comment on table placement.assessments is 'What a final score measures. Owned by the app (src/lib/pool/scores/catalogue.ts).';

create table placement.assessment_scores (
  candidate_id  bigint not null references placement.candidates (id) on delete cascade,
  source_key    text not null check (char_length(source_key) between 3 and 80),
  attempt       text not null check (char_length(attempt) between 1 and 40),
  assessment    text not null references placement.assessments (key),
  score         numeric(7, 2) not null check (score >= 0),
  max_score     numeric(7, 2) not null check (max_score > 0),
  taken_on      date,
  result        text check (char_length(result) <= 160),   -- the sheet's verdict: Qualified, Cleared, Bucket A, L3 · Medium Hire …
  passed        boolean,                                   -- that verdict read as cleared / qualified (null: no verdict)
  row_hash      text not null,
  updated_at    timestamptz not null default now(),
  primary key (candidate_id, source_key, attempt),
  constraint assessment_scores_score_within_max check (score <= max_score)
);
comment on table placement.assessment_scores is 'Final scores only: one row per person × source export × attempt.';

create table placement.candidate_profiles (
  candidate_id  bigint primary key references placement.candidates (id) on delete cascade,
  yog           smallint check (yog between 2000 and 2100),
  college       text check (char_length(college) <= 300),
  degree        text check (char_length(degree) <= 160),
  department    text check (char_length(department) <= 160),
  source_rank   smallint not null check (source_rank between 1 and 9),
  updated_at    timestamptz not null default now()
);
comment on table placement.candidate_profiles is 'Year of graduation and college per person, from the assessment sheets.';

create table placement.score_imports (
  id            bigint generated always as identity primary key,
  source_key    text not null,
  assessment    text not null,
  mode          placement.sync_mode not null,
  source_ref    text not null,                 -- sheet id + tab, or the CSV file name
  status        placement.sync_status not null default 'running',
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  rows_read     integer not null default 0,
  inserted      integer not null default 0,
  updated       integer not null default 0,
  unchanged     integer not null default 0,
  removed       integer not null default 0,
  skipped       integer not null default 0,
  people_added  integer not null default 0,
  issues        jsonb not null default '[]'::jsonb,   -- row-level problems (first 200)
  error         text,
  triggered_by  text
);

alter table placement.assessments         enable row level security;
alter table placement.assessment_scores   enable row level security;
alter table placement.candidate_profiles  enable row level security;
alter table placement.score_imports       enable row level security;
