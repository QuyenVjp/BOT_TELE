-- Typed stock extends variants; external artifacts remain outside PostgreSQL.
create table variant_quantity_stock (
  variant_id text primary key references product_variant(id),
  available_quantity integer not null default 0 check (available_quantity >= 0),
  version integer not null default 1,
  updated_at timestamptz not null default now()
);
create table quantity_stock_ledger (
  id text primary key,
  variant_id text not null references product_variant(id),
  order_id text references "order"(id),
  entry_type text not null check (entry_type in ('ADJUST','RESERVE','RELEASE','DELIVER')),
  quantity_delta integer not null,
  quantity_after integer not null check (quantity_after >= 0),
  parent_ledger_id text references quantity_stock_ledger(id),
  expires_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  check (entry_type <> 'RESERVE' or (order_id is not null and quantity_delta < 0 and expires_at is not null)),
  check (entry_type <> 'RELEASE' or (parent_ledger_id is not null and quantity_delta > 0))
);
create unique index quantity_stock_order_reserve_uq on quantity_stock_ledger(order_id) where entry_type='RESERVE';
create unique index quantity_stock_release_uq on quantity_stock_ledger(parent_ledger_id) where entry_type='RELEASE';
create table variant_file_artifact (
  id text primary key,
  variant_id text not null references product_variant(id),
  version integer not null check (version > 0),
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  storage_reference text not null,
  telegram_file_id text,
  telegram_file_unique_id text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (variant_id, version)
);
create unique index variant_file_active_uq on variant_file_artifact(variant_id) where is_active;
create table variant_service_fulfillment (
  variant_id text primary key references product_variant(id),
  fulfillment_type text not null check (fulfillment_type in ('MANUAL_FULFILLMENT','UNLIMITED_SERVICE')),
  instructions text not null check (length(trim(instructions)) > 0),
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);
