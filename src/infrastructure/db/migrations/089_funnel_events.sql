create table if not exists funnel_event_daily (
  event_date date not null,
  event_name text not null check (event_name in ('PRODUCT_VIEW','CHECKOUT_STARTED','PAYMENT_PRESENTED','PAYMENT_SUCCEEDED','DELIVERED')),
  variant_key text not null default '',
  variant_id text references product_variant(id),
  event_count integer not null default 0 check (event_count >= 0),
  primary key (event_date, event_name, variant_key)
);

create table if not exists funnel_event_receipt (
  event_key  text primary key check (length(event_key) between 1 and 200),
  event_date date not null,
  event_name text not null check (
    event_name in ('PRODUCT_VIEW','CHECKOUT_STARTED','PAYMENT_PRESENTED','PAYMENT_SUCCEEDED','DELIVERED')
  ),
  variant_key text not null default '',
  variant_id text references product_variant(id),
  created_at timestamptz not null default now()
);

create index if not exists funnel_event_receipt_date_idx
  on funnel_event_receipt(event_date, event_name);
