-- Durable wallet top-up amount selection before VietQR intent creation.
create table if not exists wallet_topup_selection (
  customer_id text primary key references customer (id) on delete cascade,
  amount_vnd bigint not null check (amount_vnd >= 0),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists wallet_topup_selection_expiry_idx
  on wallet_topup_selection (expires_at);
