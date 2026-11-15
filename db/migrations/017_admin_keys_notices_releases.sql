-- Admin tools in the app and in-app updates.
--
-- app.api_keys        speech-to-text and AI keys the admin manages from the app (Me → API keys).
--                     Encrypted (AES-GCM with the server secret); the app only sees label + last 4.
--                     They are added to the server's own keys, never replace them.
-- app.admin_notices   sticky notifications the admin sends a mentor; they stay on the mentor's
--                     phone until acknowledged.
-- app.app_releases    the app's APKs, so phones update in place without the Play Store. Only the
--                     newest few keep their file.

create table app.api_keys (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null check (provider in ('deepgram', 'elevenlabs', 'mistral', 'gemini', 'groq')),
  label        text not null check (char_length(label) between 1 and 60),
  key_enc      text not null,
  fingerprint  text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  last4        text not null check (char_length(last4) = 4),
  enabled      boolean not null default true,
  status       text not null default 'unchecked' check (status in ('unchecked', 'ok', 'invalid', 'error')),
  status_note  text check (status_note is null or char_length(status_note) <= 300),
  checked_at   timestamptz,
  created_by   text not null,
  updated_by   text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (provider, fingerprint)
);

create table app.admin_notices (
  id               uuid primary key default gen_random_uuid(),
  to_email         text not null,
  title            text not null check (char_length(title) between 1 and 120),
  body             text not null check (char_length(body) between 1 and 1000),
  sent_by          text not null,
  created_at       timestamptz not null default now(),
  delivered        integer not null default 0 check (delivered >= 0),
  acknowledged_at  timestamptz
);
create index admin_notices_open_idx on app.admin_notices (to_email, created_at desc) where acknowledged_at is null;
create index admin_notices_created_idx on app.admin_notices (created_at desc);

create table app.app_releases (
  version_code  integer primary key check (version_code > 0),
  version_name  text not null check (char_length(version_name) between 1 and 40),
  notes         text not null default '' check (char_length(notes) <= 4000),
  apk           bytea,
  size_bytes    integer not null check (size_bytes > 0 and size_bytes <= 80 * 1024 * 1024),
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  -- Phones below this version code must update before using the app (0 = never forced).
  min_supported integer not null default 0,
  published_by  text not null,
  published_at  timestamptz not null default now()
);

alter table app.api_keys      enable row level security;
alter table app.admin_notices enable row level security;
alter table app.app_releases  enable row level security;

select cron.schedule(
  'psm-admin-notices-retention',
  '57 3 * * *',
  $$ delete from app.admin_notices where acknowledged_at < now() - interval '180 days'; $$
);
