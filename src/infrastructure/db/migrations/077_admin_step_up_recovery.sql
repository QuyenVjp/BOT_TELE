-- Secure local lost-factor recovery for the single root-admin TOTP factor.
--
-- The active factor remains in admin_step_up_secret until a pending candidate is
-- verified. PostgreSQL stores only opaque Vault references; candidate material
-- is short-lived and one-per-admin. Recovery attempts use the existing
-- append-only attempt ledger with a separate purpose so a recovery lockout
-- cannot accidentally consume the normal step-up budget.

alter table admin_step_up_secret
  add column if not exists factor_version integer not null default 1;

alter table admin_step_up_secret
  drop constraint if exists admin_step_up_secret_factor_version_ck;
alter table admin_step_up_secret
  add constraint admin_step_up_secret_factor_version_ck check (factor_version > 0);

alter table admin_step_up_attempt
  add column if not exists purpose text not null default 'STEP_UP',
  add column if not exists recovery_candidate_id text;

alter table admin_step_up_attempt
  drop constraint if exists admin_step_up_attempt_purpose_ck;
alter table admin_step_up_attempt
  add constraint admin_step_up_attempt_purpose_ck check (
    (purpose = 'STEP_UP' and recovery_candidate_id is null)
    or (purpose = 'RECOVERY' and recovery_candidate_id is not null)
  );

-- Migration 069 accidentally made every v2 grant require revoked_at IS NULL,
-- which makes revocation itself violate the constraint. Revocation is historical
-- state, not a binding invariant, so keep it out of the v2 shape check.
alter table admin_step_up_grant
  drop constraint if exists admin_step_up_grant_v2_binding_ck;
alter table admin_step_up_grant
  add constraint admin_step_up_grant_v2_binding_ck check (
    authorization_version = 1
    or (
      action_key is not null
      and resource_type is not null
      and resource_id is not null
      and resource_version is not null
      and payload_hash is not null
      and payload_hash ~ '^[0-9a-f]{64}$'
    )
  );

create table if not exists admin_step_up_recovery_candidate (
  admin_telegram_user_id text primary key,
  candidate_id text not null unique,
  vault_ref text not null,
  previous_factor_version integer not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint admin_step_up_recovery_candidate_window_ck check (expires_at > created_at),
  constraint admin_step_up_recovery_candidate_version_ck check (previous_factor_version > 0)
);

create index if not exists admin_step_up_recovery_attempt_lookup_idx
  on admin_step_up_attempt (admin_telegram_user_id, purpose, recovery_candidate_id, attempted_at desc);
