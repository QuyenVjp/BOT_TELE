-- Shop-cancel refund obligation. Distinct from customer-side deposit forfeiture.
-- SHOP_CANCELLED / REFUND_DUE never set forfeited_at or reuse HOLD_EXPIRED.

create table if not exists shop_refund_obligation (
  id text primary key,
  preorder_id text not null unique references preorder_reservation(id),
  customer_id text not null references customer(id),
  amount_vnd bigint not null check (amount_vnd >= 0),
  status text not null check (status in ('OPEN', 'FULFILLED', 'CANCELLED')),
  reason text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shop_refund_obligation_open_idx
  on shop_refund_obligation (status, created_at)
  where status = 'OPEN';
