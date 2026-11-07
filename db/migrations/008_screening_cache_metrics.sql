-- 008 — Faster screening without changing a judgement: content caches + per-candidate timings.
--
-- automation.resume_cache      what a resume FILE contains, keyed by the SHA-256 of its bytes:
--                              kind 'pdf' = the text layer (per page) and link annotations;
--                              kind 'ocr' = what a scanned file / image is and its transcription.
--                              The same file (a re-run, or a candidate applying to several
--                              companies) is never parsed or transcribed twice. `version` is the
--                              reader's version: a reader change simply misses the old rows.
-- automation.judgement_cache   one model judgement, keyed by a SHA-256 of EVERYTHING it depends on
--                              (the exact text the model read, the domain brief, the mandatory
--                              list, the prompt + schema, the model chain). Same inputs → same
--                              answer, so a re-run of a job reuses it instead of calling the model.
--                              Only judgements from the primary chain are stored.
-- job_candidates.metrics       how long each step took for that candidate (download, read, OCR,
--                              judgement), which model judged, and what came from a cache.
--
-- Both caches hold resume content, so they live in the closed automation schema (no anon /
-- authenticated access, RLS on) and rows unused for 90 days are deleted by the worker.

create table automation.resume_cache (
  content_hash  text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  kind          text not null check (kind in ('pdf', 'ocr')),
  version       integer not null,
  data          jsonb not null,
  bytes         integer not null default 0,
  created_at    timestamptz not null default now(),
  used_at       timestamptz not null default now(),
  primary key (content_hash, kind, version)
);
create index resume_cache_used_idx on automation.resume_cache (used_at);
alter table automation.resume_cache enable row level security;

create table automation.judgement_cache (
  key         text primary key check (key ~ '^[0-9a-f]{64}$'),
  scored_by   text not null,
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  used_at     timestamptz not null default now()
);
create index judgement_cache_used_idx on automation.judgement_cache (used_at);
alter table automation.judgement_cache enable row level security;

alter table automation.job_candidates add column if not exists metrics jsonb;
