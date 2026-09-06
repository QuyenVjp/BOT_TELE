-- Durable admin inventory import workflow state.
create table if not exists admin_inventory_import (
  admin_telegram_user_id text primary key,
  status text not null check (status in ('WAITING_INPUT','READY','PROCESSING','COMMITTED','CANCELLED')),
  input_vault_ref text,
  preview_ready integer not null default 0,
  preview_invalid integer not null default 0,
  preview_duplicates integer not null default 0,
  preview_variants jsonb not null default '[]'::jsonb,
  expires_at timestamptz not null,
  imported_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists admin_inventory_import_expiry_idx
  on admin_inventory_import (expires_at);
