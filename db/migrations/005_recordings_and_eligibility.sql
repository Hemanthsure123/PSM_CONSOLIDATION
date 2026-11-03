-- 005 — Interview recordings with the marks, and the job-eligibility tag of everyone assessed.
--
--  * assessment_scores.recording_url: the interview's recording (Bucket A / B rounds, competency
--    interviews) when the sheet has one. Only an http(s) link is kept.
--  * placement.assessed_people: one row per person the Academy assessments know — a mark, a
--    profile from an assessment export, or an Academy pool record — with the tag that says
--    whether they can be put forward for job opportunities:
--      eligible = in the eligible pool (an Edge 2.0, Edge 1.0 or Academy record) with an eligible
--                 standing (tier 1–3) — the same rule as the app's isAssessed();
--      everyone else assessed is "Not eligible" (their marks are kept all the same).
--    The rule lives here once; the marks summary and the lookup's Find read it from this view.
--    It is derived, never stored, so it follows the eligible pool on every refetch.
--  * The view reads the candidate_standing materialized view: a migration that drops
--    candidate_standing must drop and recreate this view as well.
--  * security_invoker: the view runs with the caller's rights (the schema is closed to anon /
--    authenticated anyway, see 001), so it never widens access to the tables under it.
--  * No new indexes: the view aggregates a few thousand score rows (about a millisecond).

alter table placement.assessment_scores
  add column recording_url text check (recording_url ~ '^https?://' and char_length(recording_url) <= 500);

create view placement.assessed_people with (security_invoker = true) as
with marks as (
  select candidate_id,
         count(*)::int                    as scores,
         count(distinct assessment)::int  as assessments,
         max(taken_on)                    as last_taken_on
    from placement.assessment_scores
   group by candidate_id
),
known as (
  select candidate_id from marks
  union
  select candidate_id from placement.candidate_profiles
  union
  select candidate_id from placement.academy_records
)
select c.id                                                        as candidate_id,
       c.user_id,
       c.phone,
       c.name,
       coalesce(cs.eligible and cs.best_tier <= 3, false)          as eligible,
       case when cs.eligible and cs.best_tier <= 3 then 'Eligible' else 'Not eligible' end as job_eligibility,
       cs.best_product                                             as pool_product,
       cs.best_label                                               as pool_standing,
       a.candidate_id is not null                                  as in_academy_pool,
       coalesce(p.yog, a.yog)                                      as yog,
       p.college,
       p.degree,
       p.department,
       coalesce(m.scores, 0)                                       as scores,
       coalesce(m.assessments, 0)                                  as assessments,
       m.last_taken_on
  from known k
  join placement.candidates c on c.id = k.candidate_id
  left join placement.candidate_standing cs on cs.candidate_id = c.id
  left join placement.candidate_profiles p on p.candidate_id = c.id
  left join placement.academy_records a on a.candidate_id = c.id
  left join marks m on m.candidate_id = c.id;

comment on view placement.assessed_people is
  'Everyone the Academy assessments know, with job_eligibility: Eligible = in the eligible pool with an eligible standing (tier 1-3).';
comment on column placement.assessment_scores.recording_url is 'The interview''s recording link (http/https), when the sheet has one.';
