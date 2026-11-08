-- 011 — Keep the Render server awake: a schedule inside the database pings it every 10 minutes.
--
-- Render's free instance sleeps after 15 minutes without an inbound request, and the first
-- request after that waits about a minute while it starts (the Android app then shows spinners).
-- GitHub's scheduled workflows were too unreliable to prevent that (set to every 5 minutes, they
-- ran hours apart), so the schedule now lives here:
--   pg_cron  runs the job every 10 minutes, to the minute;
--   pg_net   sends the request asynchronously (the database never waits on it).
-- The ping also counts as database activity, so Supabase's free plan never pauses the project.
--
-- Housekeeping, so this costs the same on day 1,000 as on day 1:
--   pg_net deletes its own response rows after 6 hours (its default TTL);
--   cron.job_run_details would otherwise grow forever, so a daily job keeps 7 days of it.
--
-- To stop it:   select cron.unschedule('psm-keep-awake');
-- To move it:   select cron.alter_job((select jobid from cron.job where jobname = 'psm-keep-awake'),
--                 command := $$ ... new URL ... $$);

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- cron.schedule with a job name replaces an existing job of that name, so re-running is safe.
select cron.schedule(
  'psm-keep-awake',
  '*/10 * * * *',
  $$ select net.http_get(
       url := 'https://psm-placements.onrender.com/api/health',
       headers := '{"User-Agent": "psm-keep-awake/1"}'::jsonb,
       timeout_milliseconds := 60000
     ) $$
);

select cron.schedule(
  'psm-cron-history-prune',
  '23 3 * * *',
  $$ delete from cron.job_run_details where end_time < now() - interval '7 days' $$
);
