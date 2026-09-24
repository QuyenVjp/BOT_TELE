create table if not exists customer_promotion_draft (
  customer_id text primary key references customer(id) on delete cascade,
  code_normalized text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists customer_promotion_draft_expiry_idx
  on customer_promotion_draft (expires_at);
