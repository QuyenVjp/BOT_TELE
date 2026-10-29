-- Repair supplier_order fields that were introduced by provider-neutral purchase
-- recovery work but were absent from some deployed snapshots. Existing evidence is
-- retained: UNKNOWN rows keep external_order_id and gain a separate query_key.

alter table supplier_order
  add column if not exists query_key text,
  add column if not exists request_fingerprint_version integer,
  add column if not exists provider_client_order_id text,
  add column if not exists response_fingerprint text,
  add column if not exists attempt_count integer,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists retry_after_seconds integer,
  add column if not exists uncertain_at timestamptz,
  add column if not exists needs_review_at timestamptz;

-- Legacy hashes predate fingerprint versioning. New writes use v2 while old
-- rows remain explicitly classified as v1.
update supplier_order
set request_fingerprint_version = 1
where request_fingerprint_version is null;

alter table supplier_order
  alter column request_fingerprint_version set default 2,
  alter column request_fingerprint_version set not null;

-- Older UNKNOWN rows stored the provider lookup key in external_order_id. Copy it
-- to the durable lookup column without changing the original provider evidence.
update supplier_order
set query_key = external_order_id
where status = 'UNKNOWN'
  and query_key is null
  and external_order_id is not null;

-- 093 introduced attempt_count as a non-negative counter. Repair a partially
-- deployed nullable column before restoring its default and NOT NULL invariant.
update supplier_order
set attempt_count = 0
where attempt_count is null;

alter table supplier_order
  alter column attempt_count set default 0,
  alter column attempt_count set not null;

-- Add each CHECK only when an equivalent CHECK is not already present. If a
-- same-named stale CHECK exists, replace that named constraint rather than
-- creating a duplicate constraint with a different name.
do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'supplier_order'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ~* 'attempt_count[[:space:]]*>[[:space:]]*=[[:space:]]*0'
  ) then
    alter table supplier_order drop constraint if exists supplier_order_attempt_count_chk;
    alter table supplier_order
      add constraint supplier_order_attempt_count_chk check (attempt_count >= 0);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'supplier_order'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ~* 'retry_after_seconds'
      and pg_get_constraintdef(c.oid) ~* '0'
      and pg_get_constraintdef(c.oid) ~* '86400'
  ) then
    alter table supplier_order drop constraint if exists supplier_order_retry_after_chk;
    alter table supplier_order
      add constraint supplier_order_retry_after_chk check (
        retry_after_seconds is null or retry_after_seconds between 0 and 86_400
      );
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'supplier_order'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ~* 'request_fingerprint_version'
      and pg_get_constraintdef(c.oid) ~* '1'
      and pg_get_constraintdef(c.oid) ~* '2'
  ) then
    alter table supplier_order drop constraint if exists supplier_order_request_fingerprint_version_chk;
    alter table supplier_order
      add constraint supplier_order_request_fingerprint_version_chk
      check (request_fingerprint_version in (1, 2));
  end if;
end;
$$;

-- Restore the provider-client and durable lookup uniqueness guarantees without
-- adding another equivalent index when a prior deployment named it differently.
do $$
begin
  if not exists (
    select 1
    from pg_index i
    where i.indrelid = 'supplier_order'::regclass
      and i.indisunique
      and pg_get_indexdef(i.indexrelid) ~* 'supplier_id.*provider_client_order_id'
      and pg_get_expr(i.indpred, i.indrelid) ~* 'provider_client_order_id[[:space:]]+is[[:space:]]+not[[:space:]]+null'
  ) then
    drop index if exists supplier_order_provider_client_uq;
    create unique index supplier_order_provider_client_uq
      on supplier_order (supplier_id, provider_client_order_id)
      where provider_client_order_id is not null;
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_index i
    where i.indrelid = 'supplier_order'::regclass
      and i.indisunique
      and pg_get_indexdef(i.indexrelid) ~* 'supplier_id.*query_key'
      and pg_get_expr(i.indpred, i.indrelid) ~* 'query_key[[:space:]]+is[[:space:]]+not[[:space:]]+null'
  ) then
    drop index if exists supplier_order_query_key_uq;
    create unique index supplier_order_query_key_uq
      on supplier_order (supplier_id, query_key)
      where query_key is not null;
  end if;
end;
$$;

-- These indexes are part of the original supplier-order idempotency contract;
-- IF NOT EXISTS repairs a snapshot where the DDL receipt was recorded but the
-- index was not present.
create unique index if not exists supplier_order_idempotency_uq
  on supplier_order (supplier_id, idempotency_key);

create unique index if not exists supplier_order_external_uq
  on supplier_order (supplier_id, external_order_id)
  where external_order_id is not null;
