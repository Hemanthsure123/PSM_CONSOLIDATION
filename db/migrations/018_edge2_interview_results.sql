-- 018 — Edge 2.0: the interview results behind each candidate's stage (standing rules v2).
--
-- Why: the Edge 2.0 pool sheet's stage column lost its header, so the sync read the drive's
-- currentStage ("dsa_interview", "resume_based_interview" …) as the stage and every Edge 2.0
-- candidate came out "Assessment cleared". The stage is now the higher of the sheet's stage column
-- and what the interview results prove, and the results themselves are kept, so the Internal
-- Standing can show every one of them:
--   sheet_stage            the sheet's own stage cell as written ("TR2 CLEARED" …), null when none
--   drive_stage            the drive's currentStage — where the candidate is, not what they cleared
--   tr1_status             the TR-1 AI interview's own result: pass / fail
--   dsa_interview_*        the DSA interview (the TR-1 round): status ("Shortlisted" = cleared; the
--                          drive also shows "Not Shortlisted" before anyone interviews), attempt
--                          (attempted / not_attempted), and its DSA (/120) and CS (/40) scores
--   interview_path         separate (DSA interview + TR-2 per track) / combined (one interview)
--   combined_state/verdict the combined interview (a strong / medium hire = TR-2 cleared)
--   tr2_pending            TR-2 tracks booked ("assigned") but not interviewed yet
--   journey_status/reason  the drive's journey (open / closed, and why it closed)
-- candidate_stage keeps its meaning: TR2 CLEARED / TR1 CLEARED / ASSESSMENT CLEARED (resolved).
--
-- Additive and nullable only: code without these columns keeps working; the next sync fills them
-- (RULES_VERSION 2 changes every row hash, so every Edge 2.0 record is rewritten once).

alter table placement.edge2_records
  add column if not exists sheet_stage             text,
  add column if not exists drive_stage             text,
  add column if not exists tr1_status              text,
  add column if not exists dsa_interview_status    text,
  add column if not exists dsa_interview_attempt   text,
  add column if not exists dsa_interview_dsa_score numeric(6, 2),
  add column if not exists dsa_interview_cs_score  numeric(6, 2),
  add column if not exists interview_path          text,
  add column if not exists combined_state          text,
  add column if not exists combined_verdict        placement.verdict,
  add column if not exists tr2_pending             placement.tr2_track[],
  add column if not exists journey_status          text,
  add column if not exists journey_reason          text;

comment on column placement.edge2_records.candidate_stage is
  'Stage cleared: TR2 CLEARED / TR1 CLEARED / ASSESSMENT CLEARED — the sheet''s stage column, raised by the interview results (rules v2).';
comment on column placement.edge2_records.drive_stage is
  'The drive''s currentStage (dsa_interview, resume_based_interview, combined_interview …): where the candidate is, not what they cleared.';
