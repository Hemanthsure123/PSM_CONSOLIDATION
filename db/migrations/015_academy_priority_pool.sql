-- 015 — Academy priority pool (mentors' own candidates) and the in-app notification inbox.
--
-- Source: the Academy sheet "Assessed Pool_8+ LPA", tab "> 8LPA Assessed Pool". The sheet is read
-- only; the server copies ONLY these columns, and only rows whose MENTOR cell is filled:
--   UID, YOG, Name, Email Address, StudentNumber, Location/State, Bachelor's College Name,
--   Bachelor's Course Name, Bachelor's Specialization, TechStack, MENTOR.
-- Assessment marks come from placement.* (matched by UID = placement.candidates.user_id, then
-- phone); interviews from the EDGE drill-down tab (matched by phone), read live, never copied.
--
-- app.pool_candidates  the sheet snapshot (one row per UID). The sync rewrites a row only when its
--                      row_hash changed. A row that leaves the tab, or whose MENTOR is cleared, gets
--                      removed_at (kept with everything mentors added); it comes back if re-added.
--                      The mentor is stored as the sheet's name; it is matched to the roster when
--                      read, so a mentor added to the team later (e.g. "Asif") sees their candidates
--                      at once, with no re-sync.
-- app.pool_state       what mentors decide in the app: track (one of the four), priority P0–P3, tech
--                      stack tags. Never written by the sync. version = optimistic concurrency.
-- app.pool_resumes     updated resumes a mentor collected: one tech stack each, at most one "best"
--                      per candidate and stack. Files live in the team Google Drive; a removed
--                      resume is hidden (deleted_at), never destroyed.
-- app.pool_events      the history of each candidate (priority / track / tags changes, resumes,
--                      meetings, calls and WhatsApp messages) — who did what, and when.
-- app.pool_syncs       one row per sync of the tab (counts, row problems), kept 30 days.
-- app.meetings         + pool_uids: the pool candidates a mock interview / guidance meet is for.
-- app.notifications    + title, body, data, read_at: the app's notification inbox (bell icon).

create table app.pool_candidates (
  uid               text primary key check (uid ~ '^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$'),
  name              text not null default '' check (char_length(name) <= 200),
  email             text check (email is null or (email = lower(email) and char_length(email) <= 254)),
  phone             char(10) check (phone is null or phone ~ '^[0-9]{10}$'),
  yog               smallint check (yog is null or yog between 2000 and 2100),
  location          text check (location is null or char_length(location) <= 120),
  college           text check (college is null or char_length(college) <= 300),
  course            text check (course is null or char_length(course) <= 160),
  specialization    text check (specialization is null or char_length(specialization) <= 160),
  sheet_tech_stack  text check (sheet_tech_stack is null or char_length(sheet_tech_stack) <= 120),
  sheet_track       text check (sheet_track is null or sheet_track in ('frontend', 'backend', 'fullstack', 'aiml')),
  mentor_name       text not null check (char_length(mentor_name) between 1 and 80),
  sheet_row         integer not null check (sheet_row > 0),
  row_hash          text not null,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  removed_at        timestamptz
);
comment on table app.pool_candidates is 'Academy priority pool: the sheet''s mentored rows (only the agreed columns). Read only from the sheet.';
create index pool_candidates_active_idx on app.pool_candidates (lower(mentor_name)) where removed_at is null;
create index pool_candidates_phone_idx on app.pool_candidates (phone) where phone is not null;

create table app.pool_state (
  uid         text primary key references app.pool_candidates (uid) on delete cascade,
  track       text check (track is null or track in ('frontend', 'backend', 'fullstack', 'aiml')),
  priority    text check (priority is null or priority in ('p0', 'p1', 'p2', 'p3')),
  tags        text[] not null default '{}' check (cardinality(tags) <= 20),
  version     integer not null default 1 check (version > 0),
  updated_by  text not null,
  updated_at  timestamptz not null default now()
);
comment on table app.pool_state is 'What mentors decide per candidate (track, priority, tech stack tags). Never written by the sheet sync.';

create table app.pool_resumes (
  id             uuid primary key default gen_random_uuid(),
  uid            text not null references app.pool_candidates (uid) on delete cascade,
  stack          text not null check (char_length(stack) between 1 and 40),
  best           boolean not null default false,
  file_name      text not null check (char_length(file_name) between 1 and 200),
  mime           text not null check (char_length(mime) between 3 and 120),
  size_bytes     integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  drive_file_id  text not null check (char_length(drive_file_id) between 10 and 200),
  drive_url      text not null check (drive_url ~ '^https://'),
  note           text check (note is null or char_length(note) <= 300),
  uploaded_by    text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  deleted_by     text
);
comment on table app.pool_resumes is 'Updated resumes mentors collected (team Google Drive). One stack each; at most one best per candidate and stack.';
create index pool_resumes_uid_idx on app.pool_resumes (uid, created_at desc) where deleted_at is null;
create unique index pool_resumes_best_per_stack on app.pool_resumes (uid, lower(stack)) where best and deleted_at is null;

create table app.pool_events (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  uid          text not null references app.pool_candidates (uid) on delete cascade,
  actor_email  text not null,
  action       text not null check (action in ('priority', 'track', 'tags', 'resume_added', 'resume_updated', 'resume_removed', 'meeting', 'call', 'whatsapp', 'email')),
  value        text not null default '' check (char_length(value) <= 500)
);
comment on table app.pool_events is 'History of each pool candidate: who changed what, contacted them, or scheduled a meeting.';
create index pool_events_uid_idx on app.pool_events (uid, at desc);
create index pool_events_contact_idx on app.pool_events (uid, at desc) where action in ('call', 'whatsapp', 'email', 'meeting');

create table app.pool_syncs (
  id            bigint generated always as identity primary key,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  rows_read     integer not null default 0 check (rows_read >= 0),
  active        integer not null default 0 check (active >= 0),
  added         integer not null default 0 check (added >= 0),
  updated       integer not null default 0 check (updated >= 0),
  removed       integer not null default 0 check (removed >= 0),
  issues        jsonb not null default '[]'::jsonb,
  error         text,
  triggered_by  text not null
);
create index pool_syncs_started_idx on app.pool_syncs (started_at desc);

alter table app.meetings add column if not exists pool_uids text[] not null default '{}';
create index if not exists meetings_pool_uids_idx on app.meetings using gin (pool_uids);

alter table app.notifications
  add column if not exists title text check (title is null or char_length(title) <= 200),
  add column if not exists body text check (body is null or char_length(body) <= 1000),
  add column if not exists data jsonb not null default '{}'::jsonb,
  add column if not exists read_at timestamptz;
create index if not exists notifications_unread_idx on app.notifications (user_email, at desc) where read_at is null;

alter table app.pool_candidates enable row level security;
alter table app.pool_state      enable row level security;
alter table app.pool_resumes    enable row level security;
alter table app.pool_events     enable row level security;
alter table app.pool_syncs      enable row level security;

select cron.schedule(
  'psm-pool-syncs-retention',
  '47 3 * * *',
  $$ delete from app.pool_syncs where started_at < now() - interval '30 days'; $$
);
