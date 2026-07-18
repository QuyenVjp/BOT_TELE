-- 009a_delivery_capability_compensation.sql
-- Feature 001 additive upgrade after 009_identity_delivery_security.sql.
-- A child ledger prevents a bounded JSON tombstone from losing the only
-- durable pointer when vault cleanup repeatedly fails.

alter table delivery_session
  add column if not exists activated_at timestamptz;

-- Sessions issued by pre-009a code were immediately active. Preserve that
-- behavior during upgrade; new PREPARED handoffs explicitly insert NULL.
update delivery_session
set activated_at = created_at
where activated_at is null;

alter table delivery_notification_handoff
  add column if not exists session_id text,
  add column if not exists session_key_version integer,
  add column if not exists session_generation bigint not null default 0;

create table if not exists delivery_capability_compensation (
  id               text primary key,
  handoff_id       text not null,
  capability_ref   text not null unique,
  session_id       text,
  reason           text not null,
  status           text not null default 'PENDING'
    check (status in ('PENDING','DELETING','CLEANED')),
  cleanup_after    timestamptz not null default now(),
  claimed_by       text,
  claim_generation bigint not null default 0,
  claim_expires_at timestamptz,
  attempt_count    integer not null default 0,
  last_error_code  text,
  created_at       timestamptz not null default now(),
  cleaned_at       timestamptz
);

create index if not exists delivery_capability_compensation_due_idx
  on delivery_capability_compensation (cleanup_after, id)
  where status = 'PENDING';

create index if not exists delivery_capability_compensation_handoff_idx
  on delivery_capability_compensation (handoff_id, status, created_at);

create index if not exists delivery_capability_compensation_expired_claim_idx
  on delivery_capability_compensation (claim_expires_at, id)
  where status = 'DELETING';
