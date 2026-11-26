-- 019 — Feedback from the team (PSM 1.9.0).
--
-- app.feedback   what a team member reports from the app (Me → Report feedback): a problem, an
--                idea or anything else, with the screen they were on and their app version and
--                device. Every active admin gets it as a push (kind "feedback"); admins read the
--                list in the app (GET /admin/feedback) and mark items read.
--
-- Closed to the anon/authenticated roles like the other app tables; only the server's own
-- connection reads and writes it. Kept a year.

create table app.feedback (
  id           uuid primary key default gen_random_uuid(),
  from_email   text not null,
  category     text not null check (category in ('problem', 'idea', 'other')),
  message      text not null check (char_length(message) between 1 and 2000),
  screen       text check (screen is null or char_length(screen) <= 100),
  app_version  text check (app_version is null or char_length(app_version) <= 40),
  device       text check (device is null or char_length(device) <= 120),
  created_at   timestamptz not null default now(),
  read_at      timestamptz
);
create index feedback_created_idx on app.feedback (created_at desc);
-- The rate limit (10 per person per hour) reads this.
create index feedback_from_idx on app.feedback (from_email, created_at desc);

alter table app.feedback enable row level security;

select cron.schedule(
  'psm-feedback-retention',
  '59 3 * * *',
  $$ delete from app.feedback where created_at < now() - interval '365 days'; $$
);
