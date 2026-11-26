-- 021 — "Shortlisting done", automatic assignment by ISE and notification health (PSM 1.11.0).
--
-- app.assignments  + done_at, done_by: the task's assignee (or a lead / admin) marked the
--                    shortlisting done in the app (POST /tasks/{taskId}/done). A second "done" keeps
--                    the first time; "undo" clears both. A reassignment clears them, as it clears
--                    ack_at. Done tasks get no reminder, nudge, overdue or escalation pushes and
--                    never count as overdue.
--                  + auto_assigned, auto_assigned_at: the server wrote the ISE's mentor into a
--                    blank Mentor cell (MOBILE_ISE_AUTO_ASSIGN). auto_assigned is cleared when the
--                    row is reassigned; auto_assigned_at stays, so a row is auto-assigned at most
--                    once (a cell someone empties again is left to people).
-- app.devices      + what the phone reports about its notifications (PUT /me/device):
--                    notifications_enabled, task_channel_enabled, battery_optimized (not exempt
--                    from battery optimisation), background_restricted, manufacturer, and health_at
--                    (when it last reported them). Shown to admins in Team; no push is sent.
-- app.audit_log    + an index for "assigned in the app" (task_taken / task_assigned per task).
--
-- Idempotent: every statement can run again. Code deployed before this migration keeps the 1.10
-- behaviour: it checks for these columns and leaves the features off until they exist.

alter table app.assignments add column if not exists done_at          timestamptz;
alter table app.assignments add column if not exists done_by          text;
alter table app.assignments add column if not exists auto_assigned    boolean not null default false;
alter table app.assignments add column if not exists auto_assigned_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'assignments_done_by_len') then
    alter table app.assignments add constraint assignments_done_by_len check (done_by is null or char_length(done_by) <= 254);
  end if;
end $$;

-- Analytics reads tasks marked done in a date range.
create index if not exists assignments_done_idx on app.assignments (done_at) where done_at is not null;

alter table app.devices add column if not exists notifications_enabled boolean;
alter table app.devices add column if not exists task_channel_enabled  boolean;
alter table app.devices add column if not exists battery_optimized     boolean;
alter table app.devices add column if not exists background_restricted boolean;
alter table app.devices add column if not exists manufacturer          text;
alter table app.devices add column if not exists health_at             timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'devices_manufacturer_len') then
    alter table app.devices add constraint devices_manufacturer_len check (manufacturer is null or char_length(manufacturer) <= 80);
  end if;
end $$;

create index if not exists audit_log_task_assign_idx on app.audit_log (target, at desc) where action in ('task_taken', 'task_assigned');

comment on column app.assignments.done_at is 'Shortlisting marked done in the app (1.11.0); cleared on reassignment or undo.';
comment on column app.assignments.auto_assigned is 'The Mentor cell was filled by the server from the ISE mapping (1.11.0); cleared on reassignment.';
comment on column app.devices.health_at is 'When the phone last reported its notification health (1.11.0).';
