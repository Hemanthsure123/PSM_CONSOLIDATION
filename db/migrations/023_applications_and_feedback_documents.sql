-- 023 — Applications and candidate feedback documents (PSM 1.13.0).
--
-- app.crp_requirements        + internal_sheet_id: the CRPs master's "Internal sheet Link" (the sheet with
--                               the platform's applicant export and application forms for that job).
-- app.company_shares          + resume_url: the resume link in the company-sheet row (what the company got).
-- app.internal_sheets         one row per internal sheet listed in the master: its company, the job ids that
--                               list it, and the hourly sync's state (Drive modifiedTime at the last read, last
--                               read / try, the read error the admin screen lists, and read_via: the service
--                               account, or the team Google account for sheets shared only inside the org).
-- app.job_applications        one row per (internal sheet, Academy assessed candidate, job id): when they
--                               applied (the export's Applied Datetime / the form's Timestamp, as India time),
--                               the resume they applied with, and whether it came from the platform export or a
--                               Google Form. Only rows matched to the pool (UID, then phone, then email) are
--                               stored: nobody else's data ever is. removed_at = no longer in the sheet.
-- app.candidate_feedback_docs one "Resume Rejection Analysis" Google Doc per (candidate, period): where it is
--                               (team Drive), what it was built from (content: the facts and checks, for audit
--                               and the app's counts / notes), its version (a rebuild rewrites the same Doc),
--                               and the review / share trail (draft → reviewed → shared).
-- app.candidate_feedback_runs each build request and its progress (about a minute); one active run per
--                               candidate.
-- app.application_reviews     per Academy assessed candidate and job: applied / sent / company decision, the
--                               main reason and the resume read behind it — imported from a reviewed analysis
--                               (the November Academy review) or written by the server when it reviews a resume.
-- app.job_comparisons         per job, counts of what the candidates the company took forward had (internship,
--                               links, relevant project, every must-have): no names, no phones.
-- app.crp_requirements        + id_month / id_year: the CRPs master's "ID Month" (a period = the jobs whose CRP
--                               month is in it, and the jobs whose ID was done in it).
-- app.pool_events             action 'feedback_doc' (built / reviewed / sent) in the candidate's history.
--
-- Idempotent. Code deployed before this migration keeps working: it checks for these tables / columns and
-- leaves the applications sync and feedback documents off until they exist. Closed to the anon /
-- authenticated roles like the other app tables (RLS on, no policies): only the server reads and writes
-- them. Retention by pg_cron (011).

alter table app.crp_requirements add column if not exists internal_sheet_id text;
-- "ID Month" as typed and its year (fixed the first time the month is seen, like crp_year): a period
-- covers the jobs whose CRP month is in it and the jobs whose ID was done in it.
alter table app.crp_requirements add column if not exists id_month text not null default '';
alter table app.crp_requirements add column if not exists id_year integer;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'crp_requirements_id_month_check') then
    alter table app.crp_requirements add constraint crp_requirements_id_month_check
      check (char_length(id_month) <= 40 and (id_year is null or id_year between 2020 and 2100));
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'crp_requirements_internal_sheet_id_check') then
    alter table app.crp_requirements add constraint crp_requirements_internal_sheet_id_check
      check (internal_sheet_id is null or internal_sheet_id ~ '^[A-Za-z0-9_-]{20,100}$');
  end if;
end $$;
create index if not exists crp_requirements_internal_idx on app.crp_requirements (internal_sheet_id) where internal_sheet_id is not null;

alter table app.company_shares add column if not exists resume_url text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'company_shares_resume_url_check') then
    alter table app.company_shares add constraint company_shares_resume_url_check
      check (resume_url is null or (char_length(resume_url) <= 1000 and resume_url ~* '^https?://'));
  end if;
end $$;

create table if not exists app.internal_sheets (
  sheet_id           text primary key check (sheet_id ~ '^[A-Za-z0-9_-]{20,100}$'),
  company            text not null default '' check (char_length(company) <= 200),
  job_ids            text[] not null default '{}' check (cardinality(job_ids) <= 40),
  drive_modified_at  timestamptz,
  last_read_at       timestamptz,
  last_tried_at      timestamptz,
  read_error         text check (read_error is null or char_length(read_error) <= 500),
  read_via           text check (read_via is null or read_via in ('service_account', 'team')),
  tabs_read          integer not null default 0 check (tabs_read >= 0),
  academy_rows       integer not null default 0 check (academy_rows >= 0),
  listed_at          timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on table app.internal_sheets is 'Internal sheets from the CRPs master ("Internal sheet Link"): applicant exports and application forms; the hourly sync''s state per sheet.';
create index if not exists internal_sheets_unreadable_idx on app.internal_sheets (listed_at) where read_error is not null;

create table if not exists app.job_applications (
  id             bigint generated always as identity primary key,
  sheet_id       text not null references app.internal_sheets (sheet_id) on delete cascade,
  tab            text not null check (char_length(tab) between 1 and 200),
  tab_gid        integer,
  uid            text not null references app.pool_candidates (uid) on delete cascade,
  job_id         text not null check (char_length(job_id) between 1 and 80),
  phone          text check (phone is null or phone ~ '^[0-9]{10}$'),
  source         text not null check (source in ('portal', 'form')),
  applied_at     timestamptz,
  resume_url     text check (resume_url is null or (char_length(resume_url) <= 1000 and resume_url ~* '^https?://')),
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  removed_at     timestamptz,
  unique (sheet_id, uid, job_id)
);
comment on table app.job_applications is 'Academy assessed candidates'' applications read from internal sheets (platform export / application forms): job id, when, resume used. Nobody else is stored.';
create index if not exists job_applications_uid_idx on app.job_applications (uid) where removed_at is null;
create index if not exists job_applications_job_idx on app.job_applications (job_id) where removed_at is null;
create index if not exists job_applications_removed_idx on app.job_applications (removed_at) where removed_at is not null;

create table if not exists app.candidate_feedback_docs (
  id            uuid primary key default gen_random_uuid(),
  uid           text not null references app.pool_candidates (uid) on delete cascade,
  period_from   date not null,
  period_to     date not null,
  candidate     text not null default '' check (char_length(candidate) <= 200),
  external_id   text not null check (char_length(external_id) between 10 and 200),
  url           text not null check (char_length(url) <= 500),
  title         text not null check (char_length(title) between 1 and 300),
  version       integer not null default 1 check (version >= 1),
  content       jsonb not null,
  status        text not null default 'draft' check (status in ('draft', 'reviewed', 'shared')),
  reviewed_by   text check (reviewed_by is null or char_length(reviewed_by) <= 254),
  reviewed_at   timestamptz,
  shared_by     text check (shared_by is null or char_length(shared_by) <= 254),
  shared_at     timestamptz,
  share_count   integer not null default 0 check (share_count >= 0),
  created_by    text not null check (char_length(created_by) <= 254),
  updated_by    text not null check (char_length(updated_by) <= 254),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (period_to >= period_from and period_to - period_from <= 400),
  unique (uid, period_from, period_to)
);
comment on table app.candidate_feedback_docs is 'Resume Rejection Analysis Google Docs: one per pool candidate and period; content = the facts it was built from; draft → reviewed → shared.';
create index if not exists candidate_feedback_docs_uid_idx on app.candidate_feedback_docs (uid, period_from desc);

create table if not exists app.candidate_feedback_runs (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid references app.candidate_feedback_docs (id) on delete set null,
  uid           text not null references app.pool_candidates (uid) on delete cascade,
  period_from   date not null,
  period_to     date not null,
  mode          text not null check (mode in ('create', 'update')),
  status        text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  step          text not null default '' check (char_length(step) <= 200),
  error         text check (error is null or char_length(error) <= 600),
  result        jsonb,
  requested_by  text not null check (char_length(requested_by) <= 254),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists candidate_feedback_runs_uid_idx on app.candidate_feedback_runs (uid, created_at desc);
-- One active build per candidate: a double tap (or two mentors at once) can't write two documents.
create unique index if not exists candidate_feedback_runs_one_active_idx on app.candidate_feedback_runs (uid) where status in ('queued', 'running');

-- What was found about each application, kept for the feedback documents and for later analyses:
-- imported from a reviewed analysis (source 'review-2026-11': the November Academy review — resume reads
-- checked twice where they mattered, rejection reasons, assignment reviews) or written by the server
-- itself when it reviews a resume for a document (source 'live'). Academy assessed candidates only.
create table if not exists app.application_reviews (
  id                bigint generated always as identity primary key,
  source            text not null check (source ~ '^[a-z0-9][a-z0-9._-]{1,40}$'),
  uid               text not null references app.pool_candidates (uid) on delete cascade,
  job_id            text not null check (char_length(job_id) between 1 and 80),
  applied           boolean,
  sent              boolean,
  decision          text check (decision is null or decision in ('selected', 'rejected')),
  primary_reason    text not null default '' check (char_length(primary_reason) <= 200),
  reasons           text[] not null default '{}' check (cardinality(reasons) <= 20),
  details           text[] not null default '{}' check (cardinality(details) <= 20),
  read              jsonb not null default '{}'::jsonb,
  screening         text not null default '' check (char_length(screening) <= 80),
  resume_url        text check (resume_url is null or char_length(resume_url) <= 1000),
  checked           text not null default '' check (char_length(checked) <= 160),
  assignment        jsonb,
  provenance        text not null default '' check (char_length(provenance) <= 300),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (source, uid, job_id)
);
comment on table app.application_reviews is 'Per Academy assessed candidate and job: applied / sent / company decision, the main reason and the resume read behind it (imported reviews and the server''s own).';
create index if not exists application_reviews_uid_idx on app.application_reviews (uid);
create index if not exists application_reviews_job_idx on app.application_reviews (job_id);

-- How the candidates a company took forward compared, per job: counts only (no names, no phones; from
-- every pool, Academy or not), so a document can say what most of the selected candidates had.
create table if not exists app.job_comparisons (
  source           text not null check (source ~ '^[a-z0-9][a-z0-9._-]{1,40}$'),
  job_id           text not null check (char_length(job_id) between 1 and 80),
  selected         integer not null check (selected >= 0),
  with_internship  integer not null check (with_internship >= 0),
  with_links       integer not null check (with_links >= 0),
  with_project     integer not null check (with_project >= 0),
  all_must_haves   integer not null check (all_must_haves >= 0),
  fit_avg          numeric(3, 2),
  computed_at      timestamptz not null default now(),
  primary key (source, job_id)
);
comment on table app.job_comparisons is 'Per job: how many of the candidates the company took forward had a same-field internship, links to their work, a relevant project and every must-have skill. Counts only.';

-- The candidate's history gets 'feedback_doc' (built / reviewed / sent).
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'app.pool_events'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%action%'
       and pg_get_constraintdef(oid) not ilike '%feedback_doc%'
  loop
    execute format('alter table app.pool_events drop constraint %I', c);
  end loop;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'app.pool_events'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%feedback_doc%'
  ) then
    alter table app.pool_events add constraint pool_events_action_check
      check (action in ('priority', 'track', 'tags', 'resume_added', 'resume_updated', 'resume_removed', 'meeting', 'call', 'whatsapp', 'email', 'feedback_doc'));
  end if;
end $$;

alter table app.internal_sheets         enable row level security;
alter table app.job_applications        enable row level security;
alter table app.application_reviews     enable row level security;
alter table app.job_comparisons         enable row level security;
alter table app.candidate_feedback_docs enable row level security;
alter table app.candidate_feedback_runs enable row level security;

select cron.schedule(
  'psm-applications-feedback-retention',
  '41 3 * * *',
  $$
    delete from app.job_applications where removed_at < now() - interval '400 days';
    delete from app.candidate_feedback_runs where created_at < now() - interval '30 days';
    delete from app.internal_sheets s
     where s.listed_at < now() - interval '400 days'
       and not exists (select 1 from app.job_applications x where x.sheet_id = s.sheet_id);
  $$
);
