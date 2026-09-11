-- Authorization-binding cutover for admin_step_up_grant.
--
-- Grants minted before this migration were category-only (and some were unbound to a
-- resource). They are historical evidence, not upgradeable authorization. Revoke them
-- before the v2 columns become live so a stale row can never authorize a production write.

alter table admin_step_up_grant
  add column if not exists authorization_version integer not null default 1,
  add column if not exists action_key text,
  add column if not exists resource_version text,
  add column if not exists payload_hash text,
  add column if not exists revoked_at timestamptz,
  add column if not exists revoke_reason text;

update admin_step_up_grant
set revoked_at = coalesce(revoked_at, now()),
    revoke_reason = coalesce(revoke_reason, 'authorization binding v2 cutover')
where authorization_version = 1
  and consumed_at is null
  and revoked_at is null;

alter table admin_step_up_grant
  drop constraint if exists admin_step_up_grant_authorization_version_ck,
  drop constraint if exists admin_step_up_grant_v2_binding_ck;

alter table admin_step_up_grant
  add constraint admin_step_up_grant_authorization_version_ck
    check (authorization_version in (1, 2)),
  add constraint admin_step_up_grant_v2_binding_ck
    check (
      authorization_version = 1
      or (
        action_key is not null
        and resource_type is not null
        and resource_id is not null
        and resource_version is not null
        and payload_hash is not null
        and payload_hash ~ '^[0-9a-f]{64}$'
        and revoked_at is null
      )
    );

-- Only live v2 grants belong in the lookup path. v1 rows remain queryable for audit/history.
drop index if exists admin_step_up_grant_lookup_idx;
create index admin_step_up_grant_lookup_idx
  on admin_step_up_grant (
    admin_telegram_user_id,
    category,
    action_key,
    resource_type,
    resource_id,
    resource_version,
    payload_hash,
    expires_at
  )
  where authorization_version = 2 and consumed_at is null and revoked_at is null;
