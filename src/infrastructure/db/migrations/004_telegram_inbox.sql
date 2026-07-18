-- T126: durable asynchronous Telegram ingress and PostgreSQL rate-limit fallback.
-- Append-only: deployed 001-003 migrations are never rewritten.

alter table webhook_inbox
  drop constraint if exists webhook_inbox_processing_status_check;

update webhook_inbox
set processing_status = 'RETRY'
where processing_status in ('PENDING', 'FAILED');

alter table webhook_inbox
  alter column processing_status set default 'RETRY',
  add column if not exists envelope jsonb not null default '{}'::jsonb,
  add column if not exists claimed_by text,
  add column if not exists claim_generation bigint not null default 0,
  add column if not exists claim_expires_at timestamptz,
  add column if not exists dead_lettered_at timestamptz,
  add column if not exists mutation_count integer not null default 0,
  add column if not exists last_mutation_at timestamptz;

update webhook_inbox
set next_attempt_at = coalesce(next_attempt_at, received_at)
where processing_status = 'RETRY';

alter table webhook_inbox
  add constraint webhook_inbox_processing_status_check
  check (processing_status in ('RETRY', 'PROCESSING', 'PROCESSED', 'DEAD')),
  add constraint webhook_inbox_attempt_count_check check (attempt_count >= 0),
  add constraint webhook_inbox_claim_generation_check check (claim_generation >= 0),
  add constraint webhook_inbox_mutation_count_check check (mutation_count >= 0),
  add constraint webhook_inbox_envelope_object_check check (jsonb_typeof(envelope) = 'object');

create index webhook_inbox_due_idx
  on webhook_inbox (next_attempt_at, received_at, id)
  where processing_status = 'RETRY';

create index webhook_inbox_expired_lease_idx
  on webhook_inbox (claim_expires_at, received_at, id)
  where processing_status = 'PROCESSING';

create table telegram_rate_limit_bucket (
  bucket_key text primary key,
  tokens double precision not null check (tokens >= 0),
  updated_at timestamptz not null default now()
);
