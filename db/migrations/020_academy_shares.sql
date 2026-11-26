-- 020 — Academy candidates (PSM 1.10.0): every assessed row in the pool, company shares, and the
-- state behind the new Academy notifications.
--
-- app.pool_candidates      now holds EVERY row of "> 8LPA Assessed Pool" that has a UID (before: only
--                          rows with a MENTOR). mentor_name '' = unassigned. Code deployed before this
--                          migration keeps copying only mentored rows (the old check refuses '').
-- app.company_sheets       one row per company sheet listed in the master ">8 LPA Companies" sheet
--                          (tab CRPs, column "Company Sheet Link"): the master's facts (company, roles,
--                          job ids, CRP months, ISE, CRM, Final Status, Current Stage of Interview),
--                          and the sync's state (Drive modifiedTime at the last read, last read / try,
--                          the read error that the admin screen lists, tabs and Academy rows read).
-- app.company_shares       one row per (sheet, tab, Academy assessed candidate): the rounds as typed
--                          ([{name, value}], sheet order, non-empty only), final status, a short stage
--                          label and an outcome (selected / rejected / in_process / on_hold / no_show /
--                          unknown). Only rows matched to the pool (phone, then email) are stored:
--                          nobody else's data ever is. removed_at = no longer in the sheet (kept 400
--                          days). baseline = found at the sheet's first read (never notified; its
--                          first_seen_at is the best estimate of when it was shared). outcome_at = when
--                          the outcome last changed (null for baseline rows), for "selected this week".
-- app.company_share_syncs  a log of the hourly runs (and the cross-process lease: status 'running').
-- app.pool_interview_marks the drill-down interviews of assessed candidates already notified (date and
--                          time), so a new row or a moved interview pushes once. Kept 30 days past.
-- app.sync_marks           "this job has done its first (baseline) run" markers.
--
-- Closed to the anon/authenticated roles like the other app tables; only the server reads and
-- writes them. Retention by pg_cron (011) like 012/015/017/019.

-- Unassigned candidates: mentor_name may be empty (it was 1–80 characters).
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'app.pool_candidates'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%mentor_name%'
  loop
    execute format('alter table app.pool_candidates drop constraint %I', c);
  end loop;
end $$;
alter table app.pool_candidates add constraint pool_candidates_mentor_name_len check (char_length(mentor_name) <= 80);
comment on table app.pool_candidates is 'Academy assessed pool: every row of the sheet with a UID (only the agreed columns); mentor_name '''' = unassigned. Read only from the sheet.';

create table app.company_sheets (
  sheet_id             text primary key check (sheet_id ~ '^[A-Za-z0-9_-]{20,100}$'),
  company              text not null default '' check (char_length(company) <= 200),
  roles                text[] not null default '{}' check (cardinality(roles) <= 20),
  job_ids              text[] not null default '{}' check (cardinality(job_ids) <= 20),
  crp_months           text[] not null default '{}' check (cardinality(crp_months) <= 20),
  ise                  text not null default '' check (char_length(ise) <= 200),
  crm                  text not null default '' check (char_length(crm) <= 200),
  master_final_status  text not null default '' check (char_length(master_final_status) <= 200),
  master_stage         text not null default '' check (char_length(master_stage) <= 200),
  drive_modified_at    timestamptz,
  last_read_at         timestamptz,
  last_tried_at        timestamptz,
  read_error           text check (read_error is null or char_length(read_error) <= 500),
  tabs_read            integer not null default 0 check (tabs_read >= 0),
  academy_rows         integer not null default 0 check (academy_rows >= 0),
  listed_at            timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table app.company_sheets is 'Company sheets from the CRPs master (">8 LPA Companies"), and the hourly sync''s state per sheet.';
create index company_sheets_unreadable_idx on app.company_sheets (listed_at) where read_error is not null;

create table app.company_shares (
  id             bigint generated always as identity primary key,
  sheet_id       text not null references app.company_sheets (sheet_id) on delete cascade,
  tab            text not null check (char_length(tab) between 1 and 200),
  tab_gid        integer,
  uid            text not null references app.pool_candidates (uid) on delete cascade,
  phone          text check (phone is null or phone ~ '^[0-9]{10}$'),
  company        text not null check (char_length(company) <= 200),
  role           text not null default '' check (char_length(role) <= 200),
  rounds         jsonb not null default '[]'::jsonb check (case when jsonb_typeof(rounds) = 'array' then jsonb_array_length(rounds) <= 20 else false end),
  final_status   text not null default '' check (char_length(final_status) <= 200),
  stage          text not null default '' check (char_length(stage) <= 200),
  outcome        text not null default 'unknown' check (outcome in ('selected', 'rejected', 'in_process', 'on_hold', 'no_show', 'unknown')),
  hash           text not null check (char_length(hash) between 8 and 64),
  baseline       boolean not null default false,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  changed_at     timestamptz not null default now(),
  outcome_at     timestamptz,
  removed_at     timestamptz,
  unique (sheet_id, tab, uid)
);
comment on table app.company_shares is 'Academy assessed candidates in company sheets: rounds, final status, stage and outcome per (sheet, tab, candidate). Nobody else is stored.';
create index company_shares_uid_idx on app.company_shares (uid) where removed_at is null;
create index company_shares_first_seen_idx on app.company_shares (first_seen_at) where removed_at is null and not baseline;
create index company_shares_selected_idx on app.company_shares (outcome_at) where outcome = 'selected' and removed_at is null;
create index company_shares_removed_idx on app.company_shares (removed_at) where removed_at is not null;

create table app.company_share_syncs (
  id              bigint generated always as identity primary key,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  sheets_checked  integer not null default 0 check (sheets_checked >= 0),
  sheets_read     integer not null default 0 check (sheets_read >= 0),
  rows_matched    integer not null default 0 check (rows_matched >= 0),
  changes         integer not null default 0 check (changes >= 0),
  errors          integer not null default 0 check (errors >= 0),
  pushed          integer not null default 0 check (pushed >= 0),
  error           text check (error is null or char_length(error) <= 500),
  triggered_by    text not null check (char_length(triggered_by) <= 120)
);
create index company_share_syncs_started_idx on app.company_share_syncs (started_at desc);

create table app.pool_interview_marks (
  prep_key    text primary key check (prep_key ~ '^[0-9a-f]{24}$'),
  uid         text not null,
  day         date not null,
  time_key    text not null default '' check (char_length(time_key) <= 40),
  seen_at     timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table app.pool_interview_marks is 'Drill-down interviews of Academy assessed candidates already notified (pool_interview): day and time. No PII.';
create index pool_interview_marks_day_idx on app.pool_interview_marks (day);

create table app.sync_marks (
  name  text primary key check (char_length(name) between 1 and 80),
  at    timestamptz not null default now()
);
comment on table app.sync_marks is 'First-run (baseline) markers of the server''s syncs: a job''s first run records and does not notify.';

alter table app.company_sheets       enable row level security;
alter table app.company_shares       enable row level security;
alter table app.company_share_syncs  enable row level security;
alter table app.pool_interview_marks enable row level security;
alter table app.sync_marks           enable row level security;

select cron.schedule(
  'psm-academy-shares-retention',
  '37 3 * * *',
  $$
    delete from app.company_shares where removed_at < now() - interval '400 days';
    delete from app.company_share_syncs where started_at < now() - interval '60 days';
    delete from app.pool_interview_marks where day < current_date - 30;
    delete from app.company_sheets s
     where s.listed_at < now() - interval '400 days'
       and not exists (select 1 from app.company_shares x where x.sheet_id = s.sheet_id);
  $$
);
