-- 042_commerce_sprint_features.sql
-- Commerce UX, Inventory, Preorder, Social Proof, and Shop Settings.

-- 1. Product & Variant Metadata for isolation of tests and preorders
alter table product
  add column if not exists is_test boolean not null default false,
  add column if not exists is_archived boolean not null default false;

create index if not exists product_active_non_test_idx
  on product (is_active, is_test, is_archived);

alter table product_variant
  add column if not exists preorder_enabled boolean not null default false,
  add column if not exists deposit_mode text not null default 'FIXED' check (deposit_mode in ('FIXED', 'PERCENT')),
  add column if not exists deposit_amount_vnd bigint not null default 0 check (deposit_amount_vnd >= 0),
  add column if not exists deposit_percent integer not null default 0 check (deposit_percent >= 0 and deposit_percent <= 100),
  add column if not exists min_deposit_vnd bigint not null default 0 check (min_deposit_vnd >= 0),
  add column if not exists max_preorder_queue integer not null default 50 check (max_preorder_queue >= 0),
  add column if not exists hold_duration_hours integer not null default 24 check (hold_duration_hours > 0),
  add column if not exists balance_due_hours integer not null default 24 check (balance_due_hours > 0),
  add column if not exists forfeit_policy_version integer not null default 1 check (forfeit_policy_version > 0);

create index if not exists product_variant_preorder_idx
  on product_variant (id) where preorder_enabled;

-- 2. Durable Preorder / Reservation Model
create table if not exists preorder_reservation (
  id text primary key,
  variant_id text not null references product_variant(id),
  customer_id text not null references customer(id),
  status text not null check (status in (
    'CREATED',
    'WAITING_DEPOSIT',
    'DEPOSIT_PAID',
    'ALLOCATED',
    'BALANCE_DUE',
    'FULLY_PAID',
    'FULFILLED',
    'DEPOSIT_EXPIRED',
    'CANCELLED',
    'SHOP_CANCELLED',
    'HOLD_EXPIRED',
    'DEPOSIT_FORFEITED',
    'REFUND_DUE'
  )),
  deposit_amount_vnd bigint not null check (deposit_amount_vnd >= 0),
  balance_amount_vnd bigint not null check (balance_amount_vnd >= 0),
  total_price_vnd bigint not null check (total_price_vnd > 0),
  deposit_payment_intent_id text references payment_intent(id),
  balance_payment_intent_id text references payment_intent(id),
  allocated_asset_id text references digital_asset(id),
  order_id text references "order"(id),
  deposit_paid_at timestamptz,
  allocated_at timestamptz,
  hold_until timestamptz,
  balance_due_until timestamptz,
  terms_version integer not null default 1,
  accepted_terms_snapshot text not null,
  forfeited_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create index if not exists preorder_queue_priority_idx
  on preorder_reservation(variant_id, deposit_paid_at asc)
  where status = 'DEPOSIT_PAID';

create index if not exists preorder_customer_idx
  on preorder_reservation(customer_id, status);

create index if not exists preorder_hold_expiry_idx
  on preorder_reservation(hold_until)
  where status in ('ALLOCATED', 'BALANCE_DUE');

-- 3. Extend payment_intent to support preorder deposit and balance payments
alter table payment_intent
  add column if not exists kind text not null default 'ORDER' check (kind in ('ORDER', 'TOPUP', 'DEPOSIT', 'BALANCE')),
  add column if not exists preorder_id text references preorder_reservation(id);

-- 4. Customer notification preferences
create table if not exists customer_notification_preference (
  customer_id text primary key references customer(id),
  marketing_opt_in boolean not null default true,
  social_proof_opt_in boolean not null default true,
  updated_at timestamptz not null default now()
);

-- 5. Shop Settings
create table if not exists shop_settings (
  id text primary key,
  shop_name text not null default 'TIER20 DIGITAL SHOP',
  shop_tagline text not null default 'Kho sản phẩm số & dịch vụ AI',
  welcome_message text,
  community_url text not null default 'https://t.me/aicodexvn',
  support_url text default 'https://t.me/aicodexvn',
  warranty_summary text default 'Bảo hành 1 đổi 1 trong suốt thời gian sử dụng',
  social_proof_enabled boolean not null default false,
  social_proof_target text not null default '@aicodexvn',
  restock_public_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into shop_settings (id)
values ('main')
on conflict (id) do nothing;

-- 6. Clean existing Canary products so they do not pollute regular customer/admin views
update product
set is_test = true
where slug like 'canary-%' or name_vi ilike '%canary%';
