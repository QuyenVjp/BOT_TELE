-- Warranty claims, defect reports and prorated refunds (goal: warranty vertical).
--
-- Owner policy is final: the system calculates the prorated refund and may prepare a REFUND_DUE
-- obligation, but it never moves money. The admin verifies the delivered resource and performs the
-- bank transfer, then marks it paid. Nothing in this schema can pay out.
--
-- Reuse: the refund obligation is the existing `shop_refund_obligation` (from the shop-cancel flow)
-- generalized to also describe an order/claim payout, and replacements stay on the existing
-- `replacement_case`. This table adds only what had no home: the claim itself, its immutable
-- report-time financial snapshot, the evidence and the payout destination.

create table if not exists warranty_claim (
  id text primary key,
  claim_number text not null unique,
  customer_id text not null references customer(id),
  order_id text not null references "order"(id),
  variant_id text not null references product_variant(id),
  -- The sold asset the claim is about. Nullable: a quantity/service line has no single asset.
  original_asset_id text references digital_asset(id),
  issue_type text not null check (issue_type in (
    'ACCOUNT_LOCKED',
    'LOST_BENEFITS',
    'CANNOT_SIGN_IN',
    'TWO_FACTOR_PROBLEM',
    'WRONG_DELIVERY',
    'OTHER'
  )),
  customer_note text,
  -- Telegram file ids the customer attached as evidence. No credentials are ever stored here.
  evidence_file_ids text[] not null default '{}',

  -- Report-time snapshot. `reported_at` is the ONLY clock the refund calculation reads, so a slow
  -- admin review can never shrink what the customer is owed.
  reported_at timestamptz not null,
  warranty_start timestamptz not null,
  warranty_end timestamptz not null,
  warranty_days integer not null check (warranty_days >= 0),
  used_days integer not null check (used_days >= 0),
  remaining_days integer not null check (remaining_days >= 0),
  paid_amount_vnd bigint not null check (paid_amount_vnd >= 0),
  calculated_refund_vnd bigint not null check (calculated_refund_vnd >= 0),
  -- What the admin actually approved, when they adjust the recommendation.
  approved_refund_vnd bigint check (approved_refund_vnd >= 0),
  override_reason text,

  status text not null check (status in (
    'SUBMITTED',
    'TRIAGE',
    'WAITING_CUSTOMER',
    'VERIFIED_DEFECT',
    'REPLACEMENT_APPROVED',
    'REFUND_APPROVED',
    'REFUND_DUE',
    'REFUND_PAID',
    'REJECTED',
    'RESOLVED',
    'CANCELLED'
  )),
  rejection_reason text,

  replacement_case_id text references replacement_case(id),
  refund_obligation_id text references shop_refund_obligation(id),

  -- Refund destination, collected only when a refund is actually approved (goal §29/§30).
  refund_bank_name text,
  refund_account_number text,
  refund_account_holder text,
  refund_destination_confirmed_at timestamptz,

  review_sla_due_at timestamptz,
  reviewed_by text,
  reviewed_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

-- One active claim per delivered asset: a double tap or a duplicate submit must not open a second
-- case, and a closed case can be followed by a new one only through the normal flow.
create unique index if not exists warranty_claim_one_active_per_asset_uq
  on warranty_claim(order_id, original_asset_id)
  where original_asset_id is not null
    and status not in ('REJECTED', 'RESOLVED', 'CANCELLED', 'REFUND_PAID');

create index if not exists warranty_claim_customer_idx on warranty_claim(customer_id, created_at desc);
create index if not exists warranty_claim_status_idx on warranty_claim(status, created_at);
create index if not exists warranty_claim_sla_idx on warranty_claim(review_sla_due_at)
  where status in ('SUBMITTED', 'TRIAGE');

-- Customer-safe timeline. Internal ids and money movement live in the claim and its obligation.
create table if not exists warranty_claim_event (
  id text primary key,
  claim_id text not null references warranty_claim(id),
  kind text not null,
  safe_note text,
  created_at timestamptz not null default now()
);

create index if not exists warranty_claim_event_claim_idx on warranty_claim_event(claim_id, created_at);

-- Generalize the refund obligation created for shop cancellations so it can also represent a
-- warranty payout: the preorder link becomes optional, an order/claim link is added, and the manual
-- payout evidence has a home.
alter table shop_refund_obligation alter column preorder_id drop not null;
alter table shop_refund_obligation add column if not exists order_id text references "order"(id);
alter table shop_refund_obligation add column if not exists claim_id text references warranty_claim(id);
alter table shop_refund_obligation add column if not exists recommended_amount_vnd bigint;
alter table shop_refund_obligation add column if not exists approved_amount_vnd bigint;
alter table shop_refund_obligation add column if not exists override_reason text;
alter table shop_refund_obligation add column if not exists bank_name text;
alter table shop_refund_obligation add column if not exists account_number text;
alter table shop_refund_obligation add column if not exists account_holder text;
alter table shop_refund_obligation add column if not exists paid_at timestamptz;
alter table shop_refund_obligation add column if not exists paid_by text;
alter table shop_refund_obligation add column if not exists payout_reference text;

alter table shop_refund_obligation drop constraint if exists shop_refund_obligation_status_check;
alter table shop_refund_obligation
  add constraint shop_refund_obligation_status_check
  check (status in ('OPEN', 'FULFILLED', 'CANCELLED', 'PAID'));

-- An obligation must describe *something*: a preorder, an order or a claim.
alter table shop_refund_obligation drop constraint if exists shop_refund_obligation_subject_ck;
alter table shop_refund_obligation
  add constraint shop_refund_obligation_subject_ck
  check (
    (case when preorder_id is null then 0 else 1 end)
    + (case when order_id is null then 0 else 1 end)
    + (case when claim_id is null then 0 else 1 end) >= 1
  );

-- A customer's own submission is a customer action: the audit trail should say so rather than
-- attributing it to the system.
alter table audit_event drop constraint if exists audit_event_actor_type_check;
alter table audit_event
  add constraint audit_event_actor_type_check
  check (actor_type in ('ROOT_ADMIN', 'SYSTEM', 'SUPPLIER', 'PAYMENT_PROVIDER', 'CUSTOMER'));
