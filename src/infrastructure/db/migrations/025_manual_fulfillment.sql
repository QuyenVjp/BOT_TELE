create table manual_fulfillment_task (
  id text primary key,
  order_id text not null references "order"(id),
  customer_id text not null references customer(id),
  variant_id text not null references product_variant(id),
  fulfillment_type text not null check (fulfillment_type in ('MANUAL_FULFILLMENT','UNLIMITED_SERVICE')),
  instructions text not null check (length(trim(instructions)) > 0),
  status text not null check (status in ('OPEN','COMPLETED')),
  completed_by text,
  completed_at timestamptz,
  completion_correlation_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check ((status = 'OPEN' and completed_by is null and completed_at is null and completion_correlation_id is null)
    or (status = 'COMPLETED' and completed_by is not null and completed_at is not null and completion_correlation_id is not null))
);

create unique index manual_fulfillment_task_order_uq on manual_fulfillment_task(order_id);
create index manual_fulfillment_task_status_idx on manual_fulfillment_task(status, created_at);
