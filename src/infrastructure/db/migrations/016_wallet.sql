-- Wallet store credit tables (Feature 001 follow-up sprint).
-- Closed-loop only: no withdrawal, no cash-out, no P2P transfer.

create table if not exists wallet_account (
  id text primary key,
  customer_id text not null references customer (id),
  balance_vnd bigint not null default 0 check (balance_vnd >= 0),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists wallet_account_customer_uq
  on wallet_account (customer_id);

create table if not exists wallet_ledger (
  id text primary key,
  wallet_account_id text not null references wallet_account (id),
  entry_type text not null check (entry_type in ('CREDIT', 'DEBIT')),
  amount_vnd bigint not null check (amount_vnd > 0),
  balance_before_vnd bigint not null check (balance_before_vnd >= 0),
  balance_after_vnd bigint not null check (balance_after_vnd >= 0),
  idempotency_key text not null,
  correlation_id text not null,
  reason text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists wallet_ledger_account_idempotency_uq
  on wallet_ledger (wallet_account_id, idempotency_key);

create index if not exists wallet_ledger_account_created_idx
  on wallet_ledger (wallet_account_id, created_at desc, id desc);

create table if not exists wallet_topup_intent (
  id text primary key,
  customer_id text not null references customer (id),
  wallet_account_id text not null references wallet_account (id),
  payment_intent_id text references payment_intent (id),
  amount_vnd bigint not null check (amount_vnd > 0),
  merchant_account_id text not null,
  transfer_content text not null,
  status text not null check (status in ('CREATED', 'PRESENTED', 'SUCCEEDED', 'EXPIRED', 'FAILED', 'NEEDS_REVIEW')),
  expires_at timestamptz not null,
  presented_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  version integer not null default 1
);

create unique index if not exists wallet_topup_intent_active_uq
  on wallet_topup_intent (customer_id)
  where status in ('CREATED', 'PRESENTED');

create unique index if not exists wallet_topup_intent_content_uq
  on wallet_topup_intent (transfer_content)
  where status in ('CREATED', 'PRESENTED');
