-- 014 — Schema hardening (review of 2026-11-08): indexes behind every foreign key and every hot
-- query, value checks the code already relies on, and retention for document runs.
--
-- Foreign keys without an index make deletes on the parent scan the child table:
--   app.users.lead_email, app.devices.session_id, app.prep_doc_runs.document_id.
-- Hot queries that had no matching index:
--   meetings — overlap check per scheduler (created_by, starts_at); the minute ticker's pending
--              artifacts scan; reminders due.
--   call_recordings — the resume ticker (status, updated_at) on unfinished files only.
--   prep_doc_runs — "a run is already writing this job + round + kind" check.
-- Checks: a meeting ends after it starts; durations are never negative; attempts never negative.
-- Retention (pg_cron, like 012): document runs older than 90 days go (the documents stay).

create index if not exists users_lead_email_idx on app.users (lead_email);
create index if not exists devices_session_idx on app.devices (session_id);
create index if not exists prep_doc_runs_document_idx on app.prep_doc_runs (document_id);
create index if not exists prep_doc_runs_busy_idx on app.prep_doc_runs (job_key, round_key, kind) where status in ('queued', 'running');

create index if not exists meetings_creator_starts_idx on app.meetings (created_by, starts_at) where status = 'scheduled';
create index if not exists meetings_artifacts_due_idx on app.meetings (ends_at) where status = 'scheduled' and artifacts_status = 'pending';
create index if not exists meetings_reminder_due_idx on app.meetings (starts_at) where status = 'scheduled' and reminded_at is null;

create index if not exists call_recordings_unfinished_idx on app.call_recordings (updated_at) where status <> 'ready';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'meetings_ends_after_start') then
    alter table app.meetings add constraint meetings_ends_after_start check (ends_at > starts_at);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'meetings_duration_nonneg') then
    alter table app.meetings add constraint meetings_duration_nonneg check (duration_sec is null or duration_sec >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'call_recordings_attempts_nonneg') then
    alter table app.call_recordings add constraint call_recordings_attempts_nonneg check (attempts >= 0);
  end if;
end $$;

select cron.schedule(
  'psm-prep-runs-retention',
  '53 3 * * *',
  $$ delete from app.prep_doc_runs where created_at < now() - interval '90 days' and status in ('done', 'failed'); $$
);
