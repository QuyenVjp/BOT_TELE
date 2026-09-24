-- Google Sheets projection metadata keeps safe inventory identifiers while
-- PostgreSQL/Vault remain the authorities. Sheet-native inventory intake stores
-- only opaque Vault references and one-time challenge metadata.
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

create table if not exists google_sheets_inventory_intake_challenge (
  id                    text primary key,
  challenge_hash        text not null unique,
  spreadsheet_id         text not null,
  owner_email            text not null,
  owner_subject          text not null,
  admin_telegram_user_id text not null,
  variant_id             text not null references product_variant(id),
  input_vault_ref        text,
  preview_ready          integer not null check (preview_ready >= 0),
  preview_invalid        integer not null check (preview_invalid >= 0),
  preview_duplicates     integer not null check (preview_duplicates >= 0),
  cost_price_vnd         bigint,
  safe_note              text,
  status                 text not null check (status in ('PREVIEWED','PROCESSING','CONSUMED','EXPIRED')),
  expires_at             timestamptz not null,
  consumed_at            timestamptz,
  created_at             timestamptz not null default now()
);

create index if not exists google_sheets_inventory_intake_open_idx
  on google_sheets_inventory_intake_challenge(expires_at)
  where status in ('PREVIEWED','PROCESSING');
