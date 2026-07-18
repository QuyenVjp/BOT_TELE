-- Feature 001 identity + delivery security upgrade.
--
-- This migration must upgrade both databases that recorded SePay-only 008 and
-- older snapshots where identity/delivery objects were appended to 008. Every
-- object is therefore idempotent. The case-collision guard intentionally runs
-- before normalization and aborts the transaction so operators can reconcile
-- ambiguous identities using docs/06-operations/IDENTITY_MIGRATION_COLLISION_RUNBOOK.md.

do $$
declare
  collision record;
begin
  select channel_user_id, array_agg(distinct channel order by channel) as channels
    into collision
  from channel_identity
  where lower(channel) = 'telegram'
  group by channel_user_id
  having count(distinct channel) > 1
  limit 1;
  if collision is not null then
    raise exception 'TELEGRAM_CHANNEL_COLLISION channel_user_id=% channels=%',
      collision.channel_user_id, collision.channels;
  end if;
end;
$$;

update channel_identity
set channel = 'TELEGRAM'
where lower(channel) = 'telegram' and channel <> 'TELEGRAM';

alter table channel_identity
  add column if not exists username_observed_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'channel_identity_channel_ck'
      and conrelid = 'channel_identity'::regclass
  ) then
    alter table channel_identity
      add constraint channel_identity_channel_ck check (channel = 'TELEGRAM');
  end if;
end;
$$;

create table if not exists delivery_session (
  id               text primary key,
  bundle_id        text not null references delivery_bundle (id),
  customer_id      text not null references customer (id),
  telegram_user_id text not null,
  audience         text not null,
  nonce_hash       text not null,
  key_version      integer not null,
  expires_at       timestamptz not null,
  used_at          timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz not null default now(),
  unique (nonce_hash)
);

create index if not exists delivery_session_live_idx
  on delivery_session (bundle_id, customer_id, expires_at)
  where used_at is null and revoked_at is null;

create table if not exists delivery_notification_handoff (
  id               text primary key,
  bundle_id        text not null references delivery_bundle (id),
  customer_id      text not null references customer (id),
  telegram_chat_id text not null,
  capability_key   text not null,
  capability_ref   text,
  payload_redacted jsonb not null default '{}'::jsonb,
  status           text not null check (status in ('PREPARED','STORED','READY','PROCESSING','RETRY','SENT','DEAD')),
  attempt_count    integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  claimed_by       text,
  claim_generation bigint not null default 0,
  claim_expires_at timestamptz,
  stored_at        timestamptz,
  ready_at         timestamptz,
  capability_expires_at timestamptz,
  sent_at          timestamptz,
  last_error_code  text,
  created_at       timestamptz not null default now(),
  unique (bundle_id, telegram_chat_id),
  unique (capability_key),
  unique (capability_ref)
);

alter table delivery_notification_handoff
  add column if not exists capability_key text,
  add column if not exists stored_at timestamptz,
  add column if not exists ready_at timestamptz,
  add column if not exists capability_expires_at timestamptz;

update delivery_notification_handoff
set capability_key = bundle_id || ':' || telegram_chat_id
where capability_key is null;

alter table delivery_notification_handoff
  alter column capability_key set not null,
  alter column capability_ref drop not null;

create unique index if not exists delivery_notification_capability_key_uq
  on delivery_notification_handoff (capability_key);

create table if not exists telegram_username_observation (
  telegram_user_id  text primary key,
  observed_username text not null,
  observed_at       timestamptz not null default now(),
  expires_at        timestamptz not null default (now() + interval '30 days'),
  check (telegram_user_id ~ '^[1-9][0-9]{0,19}$'),
  check (observed_username ~ '^[A-Za-z0-9_]{1,64}$')
);

create index if not exists telegram_username_observation_expiry_idx
  on telegram_username_observation (expires_at, telegram_user_id);

create table if not exists delivery_miniapp_redemption (
  id                 text primary key,
  init_data_hash     text not null unique,
  handoff_id         text not null references delivery_notification_handoff (id),
  telegram_user_id   text not null,
  audience           text not null,
  redeemed_at        timestamptz not null default now(),
  check (init_data_hash ~ '^[a-f0-9]{64}$'),
  check (telegram_user_id ~ '^[1-9][0-9]{0,19}$')
);

create index if not exists delivery_miniapp_redemption_handoff_idx
  on delivery_miniapp_redemption (handoff_id, redeemed_at);

-- Existing expanded-008 databases have the older status check. Replace it with
-- the recoverable handoff protocol while preserving all rows and statuses.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname from pg_constraint
    where conrelid = 'delivery_notification_handoff'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%'
  loop
    execute format('alter table delivery_notification_handoff drop constraint %I', constraint_name);
  end loop;
  alter table delivery_notification_handoff
    add constraint delivery_notification_handoff_status_ck
    check (status in ('PREPARED','STORED','READY','PROCESSING','RETRY','SENT','DEAD'));
exception when duplicate_object then
  null;
end;
$$;

-- The historical expanded-008 snapshot already used this name with a
-- RETRY-only predicate. PostgreSQL's IF NOT EXISTS compares names, not index
-- definitions, so replace it explicitly before installing the canonical
-- PREPARED/STORED/READY/RETRY scheduler index.
drop index if exists delivery_notification_due_idx;

create index delivery_notification_due_idx
  on delivery_notification_handoff (next_attempt_at, id)
  where status in ('PREPARED','STORED','READY','RETRY');

create index if not exists delivery_notification_processing_lease_idx
  on delivery_notification_handoff (claim_expires_at, id)
  where status = 'PROCESSING';

create index if not exists delivery_notification_cleanup_idx
  on delivery_notification_handoff (status, sent_at, next_attempt_at);
