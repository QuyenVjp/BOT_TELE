-- Double-entry store-credit ledger (THREAT_MODEL SEC-002).
--
-- `wallet_ledger` stays exactly as it is: it is the customer-facing movement
-- list and the existing idempotency scope. This migration adds the accounting
-- layer *underneath* it so every movement is backed by a balanced posting set:
--
--   ledger_transaction  one immutable business event (unique idempotency key)
--   ledger_posting      immutable DEBIT/CREDIT legs; SUM(DEBIT) = SUM(CREDIT)
--   ledger_account      chart of accounts: 4 system accounts + one customer
--                       wallet liability account per wallet_account
--
-- `wallet_account.balance_vnd` becomes a materialised cache of the customer
-- wallet account; a deferred constraint trigger refuses to commit a transaction
-- where the cache disagrees with the postings. Postings are append-only: a
-- correction is a new transaction, never an UPDATE of history.
--
-- Money stays exact integer minor units (bigint VND). No floating point.

-- ---------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------
create table if not exists ledger_account (
  id text primary key,
  code text not null,
  account_type text not null check (account_type in ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE', 'EQUITY')),
  normal_side text not null check (normal_side in ('DEBIT', 'CREDIT')),
  currency text not null default 'VND' check (currency = 'VND'),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'FROZEN', 'CLOSED')),
  wallet_account_id text references wallet_account (id),
  created_at timestamptz not null default now(),
  -- Normal side is a property of the account type, not an operator choice.
  constraint ledger_account_normal_side_chk check (
    normal_side = case account_type
      when 'ASSET' then 'DEBIT'
      when 'EXPENSE' then 'DEBIT'
      else 'CREDIT'
    end
  ),
  -- Only customer wallet liability accounts are wallet-owned; system accounts are not.
  constraint ledger_account_wallet_owner_chk check (
    (account_type = 'LIABILITY' and wallet_account_id is not null)
    or (account_type <> 'LIABILITY' and wallet_account_id is null)
  )
);

create unique index if not exists ledger_account_code_uq on ledger_account (code);

-- NULLs are distinct in a PostgreSQL unique index, so the five system accounts
-- (wallet_account_id is null) coexist while each wallet has exactly one account.
create unique index if not exists ledger_account_wallet_uq
  on ledger_account (wallet_account_id);

-- ---------------------------------------------------------------------------
-- Transactions (immutable business events)
-- ---------------------------------------------------------------------------
create table if not exists ledger_transaction (
  id text primary key,
  transaction_type text not null check (
    transaction_type in (
      'OPENING', 'TOPUP', 'PURCHASE', 'REFUND', 'CREDIT_ADJUSTMENT', 'DEBIT_ADJUSTMENT'
    )
  ),
  wallet_account_id text not null references wallet_account (id),
  idempotency_key text not null,
  correlation_id text not null,
  reason text not null,
  status text not null default 'POSTED' check (status = 'POSTED'),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Globally unique: the same idempotency key can never post twice, on any wallet.
create unique index if not exists ledger_transaction_idempotency_uq
  on ledger_transaction (idempotency_key);

create index if not exists ledger_transaction_wallet_created_idx
  on ledger_transaction (wallet_account_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Postings (immutable ledger legs)
-- ---------------------------------------------------------------------------
create table if not exists ledger_posting (
  id text primary key,
  transaction_id text not null references ledger_transaction (id),
  account_id text not null references ledger_account (id),
  side text not null check (side in ('DEBIT', 'CREDIT')),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'VND' check (currency = 'VND'),
  created_at timestamptz not null default now()
);

create index if not exists ledger_posting_transaction_idx on ledger_posting (transaction_id);

create index if not exists ledger_posting_account_created_idx
  on ledger_posting (account_id, created_at desc, id desc);

-- An account may appear at most once per side inside one transaction. This makes
-- an accidental double leg a database error instead of a silent imbalance.
create unique index if not exists ledger_posting_once_per_side_uq
  on ledger_posting (transaction_id, account_id, side);

-- ---------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------
create or replace function ledger_reject_mutation() returns trigger language plpgsql as $$
begin
  raise exception
    '%.% is append-only; correct history with a new compensating transaction',
    tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end
$$;

drop trigger if exists ledger_posting_append_only on ledger_posting;
create trigger ledger_posting_append_only
before update or delete on ledger_posting
for each row execute function ledger_reject_mutation();

drop trigger if exists ledger_transaction_append_only on ledger_transaction;
create trigger ledger_transaction_append_only
before update or delete on ledger_transaction
for each row execute function ledger_reject_mutation();

-- ---------------------------------------------------------------------------
-- Invariant 1: every transaction balances (deferred, checked at COMMIT)
-- ---------------------------------------------------------------------------
create or replace function ledger_assert_transaction_balanced() returns trigger language plpgsql as $$
declare
  debit_total bigint;
  credit_total bigint;
begin
  select
    coalesce(sum(amount_minor) filter (where side = 'DEBIT'), 0),
    coalesce(sum(amount_minor) filter (where side = 'CREDIT'), 0)
  into debit_total, credit_total
  from ledger_posting
  where transaction_id = new.transaction_id;

  if debit_total <> credit_total then
    raise exception
      'unbalanced ledger transaction %: debits=% credits=%',
      new.transaction_id, debit_total, credit_total
      using errcode = 'check_violation';
  end if;

  return null;
end
$$;

drop trigger if exists ledger_posting_balanced on ledger_posting;
create constraint trigger ledger_posting_balanced
after insert on ledger_posting
deferrable initially deferred
for each row execute function ledger_assert_transaction_balanced();

-- ---------------------------------------------------------------------------
-- Invariant 2: the materialised wallet balance equals the ledger (deferred)
-- ---------------------------------------------------------------------------
create or replace function ledger_assert_wallet_cache_matches() returns trigger language plpgsql as $$
declare
  ledger_balance bigint;
  cached_balance bigint;
begin
  select coalesce(
           sum(case when p.side = 'CREDIT' then p.amount_minor else -p.amount_minor end), 0)
  into ledger_balance
  from ledger_posting p
  join ledger_account a on a.id = p.account_id
  where a.wallet_account_id = new.wallet_account_id;

  select balance_vnd into cached_balance
  from wallet_account
  where id = new.wallet_account_id;

  if cached_balance is distinct from ledger_balance then
    raise exception
      'wallet % balance cache (%) disagrees with ledger (%)',
      new.wallet_account_id, cached_balance, ledger_balance
      using errcode = 'check_violation';
  end if;

  return null;
end
$$;

drop trigger if exists ledger_transaction_wallet_cache on ledger_transaction;
create constraint trigger ledger_transaction_wallet_cache
after insert on ledger_transaction
deferrable initially deferred
for each row execute function ledger_assert_wallet_cache_matches();

-- The check above only runs when a ledger transaction is written. This one runs
-- whenever the cached balance itself moves, so a direct
-- `update wallet_account set balance_vnd = …` cannot drift from the ledger and
-- an account cannot be created holding unreconciled money.
--
-- The row is re-read by id instead of trusting `new`: deferred events carry the
-- tuple image from when they were queued, so inside one transaction that inserts
-- a wallet and then funds it, the INSERT event would otherwise compare a stale
-- zero against the committed ledger.
create or replace function ledger_assert_wallet_row_matches_ledger() returns trigger language plpgsql as $$
declare
  ledger_balance bigint;
  cached_balance bigint;
begin
  select balance_vnd into cached_balance
  from wallet_account
  where id = new.id;

  if not found then
    return null;
  end if;

  select coalesce(
           sum(case when p.side = 'CREDIT' then p.amount_minor else -p.amount_minor end), 0)
  into ledger_balance
  from ledger_posting p
  join ledger_account a on a.id = p.account_id
  where a.wallet_account_id = new.id;

  if cached_balance is distinct from ledger_balance then
    raise exception
      'wallet % balance cache (%) disagrees with ledger (%)',
      new.id, cached_balance, ledger_balance
      using errcode = 'check_violation';
  end if;

  return null;
end
$$;

drop trigger if exists ledger_wallet_balance_cache on wallet_account;
create constraint trigger ledger_wallet_balance_cache
after insert or update of balance_vnd on wallet_account
deferrable initially deferred
for each row execute function ledger_assert_wallet_row_matches_ledger();

-- Funding that arrives outside the application (a restored dump, an operator
-- correction) is recorded as an explicit OPENING transaction rather than by
-- writing the cached balance, so the two never disagree.
create or replace function ledger_record_opening_balance(
  p_wallet_account_id text,
  p_amount_minor bigint
) returns text
language plpgsql
as $$
declare
  v_transaction_id text;
begin
  if p_amount_minor < 0 then
    raise exception 'opening balance must not be negative' using errcode = 'check_violation';
  end if;

  v_transaction_id := 'ltx_open_' || p_wallet_account_id;

  insert into ledger_transaction (
    id, transaction_type, wallet_account_id, idempotency_key, correlation_id, reason
  ) values (
    v_transaction_id, 'OPENING', p_wallet_account_id, 'opening:' || p_wallet_account_id,
    'opening-balance', 'opening balance'
  )
  on conflict (idempotency_key) do nothing;

  if p_amount_minor > 0 then
    insert into ledger_posting (id, transaction_id, account_id, side, amount_minor)
    select 'lp_open_a_' || p_wallet_account_id, v_transaction_id, a.id, 'CREDIT', p_amount_minor
    from ledger_account a
    where a.wallet_account_id = p_wallet_account_id
    union all
    select 'lp_open_b_' || p_wallet_account_id, v_transaction_id, c.id, 'DEBIT', p_amount_minor
    from ledger_account c
    where c.code = 'EXTERNAL:BANK_SETTLEMENT'
    on conflict do nothing;
  end if;

  return v_transaction_id;
end
$$;

-- ---------------------------------------------------------------------------
-- Every wallet gets its liability account automatically
-- ---------------------------------------------------------------------------
create or replace function ledger_open_wallet_account() returns trigger language plpgsql as $$
begin
  insert into ledger_account (id, code, account_type, normal_side, wallet_account_id)
  values ('lac_' || new.id, 'CUSTOMER_WALLET:' || new.id, 'LIABILITY', 'CREDIT', new.id)
  on conflict (wallet_account_id) do nothing;
  return new;
end
$$;

drop trigger if exists wallet_account_open_ledger_account on wallet_account;
create trigger wallet_account_open_ledger_account
after insert on wallet_account
for each row execute function ledger_open_wallet_account();

-- ---------------------------------------------------------------------------
-- System accounts (funding, revenue and correction counter-legs)
-- ---------------------------------------------------------------------------
insert into ledger_account (id, code, account_type, normal_side)
values
  ('lac_sys_bank_settlement', 'EXTERNAL:BANK_SETTLEMENT', 'ASSET', 'DEBIT'),
  ('lac_sys_shop_revenue', 'SHOP:REVENUE', 'REVENUE', 'CREDIT'),
  ('lac_sys_refund_expense', 'SHOP:REFUND_EXPENSE', 'EXPENSE', 'DEBIT'),
  ('lac_sys_adjustment_expense', 'SHOP:ADJUSTMENT_EXPENSE', 'EXPENSE', 'DEBIT'),
  ('lac_sys_adjustment_income', 'SHOP:ADJUSTMENT_INCOME', 'REVENUE', 'CREDIT')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Derived balances (the ledger is authoritative; the view is the report)
-- ---------------------------------------------------------------------------
create or replace view ledger_account_balance as
select
  a.id as account_id,
  a.code,
  a.account_type,
  a.normal_side,
  a.wallet_account_id,
  a.status,
  coalesce(sum(case when p.side = 'DEBIT' then p.amount_minor else -p.amount_minor end), 0)::bigint
    as signed_minor,
  coalesce(
    sum(case when p.side = a.normal_side then p.amount_minor else -p.amount_minor end), 0)::bigint
    as normal_minor
from ledger_account a
left join ledger_posting p on p.account_id = a.id
group by a.id, a.code, a.account_type, a.normal_side, a.wallet_account_id, a.status;

-- ---------------------------------------------------------------------------
-- Backfill: convert existing single-entry history into balanced transactions
-- ---------------------------------------------------------------------------
-- Deterministic mapping from the historical idempotency-key convention (the same
-- convention `wallet_ledger` already uses) to the counter-account leg.
create or replace function ledger_backfill_counter_account(entry_type text, idempotency_key text)
returns text
language plpgsql
immutable
as $$
begin
  if idempotency_key like 'topup:%' then
    return 'EXTERNAL:BANK_SETTLEMENT';
  elsif idempotency_key like 'purchase:%' then
    return 'SHOP:REVENUE';
  elsif idempotency_key like 'refund:%' then
    return 'SHOP:REFUND_EXPENSE';
  elsif entry_type = 'CREDIT' then
    return 'SHOP:ADJUSTMENT_EXPENSE';
  else
    return 'SHOP:ADJUSTMENT_INCOME';
  end if;
end
$$;

create or replace function ledger_backfill_transaction_type(entry_type text, idempotency_key text)
returns text
language plpgsql
immutable
as $$
begin
  if idempotency_key like 'topup:%' then
    return 'TOPUP';
  elsif idempotency_key like 'purchase:%' then
    return 'PURCHASE';
  elsif idempotency_key like 'refund:%' then
    return 'REFUND';
  elsif entry_type = 'CREDIT' then
    return 'CREDIT_ADJUSTMENT';
  else
    return 'DEBIT_ADJUSTMENT';
  end if;
end
$$;

-- Wallets created before this migration have no liability account yet.
insert into ledger_account (id, code, account_type, normal_side, wallet_account_id)
select 'lac_' || w.id, 'CUSTOMER_WALLET:' || w.id, 'LIABILITY', 'CREDIT', w.id
from wallet_account w
on conflict (wallet_account_id) do nothing;

-- One historical movement -> one transaction + two postings, preserving the
-- original timestamp so the ledger reads in the same order the customer saw it.
insert into ledger_transaction (
  id, transaction_type, wallet_account_id, idempotency_key, correlation_id, reason, created_at
)
select
  'ltx_' || l.id,
  ledger_backfill_transaction_type(l.entry_type, l.idempotency_key),
  l.wallet_account_id,
  'wallet_ledger:' || l.id,
  l.correlation_id,
  l.reason,
  l.created_at
from wallet_ledger l
on conflict (idempotency_key) do nothing;

insert into ledger_posting (id, transaction_id, account_id, side, amount_minor, created_at)
select
  'lp_' || l.id || '_w',
  'ltx_' || l.id,
  a.id,
  l.entry_type,
  l.amount_vnd,
  l.created_at
from wallet_ledger l
join ledger_account a on a.wallet_account_id = l.wallet_account_id
on conflict do nothing;

insert into ledger_posting (id, transaction_id, account_id, side, amount_minor, created_at)
select
  'lp_' || l.id || '_c',
  'ltx_' || l.id,
  c.id,
  case when l.entry_type = 'CREDIT' then 'DEBIT' else 'CREDIT' end,
  l.amount_vnd,
  l.created_at
from wallet_ledger l
join ledger_account c
  on c.code = ledger_backfill_counter_account(l.entry_type, l.idempotency_key)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Migration gate: fail loudly rather than ship an inconsistent ledger
-- ---------------------------------------------------------------------------
do $$
declare
  orphans bigint;
  unbalanced bigint;
  mismatched bigint;
  duplicated bigint;
begin
  select count(*) into orphans
  from ledger_posting p
  left join ledger_transaction t on t.id = p.transaction_id
  left join ledger_account a on a.id = p.account_id
  where t.id is null or a.id is null;

  select count(*) into unbalanced
  from (
    select transaction_id
    from ledger_posting
    group by transaction_id
    having coalesce(sum(amount_minor) filter (where side = 'DEBIT'), 0)
         <> coalesce(sum(amount_minor) filter (where side = 'CREDIT'), 0)
  ) as u;

  select count(*) into mismatched
  from wallet_account w
  join ledger_account a on a.wallet_account_id = w.id
  left join ledger_posting p on p.account_id = a.id
  group by w.id, w.balance_vnd
  having w.balance_vnd <> coalesce(
    sum(case when p.side = 'CREDIT' then p.amount_minor else -p.amount_minor end), 0);

  select count(*) into duplicated
  from (
    select idempotency_key
    from ledger_transaction
    group by idempotency_key
    having count(*) > 1
  ) as d;

  if orphans > 0 or unbalanced > 0 or mismatched > 0 or duplicated > 0 then
    raise exception
      'ledger backfill failed: orphans=% unbalanced=% wallet_cache_mismatch=% duplicate_idempotency=%',
      orphans, unbalanced, mismatched, duplicated
      using errcode = 'check_violation';
  end if;
end
$$;
