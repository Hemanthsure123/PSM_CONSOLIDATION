-- 012 — Retention for the app's history tables, so day 1,000 runs like day 1.
--
-- Run daily by pg_cron inside the database (011 added it), independent of the web server:
--   app.sessions       a row per refresh-token rotation. Rows that expired more than 30 days ago
--                      can never be used again, not even for reuse detection (an expired token is
--                      refused before that check), so they go.
--   app.notifications  the push log and its dedupe keys. Keys name a task / job and a moment
--                      (assigned, reminder, overdue, shortlist ready), and nothing re-sends a push
--                      for a task six months old, so rows older than 180 days go.
-- Kept on purpose: app.prep_events and app.audit_log (the audit trail), jobs and job_events
-- (analytics); their growth is a few rows per task.

select cron.schedule(
  'psm-app-retention',
  '41 3 * * *',
  $$
    delete from app.sessions where expires_at < now() - interval '30 days';
    delete from app.notifications where at < now() - interval '180 days';
  $$
);
