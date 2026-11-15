-- RSA (Rejection Selection Analysis) documents: after an RSA call with a candidate about an
-- interview, the app builds a short Google Doc from the drill-down, the call recording, the resume
-- the company has, and the team's remarks. One document per prep (candidate + job + round): an
-- update rewrites the same document (same link) and never adds a second row to the RSA sheet.
--
-- app.rsa_documents   the document and the inputs it was last built from. The call transcript is
--                     kept as a file in the team Drive (next to the recording), never here.
-- app.rsa_runs        each create / update request and its progress (about a minute).

create table app.rsa_documents (
  id                uuid primary key default gen_random_uuid(),
  prep_key          text not null unique check (prep_key ~ '^[0-9a-f]{24}$'),
  candidate         text not null default '' check (char_length(candidate) <= 200),
  phone             text not null default '' check (phone ~ '^([0-9]{10})?$'),
  uid               text check (uid is null or char_length(uid) <= 100),
  company           text not null default '' check (char_length(company) <= 300),
  round             text not null default '' check (char_length(round) <= 100),
  job_key           text not null default '',
  round_key         text not null default '',
  product           text not null default '' check (char_length(product) <= 100),
  drilldown_url     text not null check (char_length(drilldown_url) <= 500),
  drilldown_tabs    text[] not null default '{}',
  resume_url        text not null check (char_length(resume_url) <= 1000),
  remarks           text not null default '' check (char_length(remarks) <= 4000),
  recording_file_id text not null,
  recording_url     text not null default '',
  transcript_file_id text,
  external_id       text not null,
  url               text not null,
  title             text not null check (char_length(title) <= 300),
  version           integer not null default 1 check (version >= 1),
  content           jsonb not null,
  sheet_status      text not null default 'pending' check (sheet_status in ('pending', 'added', 'exists', 'failed')),
  sheet_error       text,
  created_by        text not null,
  updated_by        text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index rsa_documents_phone_idx on app.rsa_documents (phone) where phone <> '';
create index rsa_documents_job_round_idx on app.rsa_documents (job_key, round_key);

create table app.rsa_runs (
  id            uuid primary key default gen_random_uuid(),
  rsa_id        uuid references app.rsa_documents (id) on delete set null,
  prep_key      text not null check (prep_key ~ '^[0-9a-f]{24}$'),
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
create index rsa_runs_prep_idx on app.rsa_runs (prep_key, created_at desc);
-- One active run per prep: a double tap (or two team members at once) can't write two documents.
create unique index rsa_runs_one_active_idx on app.rsa_runs (prep_key) where status in ('queued', 'running');

alter table app.rsa_documents enable row level security;
alter table app.rsa_runs      enable row level security;

select cron.schedule(
  'psm-rsa-runs-retention',
  '53 3 * * *',
  $$ delete from app.rsa_runs where created_at < now() - interval '30 days'; $$
);
