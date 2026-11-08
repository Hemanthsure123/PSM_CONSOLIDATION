-- 013 — Call transcripts, summaries and messages live in the drill-down sheet only.
--
-- The team's rule (2026-11-08): the text of a prep call (its transcript and AI summary) and the
-- messages sent to candidates are kept on the candidate's drill-down row, in the columns the
-- server adds past Z (Prep Call Recording / Transcript / Summary / Duration, Prep Messages). The
-- database keeps only what's needed to process a call and to count call time: who, when, the real
-- length, the processing status and links to the files in the team Drive.
--
-- app.call_recordings  drops transcript_url, transcript_text, summary (no transcript document is
--                      made any more: the transcript goes to the sheet).
-- app.meetings         drops transcript_text, summary (Meet's own transcript file link stays);
--                      adds prep_keys (the candidates of a guidance session, each row gets the
--                      call and the emails) and sheet_written_at.
-- app.communications   dropped: emails and WhatsApp hand-offs are lines in Prep Messages.
--
-- All three tables were empty when this was written (checked on production 2026-11-08), so
-- nothing is lost.

alter table app.call_recordings
  drop column if exists transcript_url,
  drop column if exists transcript_text,
  drop column if exists summary;

alter table app.meetings
  drop column if exists transcript_text,
  drop column if exists summary,
  add column if not exists prep_keys text[] not null default '{}',
  add column if not exists sheet_written_at timestamptz;

create index if not exists meetings_prep_keys_idx on app.meetings using gin (prep_keys);

drop table if exists app.communications;
