-- 007 — Extra Google accounts a roster member may sign in to the app with.
--
-- Access is decided by the roster, not by the email's domain alone: a person signs in with their
-- roster email (a NxtWave address) or with a Google account an admin has linked to them here
-- (for example a Gmail account that mirrors their work account). The session is always the
-- roster person's: same tasks, role and notifications. An unlinked account outside the NxtWave
-- domains is refused. A login email belongs to one person only (primary key), and can't be
-- someone's roster email (checked by the server when the roster is saved).

create table app.user_logins (
  login_email  text primary key check (login_email = lower(login_email) and login_email like '%@%'),
  user_email   text not null references app.users (email) on update cascade on delete cascade,
  created_by   text,
  created_at   timestamptz not null default now()
);
comment on table app.user_logins is 'Google accounts linked to a roster member for app sign-in (admin-managed in Me → Team).';
create index user_logins_user_idx on app.user_logins (user_email);
alter table app.user_logins enable row level security;

-- Which Google account opened each session (null = the roster email), so unlinking an account
-- signs out exactly the devices that used it.
alter table app.sessions add column if not exists login_email text;
create index if not exists sessions_login_idx on app.sessions (login_email) where login_email is not null and revoked_at is null;
