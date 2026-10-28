-- 002 — Phone numbers as text (not char(10)), and RLS on the migrations table.
--
-- char(10) made "phone = any($1::text[])" compare as text after a cast, which the
-- phone indexes can't serve. text + the same 10-digit CHECK keeps the rule and lets
-- every phone lookup use its index. The standings view depends on candidates.phone,
-- so it is rebuilt (same definition, same indexes).

drop materialized view placement.candidate_standing;

alter table placement.candidates     alter column phone type text;
alter table placement.edge1_records   alter column phone type text;
alter table placement.edge2_records   alter column phone type text;
alter table placement.academy_records alter column phone type text;

create materialized view placement.candidate_standing as
with records as (
  select candidate_id, 'edge1'::placement.product as product, tier, internal_score, stage_label, eligible from placement.edge1_records
  union all
  select candidate_id, 'edge2'::placement.product, tier, internal_score, stage_label, eligible from placement.edge2_records
  union all
  select candidate_id, 'academy'::placement.product, tier, internal_score, stage_label, eligible from placement.academy_records
),
ranked as (
  select r.*, row_number() over (partition by r.candidate_id order by r.tier, r.internal_score desc, r.product) as rn
  from records r
),
standings as (
  select candidate_id,
         jsonb_agg(jsonb_build_object('product', product, 'tier', tier, 'label', stage_label, 'score', internal_score, 'eligible', eligible)
                   order by tier, internal_score desc) as standings,
         bool_or(eligible) as eligible
  from records
  group by candidate_id
)
select c.id as candidate_id, c.phone, c.user_id, c.name,
       b.product as best_product, b.tier as best_tier, b.internal_score as best_score, b.stage_label as best_label,
       s.eligible, s.standings
from ranked b
join placement.candidates c on c.id = b.candidate_id
join standings s on s.candidate_id = b.candidate_id
where b.rn = 1;

create unique index candidate_standing_pkey on placement.candidate_standing (candidate_id);
create index candidate_standing_phone_idx on placement.candidate_standing (phone) where phone is not null;
create index candidate_standing_user_id_idx on placement.candidate_standing (user_id) where user_id is not null;

alter table placement.schema_migrations enable row level security;
