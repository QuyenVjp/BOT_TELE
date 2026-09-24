create table if not exists referral_code (
  id text primary key,
  referrer_customer_id text not null references customer(id) on delete cascade,
  token text not null unique,
  token_hash text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (referrer_customer_id)
);

create table if not exists referral_attribution (
  id text primary key,
  referral_code_id text not null references referral_code(id),
  referrer_customer_id text not null references customer(id),
  referee_customer_id text not null references customer(id),
  status text not null default 'ATTRIBUTED' check (status in ('ATTRIBUTED','QUALIFIED','REJECTED')),
  qualifying_order_id text unique references "order"(id),
  rejection_reason text,
  created_at timestamptz not null default now(),
  unique (referee_customer_id)
);

create table if not exists referral_reward (
  id text primary key,
  attribution_id text not null unique references referral_attribution(id),
  referrer_customer_id text not null references customer(id),
  referee_customer_id text not null references customer(id),
  qualifying_order_id text not null unique references "order"(id),
  amount_vnd bigint not null check (amount_vnd > 0),
  status text not null default 'ISSUED' check (status in ('ISSUED','VOIDED')),
  created_at timestamptz not null default now()
);

create index if not exists referral_code_referrer_idx on referral_code (referrer_customer_id);
create index if not exists referral_attribution_referrer_idx on referral_attribution (referrer_customer_id, status);
