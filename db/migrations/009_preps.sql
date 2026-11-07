-- 009 — Interview preps for the app's Calendar (docs/mobile-api.yaml, /preps).
--
-- The "Edge Team drill down" tab of the EDGE sheet stays the source of truth (who preps whom,
-- whether it was given, the candidate's status). The sheet only has a "Date of entry" day, not a
-- time, so the server records when it first saw each row: that instant starts the prep SLA
-- (45 minutes for an interview on the next day or sooner). No candidate details are stored here:
-- a row is known by a hash of its candidate phone + job + round.
--
-- app.prep_rows    one row per drill-down row ever seen: first seen (SLA start), whether it was
--                  already there when tracking began (baseline: no SLA), its mentor(s) as matched
--                  to the roster, and when the server first saw the prep given.
-- app.prep_events  what people did from the app (prep marked, interview status, assignment), for
--                  the audit trail and on-time numbers.

create table app.prep_rows (
  key             text primary key check (key ~ '^[0-9a-f]{24}$'),
  first_seen_at   timestamptz not null default now(),
  baseline        boolean not null default false,
  sheet_row       integer not null,
  company         text not null default '',
  interview_day   date,
  due_at          timestamptz,
  mentor_emails   text[] not null default '{}',
  assigned_at     timestamptz,
  prep_status     text not null default 'pending',
  done_at         timestamptz,
  last_seen_at    timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table app.prep_rows is 'Drill-down rows the app tracks: SLA start (first seen) and mentor matching. No candidate PII.';
create index prep_rows_interview_idx on app.prep_rows (interview_day);
create index prep_rows_mentors_idx on app.prep_rows using gin (mentor_emails);

create table app.prep_events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  prep_key    text not null,
  actor_email text not null,
  action      text not null check (action in ('prep_status', 'interview_status', 'assign')),
  value       text not null default ''
);
create index prep_events_key_idx on app.prep_events (prep_key, at desc);
create index prep_events_actor_idx on app.prep_events (actor_email, at desc);

alter table app.prep_rows   enable row level security;
alter table app.prep_events enable row level security;
