-- Durable customer restock subscriptions and generation-based notification dedupe.
alter table product_variant add column if not exists restock_generation integer not null default 0;

create table if not exists restock_subscription (
  id text primary key,
  customer_id text not null references customer(id),
  variant_id text not null references product_variant(id),
  active boolean not null default true,
  notified_generation integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists restock_subscription_customer_variant_uq
  on restock_subscription(customer_id, variant_id);
create index if not exists restock_subscription_variant_active_idx
  on restock_subscription(variant_id) where active;
