-- 006 — The Android app's server side (docs/mobile-api.yaml, /api/mobile/v1).
--
-- app.users          the roster: who may sign in, with which role. "name" is how the person
--                    appears in the control sheet's Mentor column; aliases cover other spellings.
-- app.sessions       one row per signed-in device session. Only a SHA-256 of the refresh token
--                    is stored. Refresh tokens rotate: using one marks it rotated and issues the
--                    next; using an already-rotated one is theft and revokes the whole chain.
-- app.devices        FCM push tokens (one row per token) and what the device reported.
-- app.assignments    one row per control-sheet row that has a Mentor: who it's assigned to,
--                    the deadline as read, acknowledgement ("Start now") and which reminders
--                    were already pushed (so each goes out once).
-- app.notifications  every push sent, for troubleshooting and dedupe.
--
-- Closed to the anon/authenticated roles like the other schemas (see 001); only the server's own
-- connection reads and writes it.

create schema if not exists app;
revoke all on schema app from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema app from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on schema app from authenticated'; end if;
end $$;

create table app.users (
  email       text primary key check (email = lower(email) and email like '%@%'),
  name        text not null check (char_length(name) between 1 and 80),
  aliases     text[] not null default '{}',
  role        text not null default 'member' check (role in ('member', 'lead', 'admin')),
  lead_email  text references app.users (email) on delete set null,
  active      boolean not null default true,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table app.users is 'Roster of the mobile app. name = the Mentor dropdown value in the control sheet.';
create unique index users_name_lower on app.users (lower(name)) where active;

create table app.sessions (
  id            uuid primary key default gen_random_uuid(),
  user_email    text not null references app.users (email) on delete cascade,
  refresh_hash  text not null unique,
  expires_at    timestamptz not null,
  rotated_at    timestamptz,
  revoked_at    timestamptz,
  replaced_by   uuid,
  family        uuid not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz not null default now()
);
create index sessions_user_idx on app.sessions (user_email) where revoked_at is null;
create index sessions_family_idx on app.sessions (family);

create table app.devices (
  fcm_token    text primary key,
  user_email   text not null references app.users (email) on delete cascade,
  session_id   uuid references app.sessions (id) on delete set null,
  platform     text not null default 'android',
  app_version  text,
  os_version   integer,
  model        text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index devices_user_idx on app.devices (user_email);

create table app.assignments (
  task_id          text primary key,
  spreadsheet_id   text not null,
  control_tab      text not null,
  control_row      integer not null,
  company          text not null default '',
  assignee_email   text references app.users (email) on delete set null,
  assignee_name    text not null default '',
  assigned_at      timestamptz,
  deadline         timestamptz,
  notified_at      timestamptz,
  reminded_half_at timestamptz,
  reminded_soon_at timestamptz,
  overdue_at       timestamptz,
  escalated_at     timestamptz,
  ack_at           timestamptz,
  ack_by           text,
  job_id           uuid,
  first_seen_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index assignments_assignee_idx on app.assignments (assignee_email);

create table app.notifications (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  user_email  text,
  kind        text not null,
  task_id     text,
  job_id      uuid,
  dedupe_key  text unique,
  delivered   integer not null default 0,
  failed      integer not null default 0,
  detail      text
);
create index notifications_user_idx on app.notifications (user_email, at desc);

alter table app.users         enable row level security;
alter table app.sessions      enable row level security;
alter table app.devices       enable row level security;
alter table app.assignments   enable row level security;
alter table app.notifications enable row level security;

-- The first roster (the Mentor dropdown in EDGE "Profile Shortlisting - New", column AK).
-- More people and admins are added from the app (Me → Team) by an admin.
insert into app.users (email, name, aliases, role, created_by) values
  ('hemanthreddy.sure@nxtwave.co.in', 'Hemanth', '{}', 'admin',  'migration 006'),
  ('bepari.faraazahmed@nxtwave.co.in', 'Faraaz', '{"Faraaz Ahmed"}', 'member', 'migration 006'),
  ('gaurav.singhyadav@nxtwave.co.in',  'Gaurav', '{"Gaurav Singh Yadav"}', 'member', 'migration 006'),
  ('vadla.rakeshchari@nxtwave.co.in',  'Rakesh', '{"Rakesh Chari"}', 'member', 'migration 006')
on conflict (email) do nothing;
