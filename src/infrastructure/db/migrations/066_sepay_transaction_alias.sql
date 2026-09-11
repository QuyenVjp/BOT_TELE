-- 066 — one physical SePay transfer, one canonical bank_transaction row.
--
-- A single bank transfer reaches this system through two surfaces carrying
-- DIFFERENT provider ids: the webhook carries an integer (`92704`), the API v2
-- transaction list carries a UUID (`api:9f0c…`). `bank_transaction_provider_uq`
-- is unique on (provider, provider_transaction_id), so the second surface could
-- not see the first row and inserted a second canonical row for the same money.
-- SePay documents no translation between the two id spaces and offers no API v2
-- lookup by webhook id, so identity must be recorded here, not derived remotely.
--
-- This migration adds three things and rewrites no financial history:
--   * `bank_transaction_alias` — every provider id that refers to one canonical
--     row. The unique index on (provider, alias_type, alias_value) is the dedupe
--     guarantee: one alias value can never point at two rows.
--   * `bank_transaction.correlation_key` — a candidate FINDER for the
--     cross-source case. Deliberately NOT unique: the ingestion query decides
--     (one candidate ⇒ merge, more than one ⇒ review), never an index.
--   * a partial unique index that enforces "one payment intent settles once".

-- ---------------------------------------------------------------------------
-- Provider aliases
-- ---------------------------------------------------------------------------

create table if not exists bank_transaction_alias (
  id                  text primary key,
  bank_transaction_id text not null references bank_transaction (id),
  provider            text not null,
  alias_type          text not null check (alias_type in
                        ('webhook_legacy_id','api_v2_uuid','provider_reference')),
  alias_value         text not null,
  created_at          timestamptz not null default now()
);

-- The dedupe guarantee. A retried webhook, a reconciled API row, and a replay
-- all collide here instead of writing a second bank_transaction.
create unique index if not exists bank_transaction_alias_uq
  on bank_transaction_alias (provider, alias_type, alias_value);

create index if not exists bank_transaction_alias_transaction_idx
  on bank_transaction_alias (bank_transaction_id);

-- `provider_reference` is reserved vocabulary only. Bank reference codes are NOT
-- globally unique (docs: some banks send none at all, and formats differ per
-- bank), so a code is never used as a global alias — it participates only inside
-- the account-scoped correlation key below.

-- ---------------------------------------------------------------------------
-- Correlation key (candidate finder, never a uniqueness constraint)
-- ---------------------------------------------------------------------------

alter table bank_transaction
  add column if not exists correlation_key text;

-- Non-unique on purpose: historical rows are allowed to share a key, and the
-- ingestion query is what decides whether an arrival merges or needs review.
create index if not exists bank_transaction_correlation_idx
  on bank_transaction (provider, correlation_key, transacted_at);

-- The single definition of the key. The TypeScript builder
-- (`bankTransactionCorrelationKey` in src/modules/payments/repository.ts) must
-- produce exactly this string — tests/integration/sepay-cross-source-identity
-- asserts the two agree on the same inputs.
--
--   sepay | merchant_account_id | direction | amount_vnd | normalize(reference)
--
-- normalize = btrim → collapse internal whitespace → upper.
-- A null/whitespace-only reference yields NULL and nothing correlates on it:
-- without a bank reference there is no per-account-unique field, and matching on
-- amount+time alone could merge two legitimate transfers. The time window is NOT
-- part of the key (a bucket boundary would break matching across it); the
-- ingestion query applies the tolerance.
create or replace function bank_transaction_correlation_key(
  p_merchant_account_id text,
  p_direction text,
  p_amount_vnd bigint,
  p_reference text
) returns text
language sql
immutable
as $$
  select case
    when btrim(coalesce(p_reference, '')) = '' then null
    else 'sepay' || '|' || p_merchant_account_id || '|' || p_direction || '|' ||
         p_amount_vnd::text || '|' ||
         upper(regexp_replace(btrim(p_reference), '[ \t\n\r\f\v]+', ' ', 'g'))
  end
$$;

-- ---------------------------------------------------------------------------
-- Backfill: label existing rows, never merge them
-- ---------------------------------------------------------------------------

-- Each row labels its own provider id so a later arrival on that surface
-- resolves to it: `api:` carries the v2 UUID, and EVERYTHING else came from the
-- webhook surface. The first version only labelled ids matching `^[0-9]+$` or
-- `api:%`, which silently skipped rows whose id is neither (a fixture or a
-- historical import, e.g. `SEPAY-<uuid>`); those got no alias at all, so a later
-- cross-surface arrival could not link to them. The webhook is the only other
-- surface, so "not v2" means "webhook" and every row can be labelled.
insert into bank_transaction_alias (id, bank_transaction_id, provider, alias_type, alias_value)
select gen_random_uuid()::text, bt.id, bt.provider,
       case when bt.provider_transaction_id like 'api:%' then 'api_v2_uuid'
            else 'webhook_legacy_id'
       end,
       case when bt.provider_transaction_id like 'api:%' then substr(bt.provider_transaction_id, 5)
            else bt.provider_transaction_id
       end
from bank_transaction bt
where length(bt.provider_transaction_id) > 0
on conflict (provider, alias_type, alias_value) do nothing;

-- Every row must now carry at least one alias. A row without one is invisible to
-- step 1 of ingestion, which is where cross-surface linking starts, so this is a
-- correctness condition rather than a nicety — fail instead of shipping it.
do $$
declare
  unlabelled bigint;
begin
  select count(*) into unlabelled
  from bank_transaction bt
  where not exists (
    select 1 from bank_transaction_alias a where a.bank_transaction_id = bt.id
  );
  if unlabelled > 0 then
    raise exception '066: % bank_transaction row(s) were left without an alias', unlabelled;
  end if;
end $$;

update bank_transaction
set correlation_key = bank_transaction_correlation_key(
      merchant_account_id, direction, amount_vnd, reference
    )
where correlation_key is null;

-- Historical rows that now share a correlation key are EXPECTED: this migration
-- labels rows, it never resolves them (no delete, no merge of financial
-- history). Two shared rows are exactly the case ingestion refuses to guess at,
-- so the count is recorded for operators and the rows are left untouched.
do $$
declare
  shared_keys bigint;
  shared_rows bigint;
begin
  select count(*), coalesce(sum(rows_per_key), 0)
    into shared_keys, shared_rows
  from (
    select count(*) as rows_per_key
    from bank_transaction
    where correlation_key is not null
    group by provider, correlation_key
    having count(*) > 1
  ) shared;

  if shared_keys > 0 then
    raise notice '066: % correlation key(s) shared by % historical bank_transaction row(s); left unmerged for review',
      shared_keys, shared_rows;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Cross-source ambiguity is a first-class discrepancy
-- ---------------------------------------------------------------------------

-- Money arriving through a second surface for an intent a sibling row already
-- settled is NOT an UNMATCHED payment (nothing is unsettled) and NOT
-- already-present (a human must decide). It gets its own type.
do $$
declare
  existing text;
begin
  for existing in
    select conname
    from pg_constraint
    where conrelid = 'discrepancy'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%REFUND_MISMATCH%'
  loop
    execute format('alter table discrepancy drop constraint %I', existing);
  end loop;
end $$;

alter table discrepancy
  add constraint discrepancy_type_check check (type in
    ('UNDERPAYMENT','OVERPAYMENT','LATE_PAYMENT','WRONG_CONTENT','WRONG_ACCOUNT',
     'UNMATCHED','REFERENCE_COLLISION','REFUND_MISMATCH','AMBIGUOUS_CORRELATION'));

-- ---------------------------------------------------------------------------
-- One intent settles once — enforced by the database, not only by application
-- state checks.
-- ---------------------------------------------------------------------------

-- `payment_allocation_intent_idx` is non-unique and no constraint stopped a
-- second SETTLED allocation for one intent. Existing rows are inspected first:
-- a database that already violates this must fail loudly with the offending
-- payment_intent ids, never have rows dropped to make the index fit.
do $$
declare
  offenders text;
begin
  select string_agg(payment_intent_id, ', ' order by payment_intent_id)
    into offenders
  from (
    select payment_intent_id
    from payment_allocation
    where status = 'SETTLED'
    group by payment_intent_id
    having count(*) > 1
  ) duplicated;

  if offenders is not null then
    raise exception '066: payment_allocation already holds multiple SETTLED rows for payment_intent_id(s): %',
      offenders;
  end if;
end $$;

create unique index if not exists payment_allocation_settled_intent_uq
  on payment_allocation (payment_intent_id)
  where status = 'SETTLED';

-- ---------------------------------------------------------------------------
-- Identity is only sound if every alias resolves. The foreign key makes a
-- dangling alias unreachable; this check fails the migration loudly anyway, so
-- a careless later edit (dropping the FK, a partial restore) cannot leave an
-- alias pointing at nothing. Last statement on purpose: nothing may follow a
-- migration that just declared the identity table unsound.
-- ---------------------------------------------------------------------------

do $$
declare
  dangling bigint;
begin
  select count(*)
    into dangling
  from bank_transaction_alias a
  left join bank_transaction bt on bt.id = a.bank_transaction_id
  where bt.id is null;

  if dangling > 0 then
    raise exception '066: % bank_transaction_alias row(s) point at a missing bank_transaction',
      dangling;
  end if;
end $$;
