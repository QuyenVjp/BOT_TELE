-- Google Sheets projection metadata keeps safe inventory identifiers while
-- PostgreSQL/Vault remain the authorities. Bot inventory imports use the same
-- durable orphan compensation path; no spreadsheet credential transport exists.
alter table digital_asset
  add column if not exists masked_login text not null default '';

create table if not exists inventory_vault_orphan (
  id              text primary key,
  vault_ref       text not null unique,
  namespace       text not null check (namespace = 'asset'),
  correlation_id  text not null,
  reason          text not null,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

create index if not exists inventory_vault_orphan_open_idx
  on inventory_vault_orphan(created_at)
  where resolved_at is null;
