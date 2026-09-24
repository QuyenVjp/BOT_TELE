-- Small transactional promotion engine. A RESERVED redemption counts against limits
-- until the order is released or consumed, preventing parallel checkout overuse.
create table if not exists promotion (
  id                   text primary key,
  code_normalized      text not null unique,
  kind                 text not null check (kind in ('FIXED_VND','PERCENT')),
  value_vnd            bigint,
  value_percent        integer,
  starts_at            timestamptz,
  ends_at              timestamptz,
  max_total_uses       integer check (max_total_uses is null or max_total_uses > 0),
  max_uses_per_customer integer check (max_uses_per_customer is null or max_uses_per_customer > 0),
  minimum_order_value_vnd bigint not null default 0 check (minimum_order_value_vnd >= 0),
  product_id           text references product(id),
  variant_id           text references product_variant(id),
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (
    (kind = 'FIXED_VND' and value_vnd is not null and value_vnd > 0 and value_percent is null)
    or
    (kind = 'PERCENT' and value_percent between 1 and 100 and value_vnd is null)
  ),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check (variant_id is null or product_id is not null)
);

create table if not exists promotion_redemption (
  id             text primary key,
  promotion_id   text not null references promotion(id),
  order_id       text not null references "order"(id),
  customer_id    text not null references customer(id),
  code_normalized text not null,
  base_amount_vnd bigint not null check (base_amount_vnd > 0),
  discount_vnd   bigint not null check (discount_vnd >= 0),
  status         text not null check (status in ('RESERVED','CONSUMED','RELEASED')),
  created_at     timestamptz not null default now(),
  consumed_at    timestamptz,
  released_at    timestamptz,
  unique (promotion_id, order_id)
);

alter table "order"
  add column if not exists promotion_code text,
  add column if not exists promotion_discount_vnd bigint not null default 0 check (promotion_discount_vnd >= 0),
  add column if not exists promotion_snapshot jsonb not null default '{}'::jsonb;

create index if not exists promotion_redemption_customer_idx
  on promotion_redemption(promotion_id, customer_id, status);
create index if not exists promotion_redemption_order_idx
  on promotion_redemption(order_id);
