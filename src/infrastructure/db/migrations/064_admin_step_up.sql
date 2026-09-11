-- RFC 6238 TOTP step-up for high-risk root-admin actions (THREAT_MODEL SEC-002).
--
-- The TOTP seed itself never lands in a table: it lives behind the vault
-- boundary and `admin_step_up_secret` stores only the opaque vault reference.
-- The remaining two tables hold the brute-force counter (append-only, so a
-- restart cannot reset it) and the short-lived, single-use, category-bound
-- authorisation grants.

create table if not exists admin_step_up_secret (
  admin_telegram_user_id text primary key,
  vault_ref text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz null
);

create table if not exists admin_step_up_attempt (
  id text primary key,
  admin_telegram_user_id text not null,
  attempted_at timestamptz not null default now(),
  succeeded boolean not null
);

create index if not exists admin_step_up_attempt_admin_time_idx
  on admin_step_up_attempt (admin_telegram_user_id, attempted_at desc);

-- Append-only: an attempt is evidence of a factor check and is never rewritten.
create or replace function admin_step_up_reject_attempt_mutation() returns trigger language plpgsql as $$
begin
  raise exception
    '%.% is append-only; a step-up attempt cannot be revised',
    tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end
$$;

drop trigger if exists admin_step_up_attempt_append_only on admin_step_up_attempt;
create trigger admin_step_up_attempt_append_only
before update or delete on admin_step_up_attempt
for each row execute function admin_step_up_reject_attempt_mutation();

create table if not exists admin_step_up_grant (
  id text primary key,
  admin_telegram_user_id text not null,
  category text not null check (
    category in (
      'WALLET_ADJUSTMENT', 'PAYMENT_OVERRIDE', 'REFUND', 'SUPPLIER_CONFIG',
      'DELIVERY_REISSUE', 'BULK_PRICE_CHANGE', 'PERMISSION_CHANGE',
      'SECURITY_CONFIG', 'BROADCAST'
    )
  ),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  -- A grant is always a window: it can never be born already expired.
  constraint admin_step_up_grant_window_ck check (expires_at > issued_at)
);

create index if not exists admin_step_up_grant_lookup_idx
  on admin_step_up_grant (admin_telegram_user_id, category, expires_at);
