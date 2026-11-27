-- 022 — Companies, share status and tentative process starts (PSM 1.12.0).
--
-- app.company_shares     + status: the candidate's own status in that tab as computed at the last
--                          read with the current rules (selected / rejected / no_show / on_hold /
--                          in_process / awaiting / closed / shared). The requirement's state (the
--                          CRPs master) is applied when read, so it is never stale. Null for rows read
--                          before this migration: the server works it out again from the rounds.
-- app.crp_requirements   every requirement row of the CRPs master (">8 LPA Companies", tab CRPs), with
--                          or without a company sheet: role, job id, CRP month / week (crp_year is
--                          fixed the first time a month is seen, so "Nov" stays Nov 2026 years later),
--                          openings, CTC as typed, the master's Final Status / Current Stage / Company
--                          ID Status, the Academy counts typed by the team (total, assessed,
--                          non-assessed), JD link, HubSpot deal. Rewritten from the master every hour;
--                          rows that left the master are deleted (their tentative starts stay).
-- app.hubspot_deals      the HubSpot deals the master links to: the JD link and the Nurturing Team
--                          Remarks, read with GET only (never written), refreshed at most daily.
-- app.requirement_starts the tentative start date of a requirement's process, set in the app or by
--                          importing the exported Excel file; shown in the Calendar. Keeps the job id,
--                          company, role and CRP month, so a date finds its requirement again if the
--                          master row is edited.
--
-- Idempotent. Code deployed before this migration keeps working: it checks for these tables and
-- leaves Companies off until they exist. Closed to the anon / authenticated roles like the other
-- app tables (RLS on, no policies): only the server reads and writes them.

alter table app.company_shares add column if not exists status text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'company_shares_status_check') then
    alter table app.company_shares add constraint company_shares_status_check
      check (status is null or status in ('selected', 'rejected', 'no_show', 'on_hold', 'in_process', 'awaiting', 'closed', 'shared'));
  end if;
end $$;

create table if not exists app.crp_requirements (
  key                text primary key check (key ~ '^[0-9a-f]{24}$'),
  row_index          integer not null check (row_index >= 2),
  sheet_id           text check (sheet_id is null or sheet_id ~ '^[A-Za-z0-9_-]{20,100}$'),
  company            text not null check (char_length(company) between 1 and 200),
  role               text not null default '' check (char_length(role) <= 200),
  job_id             text not null default '' check (char_length(job_id) <= 80),
  job_type           text not null default '' check (char_length(job_type) <= 80),
  crp_month          text not null default '' check (char_length(crp_month) <= 40),
  crp_year           integer check (crp_year is null or crp_year between 2020 and 2100),
  crp_week           integer check (crp_week is null or crp_week between 1 and 6),
  openings           integer check (openings is null or openings between 0 and 100000),
  ctc_text           text not null default '' check (char_length(ctc_text) <= 80),
  final_status       text not null default '' check (char_length(final_status) <= 200),
  stage              text not null default '' check (char_length(stage) <= 200),
  id_status          text not null default '' check (char_length(id_status) <= 200),
  academy_sent       integer check (academy_sent is null or academy_sent between 0 and 100000),
  assessed_sent      integer check (assessed_sent is null or assessed_sent between 0 and 100000),
  non_assessed_sent  integer check (non_assessed_sent is null or non_assessed_sent between 0 and 100000),
  requested          text not null default '' check (char_length(requested) <= 200),
  tech_stack         text not null default '' check (char_length(tech_stack) <= 200),
  pass_out           text not null default '' check (char_length(pass_out) <= 80),
  interview_process  text not null default '' check (char_length(interview_process) <= 200),
  ise                text not null default '' check (char_length(ise) <= 80),
  crm                text not null default '' check (char_length(crm) <= 80),
  jd_url             text check (jd_url is null or char_length(jd_url) <= 2000),
  hubspot_url        text check (hubspot_url is null or char_length(hubspot_url) <= 2000),
  hubspot_deal_id    text check (hubspot_deal_id is null or hubspot_deal_id ~ '^[0-9]{3,20}$'),
  first_listed_at    timestamptz not null default now(),
  listed_at          timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on table app.crp_requirements is 'Requirement rows of the CRPs master (">8 LPA Companies"), as typed; rewritten hourly by the company-sheet sync.';
create index if not exists crp_requirements_sheet_idx on app.crp_requirements (sheet_id) where sheet_id is not null;
create index if not exists crp_requirements_job_idx on app.crp_requirements (job_id) where job_id <> '';

create table if not exists app.hubspot_deals (
  deal_id      text primary key check (deal_id ~ '^[0-9]{3,20}$'),
  deal_name    text not null default '' check (char_length(deal_name) <= 300),
  jd_url       text check (jd_url is null or char_length(jd_url) <= 2000),
  remarks      text check (remarks is null or char_length(remarks) <= 10000),
  http_status  integer,
  error        text check (error is null or char_length(error) <= 300),
  fetched_at   timestamptz not null default now()
);
comment on table app.hubspot_deals is 'HubSpot deals linked from the CRPs master: JD link and Nurturing Team Remarks, read with GET only.';

create table if not exists app.requirement_starts (
  key         text primary key check (key ~ '^[0-9a-f]{24}$'),
  job_id      text not null default '' check (char_length(job_id) <= 80),
  company     text not null default '' check (char_length(company) <= 200),
  role        text not null default '' check (char_length(role) <= 200),
  crp_month   text not null default '' check (char_length(crp_month) <= 40),
  start_date  date not null check (start_date between date '2020-01-01' and date '2100-12-31'),
  set_by      text not null check (char_length(set_by) between 3 and 254),
  set_at      timestamptz not null default now(),
  source      text not null default 'app' check (source in ('app', 'import'))
);
comment on table app.requirement_starts is 'Tentative start date of a requirement''s process (app or Excel import); shown in the Calendar.';
create index if not exists requirement_starts_date_idx on app.requirement_starts (start_date);

alter table app.crp_requirements   enable row level security;
alter table app.hubspot_deals      enable row level security;
alter table app.requirement_starts enable row level security;
