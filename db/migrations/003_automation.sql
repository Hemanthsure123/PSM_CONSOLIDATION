-- 003 — Sheet-triggered shortlisting automation (docs/automation.md).
--
-- jobs           one row per run: where it was triggered, the plan, status, step (checkpoint),
--                lease (which worker holds it, until when), result.
-- job_requests   every trigger ("start") that reached the server → its job. A repeated
--                request id returns the same job (idempotency).
-- job_events     what happened, step by step (audit, troubleshooting).
-- job_candidates one row per candidate read for a job: the row as read, the screening result,
--                GitHub / review results. The checkpoint that lets a restarted worker continue
--                without redoing finished candidates.

create schema if not exists automation;
revoke all on schema automation from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema automation from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on schema automation from authenticated'; end if;
end $$;

create type automation.job_status as enum ('pending', 'processing', 'completed', 'failed', 'awaiting_review');

create table automation.jobs (
  id                     uuid primary key default gen_random_uuid(),
  spreadsheet_id         text not null,
  control_tab            text not null,
  control_row            integer not null check (control_row > 0),
  instructions           text not null,
  -- sha256 of the instructions, the candidates' sheet and the requested count: a failed job
  -- re-triggered with the same inputs resumes instead of starting over.
  inputs_hash            text not null,
  internal_sheet_url     text not null default '',
  profiles_required      text not null default '',
  company_name           text not null default '',
  status                 automation.job_status not null default 'pending',
  step                   text not null default 'queued',
  progress               jsonb not null default '{}'::jsonb,
  plan                   jsonb,
  result                 jsonb,
  error                  text,
  attempts               integer not null default 0,
  lease_owner            text,
  lease_until            timestamptz,
  -- The date in India when the job first started processing: its destination tab's date.
  run_date               date,
  created_at             timestamptz not null default now(),
  started_at             timestamptz,
  finished_at            timestamptz,
  updated_at             timestamptz not null default now()
);
comment on table automation.jobs is 'Sheet-triggered shortlisting runs. Status is what the sheet shows.';

-- At most one active job per control row (a second "start" while one runs is refused).
create unique index jobs_one_active_per_row on automation.jobs (spreadsheet_id, control_tab, control_row)
  where status in ('pending', 'processing');
create index jobs_claimable_idx on automation.jobs (created_at) where status in ('pending', 'processing');
create index jobs_row_idx on automation.jobs (spreadsheet_id, control_tab, control_row, created_at desc);

create table automation.job_requests (
  request_id  text primary key check (char_length(request_id) between 8 and 80),
  job_id      uuid not null references automation.jobs (id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table automation.job_events (
  id       bigint generated always as identity primary key,
  job_id   uuid not null references automation.jobs (id) on delete cascade,
  at       timestamptz not null default now(),
  step     text not null,
  level    text not null check (level in ('info', 'warn', 'error')),
  message  text not null
);
create index job_events_job_idx on automation.job_events (job_id, id);

create table automation.job_candidates (
  job_id        uuid not null references automation.jobs (id) on delete cascade,
  key           text not null,                 -- "<tab>!<row>" in the candidates' sheet
  ord           integer not null,              -- read order (assessed people first)
  source_tab    text not null,
  source_row    integer not null,
  row_data      jsonb not null,                -- the row as read (DomainCandidateRow)
  internal      jsonb,                         -- the eligible-pool standing at read time
  state         text not null default 'pending' check (state in ('pending', 'screened', 'invalid', 'error', 'duplicate')),
  candidate     jsonb,                         -- the screened candidate, then with GitHub / review
  github_state  text not null default 'none' check (github_state in ('none', 'pending', 'done')),
  review_state  text not null default 'none' check (review_state in ('none', 'pending', 'done')),
  error         text,
  retryable     boolean not null default false,
  attempts      integer not null default 0,
  next_try_at   timestamptz,
  duplicate_of  text,
  updated_at    timestamptz not null default now(),
  primary key (job_id, key)
);
create index job_candidates_todo_idx on automation.job_candidates (job_id, ord) where state in ('pending', 'error');

alter table automation.jobs           enable row level security;
alter table automation.job_requests   enable row level security;
alter table automation.job_events     enable row level security;
alter table automation.job_candidates enable row level security;
