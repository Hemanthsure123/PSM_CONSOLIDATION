-- 010 — Prep kit: the team Google account, prep documents, meetings, prep call recordings,
-- messages and an audit log (docs/mobile-api.yaml, /preps/* and /team/*).
--
-- app.integrations      the team Google account (GOOGLE_WORKSPACE_ACCOUNT) connected once by an
--                       admin: its refresh token, AES-256-GCM encrypted by the server. Every prep
--                       document, Meet link, invite and email is created as this account.
-- app.prep_documents    one prep document per job (or company) + round + kind (Google Doc /
--                       Notion page): its link, the sources it was built from (with their
--                       last-change times, to tell when it is out of date) and the sections.
-- app.prep_doc_runs     each create / update request and its progress (generation takes a minute).
-- app.meetings          prep / guidance / mock / custom meetings: the calendar event, the Meet
--                       link, attendees, the invite email, and — after it ends — recording,
--                       transcript, summary and the real duration from Meet.
-- app.call_recordings   prep phone calls recorded by the phone itself, uploaded by the app:
--                       duration from the file, transcript, summary, where it was saved.
-- app.communications    every email / WhatsApp hand-off the app made, with its status.
-- app.audit_log         who did what (documents, meetings, emails, recordings opened).
--
-- Closed like the rest of app.* (RLS on, no anon / authenticated access).

create table app.integrations (
  provider          text primary key check (provider in ('google_team')),
  account_email     text not null,
  refresh_token_enc text not null,
  scopes            text[] not null default '{}',
  status            text not null default 'connected' check (status in ('connected', 'broken')),
  last_error        text,
  connected_by      text not null,
  connected_at      timestamptz not null default now(),
  last_ok_at        timestamptz
);

create table app.prep_documents (
  id               uuid primary key default gen_random_uuid(),
  job_key          text not null,
  company          text not null default '',
  round            text not null default '',
  round_key        text not null default '',
  kind             text not null check (kind in ('gdoc', 'notion')),
  external_id      text not null,
  url              text not null,
  title            text not null default '',
  version          integer not null default 1,
  sources          jsonb not null default '[]',
  sections         text[] not null default '{}',
  inputs           jsonb not null default '{}',
  last_changes     jsonb not null default '[]',
  unverified       jsonb not null default '[]',
  content          jsonb,
  created_by       text not null,
  updated_by       text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (job_key, round_key, kind)
);
create index prep_documents_job_idx on app.prep_documents (job_key);

create table app.prep_doc_runs (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid references app.prep_documents (id) on delete set null,
  job_key       text not null,
  round_key     text not null default '',
  kind          text not null check (kind in ('gdoc', 'notion')),
  mode          text not null check (mode in ('create', 'update')),
  status        text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  step          text not null default '',
  error         text,
  request       jsonb not null default '{}',
  result        jsonb,
  requested_by  text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index prep_doc_runs_job_idx on app.prep_doc_runs (job_key, created_at desc);

create table app.meetings (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null check (kind in ('prep', 'guidance', 'mock', 'custom')),
  title               text not null,
  prep_key            text,
  job_key             text,
  company             text not null default '',
  starts_at           timestamptz not null,
  ends_at             timestamptz not null,
  calendar_event_id   text,
  meet_space          text,
  meet_code           text,
  meet_url            text,
  record              boolean not null default true,
  recording_on        boolean,
  attendees           jsonb not null default '[]',
  status              text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
  email_subject       text not null default '',
  email_body          text not null default '',
  email_status        text not null default 'none' check (email_status in ('none', 'scheduled', 'sent', 'failed')),
  email_send_at       timestamptz,
  email_sent_at       timestamptz,
  email_error         text,
  conference_record   text,
  recording_file_id   text,
  recording_url       text,
  transcript_url      text,
  transcript_text     text,
  summary             jsonb,
  duration_sec        integer,
  artifacts_status    text not null default 'pending' check (artifacts_status in ('pending', 'ready', 'none', 'failed')),
  artifacts_checked_at timestamptz,
  reminded_at         timestamptz,
  created_by          text not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index meetings_prep_idx on app.meetings (prep_key);
create index meetings_starts_idx on app.meetings (starts_at);
create index meetings_email_due_idx on app.meetings (email_send_at) where email_status = 'scheduled';

create table app.call_recordings (
  id               uuid primary key default gen_random_uuid(),
  prep_key         text not null,
  mentor_email     text not null,
  device_key       text not null unique,
  call_at          timestamptz not null,
  duration_sec     integer not null check (duration_sec >= 0),
  file_name        text not null default '',
  drive_file_id    text,
  drive_url        text,
  transcript_url   text,
  transcript_text  text,
  summary          jsonb,
  status           text not null default 'uploaded' check (status in ('uploaded', 'transcribing', 'summarising', 'ready', 'failed')),
  error            text,
  attempts         integer not null default 0,
  sheet_written_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index call_recordings_prep_idx on app.call_recordings (prep_key);
create index call_recordings_mentor_idx on app.call_recordings (mentor_email, call_at desc);

create table app.communications (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  channel     text not null check (channel in ('email', 'whatsapp')),
  purpose     text not null,
  prep_key    text,
  meeting_id  uuid references app.meetings (id) on delete set null,
  to_address  text not null default '',
  status      text not null check (status in ('pending', 'sent', 'failed', 'opened')),
  error       text,
  created_by  text not null
);
create index communications_prep_idx on app.communications (prep_key, at desc);

create table app.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_email text not null,
  action      text not null,
  target      text not null default '',
  detail      jsonb not null default '{}'
);
create index audit_log_at_idx on app.audit_log (at desc);

alter table app.integrations    enable row level security;
alter table app.prep_documents  enable row level security;
alter table app.prep_doc_runs   enable row level security;
alter table app.meetings        enable row level security;
alter table app.call_recordings enable row level security;
alter table app.communications  enable row level security;
alter table app.audit_log       enable row level security;
