-- 001_initial.sql — Telegram Shop Digital MVP initial schema.
--
-- Conventions (data-model.md):
--   * ids are opaque text (ULID, 26 chars) — no serial/autoincrement exposed.
--   * money is integer VND stored as bigint (never float/numeric-with-scale).
--   * timestamps are timestamptz (UTC); rendering to Asia/Ho_Chi_Minh is app-side.
--   * every mutable aggregate has an integer `version` for optimistic concurrency.
--   * unique constraints enforce idempotency + business-effect cardinality, not
--     just application checks.
--
-- All statements run inside one transaction (the migration runner wraps the file).

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------

create table category (
  id           text primary key,
  name_vi      text        not null,
  slug         text        not null,
  is_active    boolean     not null default true,
  sort_order   integer     not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  version      integer     not null default 1
);

-- Active slug must be unique; inactive rows are exempt so a slug can be retired.
create unique index category_active_slug_uq
  on category (slug) where is_active;

create table product (
  id                   text primary key,
  category_id          text not null references category (id),
  name_vi              text not null,
  slug                 text not null,
  short_description_vi text,
  image_asset_id       text,
  is_active            boolean     not null default true,
  sort_order           integer     not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  version              integer     not null default 1
);

create unique index product_active_slug_uq
  on product (slug) where is_active;
create index product_category_idx on product (category_id);

create table product_variant (
  id               text primary key,
  product_id       text not null references product (id),
  sku              text not null,
  name_vi          text not null,
  price_vnd        bigint not null check (price_vnd > 0),
  duration_code    text not null,
  delivery_type    text not null check (delivery_type in
                     ('INVITE','LICENSE','ACTIVATION_KEY','CREDENTIAL','MANUAL_REVIEW')),
  warranty_days    integer not null default 0 check (warranty_days >= 0),
  stock_policy     text not null check (stock_policy in
                     ('LOCAL_ONLY','SUPPLIER_ONLY','LOCAL_THEN_SUPPLIER','PAUSED')),
  supplier_sku_id  text,
  resale_evidence_id text,
  is_active        boolean     not null default true,
  sort_order       integer     not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  version          integer     not null default 1
);

create unique index product_variant_sku_uq on product_variant (sku);
create index product_variant_product_idx on product_variant (product_id);

create table product_alias (
  id               text primary key,
  product_id       text not null references product (id),
  normalized_alias text not null,
  locale           text not null,
  priority         integer not null default 0
);

create unique index product_alias_uq
  on product_alias (locale, normalized_alias, product_id);

-- ---------------------------------------------------------------------------
-- Identity and administration
-- ---------------------------------------------------------------------------

create table customer (
  id           text primary key,
  status       text not null default 'ACTIVE',
  locale       text not null default 'vi-VN',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  version      integer not null default 1
);

create table channel_identity (
  id                text primary key,
  customer_id       text not null references customer (id),
  channel           text not null,
  channel_user_id   text not null,
  observed_username text,
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz not null default now()
);

-- Authorization keys on (channel, channel_user_id) — never on username.
create unique index channel_identity_uq
  on channel_identity (channel, channel_user_id);

create table admin_confirmation (
  id                       text primary key,
  root_channel_identity_id text not null references channel_identity (id),
  action_fingerprint       text not null,
  challenge_hash           text not null,
  status                   text not null check (status in
                             ('CREATED','CONFIRMED','CONSUMED','EXPIRED','REVOKED')),
  expires_at               timestamptz not null,
  confirmed_at             timestamptz,
  consumed_at              timestamptz,
  correlation_id           text not null
);

-- At most one live challenge per (root identity, action fingerprint).
create unique index admin_confirmation_active_uq
  on admin_confirmation (root_channel_identity_id, action_fingerprint)
  where status in ('CREATED','CONFIRMED');

-- ---------------------------------------------------------------------------
-- Commerce
-- ---------------------------------------------------------------------------

create table "order" (
  id                       text primary key,
  order_number             text not null,
  -- Buy Now idempotency fingerprint (FR-010): a double-tap with the same key
  -- resolves to the existing Order instead of creating a second one.
  idempotency_key          text,
  customer_id              text not null references customer (id),
  variant_id               text not null references product_variant (id),
  product_name_vi          text not null,
  variant_name_vi          text not null,
  price_vnd                bigint not null check (price_vnd > 0),
  duration_code            text not null,
  delivery_type            text not null,
  warranty_days            integer not null default 0,
  supplier_policy_snapshot text,
  status                   text not null check (status in
                             ('DRAFT','PENDING_PAYMENT','PAID','PROCESSING','COMPLETED',
                              'REJECTED','CANCELLED','EXPIRED','PAYMENT_NEEDS_REVIEW',
                              'FULFILLMENT_NEEDS_REVIEW','REFUND_PENDING','REFUNDED')),
  expires_at               timestamptz,
  paid_at                  timestamptz,
  completed_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  version                  integer not null default 1
);

create unique index order_number_uq on "order" (order_number);
-- One order per (customer, idempotency_key) when a key is supplied.
create unique index order_idempotency_uq
  on "order" (customer_id, idempotency_key)
  where idempotency_key is not null;
create index order_customer_idx on "order" (customer_id);
create index order_status_idx on "order" (status);

create table order_transition (
  id               text primary key,
  order_id         text not null references "order" (id),
  from_status      text not null,
  to_status        text not null,
  reason_code      text not null,
  actor_type       text not null,
  actor_id         text,
  correlation_id   text not null,
  occurred_at      timestamptz not null default now(),
  metadata_redacted jsonb not null default '{}'::jsonb
);

create index order_transition_order_idx on order_transition (order_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Payment
-- ---------------------------------------------------------------------------

create table payment_intent (
  id                  text primary key,
  order_id            text not null references "order" (id),
  status              text not null check (status in
                        ('CREATED','PRESENTED','SUCCEEDED','EXPIRED','FAILED','NEEDS_REVIEW',
                         'PARTIALLY_REFUNDED','REFUNDED')),
  amount_vnd          bigint not null check (amount_vnd > 0),
  merchant_account_id text not null,
  transfer_content    text not null,
  expires_at          timestamptz not null,
  presented_at        timestamptz,
  settled_at          timestamptz,
  created_at          timestamptz not null default now(),
  version             integer not null default 1
);

-- One active intent per order (business rule: no two live intents).
create unique index payment_intent_active_order_uq
  on payment_intent (order_id)
  where status in ('CREATED','PRESENTED');
-- Transfer content must resolve to exactly one intent within the live window.
create unique index payment_intent_active_content_uq
  on payment_intent (transfer_content)
  where status in ('CREATED','PRESENTED');

create table bank_transaction (
  id                      text primary key,
  provider                text not null,
  provider_transaction_id text not null,
  direction               text not null check (direction in ('IN','OUT')),
  merchant_account_id     text not null,
  amount_vnd              bigint not null,
  content                 text,
  reference               text,
  transacted_at           timestamptz not null,
  received_at             timestamptz not null default now(),
  raw_hash                text not null,
  signature_status        text not null,
  schema_version          text not null,
  metadata_redacted       jsonb not null default '{}'::jsonb
);

-- Provider transaction id is globally unique per provider (dedupe/idempotency).
create unique index bank_transaction_provider_uq
  on bank_transaction (provider, provider_transaction_id);

create table payment_allocation (
  id                   text primary key,
  bank_transaction_id  text not null references bank_transaction (id),
  payment_intent_id    text not null references payment_intent (id),
  allocated_amount_vnd bigint not null check (allocated_amount_vnd > 0),
  status               text not null check (status in
                         ('PENDING','SETTLED','REVERSED','REJECTED')),
  decision_code        text not null,
  decided_at           timestamptz not null default now(),
  correlation_id       text not null
);

-- A bank transaction settles to at most one intent (no double-spend of evidence).
create unique index payment_allocation_settled_txn_uq
  on payment_allocation (bank_transaction_id)
  where status = 'SETTLED';
create index payment_allocation_intent_idx
  on payment_allocation (payment_intent_id);

create table discrepancy (
  id                  text primary key,
  type                text not null check (type in
                        ('UNDERPAYMENT','OVERPAYMENT','LATE_PAYMENT','WRONG_CONTENT',
                         'WRONG_ACCOUNT','UNMATCHED','REFERENCE_COLLISION','REFUND_MISMATCH')),
  bank_transaction_id text references bank_transaction (id),
  payment_intent_id   text references payment_intent (id),
  order_id            text references "order" (id),
  status              text not null,
  reason              text not null,
  owner               text not null,
  due_at              timestamptz,
  resolution_code     text,
  resolved_at         timestamptz,
  audit_event_id      text
);

create index discrepancy_status_idx on discrepancy (status);

-- ---------------------------------------------------------------------------
-- Supplier
-- ---------------------------------------------------------------------------

create table supplier (
  id                   text primary key,
  name                 text not null,
  adapter_type         text not null,
  credential_vault_ref text not null,
  status               text not null default 'ACTIVE',
  timeout_policy       jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  version              integer not null default 1
);

create table supplier_sku (
  id               text primary key,
  supplier_id      text not null references supplier (id),
  variant_id       text not null references product_variant (id),
  external_sku     text not null,
  cost_vnd         bigint not null check (cost_vnd >= 0),
  region           text,
  delivery_type    text not null,
  is_active        boolean not null default true,
  last_verified_at timestamptz,
  version          integer not null default 1
);

create index supplier_sku_variant_idx on supplier_sku (variant_id);

create table supplier_order (
  id                    text primary key,
  supplier_id           text not null references supplier (id),
  supplier_sku_id       text not null references supplier_sku (id),
  order_id              text not null references "order" (id),
  idempotency_key       text not null,
  request_fingerprint   text not null,
  external_order_id     text,
  status                text not null check (status in
                          ('CREATED','SUBMITTED','PENDING','FULFILLED','REJECTED','UNKNOWN',
                           'RECONCILED','CANCEL_PENDING','CANCELLED','REFUND_PENDING','REFUNDED')),
  cost_vnd_snapshot     bigint not null,
  sale_price_vnd_snapshot bigint not null,
  margin_vnd_snapshot   bigint not null,
  submitted_at          timestamptz,
  last_queried_at       timestamptz,
  next_reconcile_at     timestamptz,
  version               integer not null default 1
);

-- Supplier create is idempotent on (supplier, idempotency_key).
create unique index supplier_order_idempotency_uq
  on supplier_order (supplier_id, idempotency_key);
-- When an external id exists it is unique per supplier.
create unique index supplier_order_external_uq
  on supplier_order (supplier_id, external_order_id)
  where external_order_id is not null;

-- ---------------------------------------------------------------------------
-- Digital goods and delivery
-- ---------------------------------------------------------------------------

create table digital_asset (
  id                 text primary key,
  variant_id         text not null references product_variant (id),
  source_type        text not null,
  supplier_order_id  text references supplier_order (id),
  vault_ref          text not null,
  fingerprint_hash   text not null,
  status             text not null check (status in
                       ('AVAILABLE','RESERVED','READY','DELIVERED','EXPIRED','PROVISIONING',
                        'SUPPLIER_NEEDS_REVIEW','FAILED','COMPROMISED','REVOKED')),
  expires_at         timestamptz,
  region             text,
  validation_summary jsonb not null default '{}'::jsonb,
  reserved_order_id  text references "order" (id),
  reserved_until     timestamptz,
  delivered_order_id text references "order" (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  version            integer not null default 1
);

-- One active (reserved/ready/delivered) asset per fingerprint: an asset secret
-- can never be simultaneously claimed by two orders.
create unique index digital_asset_active_fingerprint_uq
  on digital_asset (fingerprint_hash)
  where status in ('RESERVED','READY','DELIVERED');
create index digital_asset_variant_idx on digital_asset (variant_id, status);

create table delivery_bundle (
  id            text primary key,
  order_id      text not null references "order" (id),
  customer_id   text not null references customer (id),
  asset_id      text not null references digital_asset (id),
  token_hash    text not null,
  status        text not null check (status in
                  ('CREATED','AVAILABLE','VIEWED','CONSUMED','EXPIRED','REVOKED')),
  expires_at    timestamptz not null,
  viewed_at     timestamptz,
  consumed_at   timestamptz,
  revoked_at    timestamptz,
  reissue_of_id text references delivery_bundle (id),
  created_at    timestamptz not null default now(),
  version       integer not null default 1
);

-- One active bundle per order (reissue revokes the prior one in-txn first).
create unique index delivery_bundle_active_order_uq
  on delivery_bundle (order_id)
  where status in ('CREATED','AVAILABLE','VIEWED');
-- Token hash is unique so a reveal token maps to exactly one bundle.
create unique index delivery_bundle_token_uq on delivery_bundle (token_hash);

create table replacement_case (
  id                   text primary key,
  order_id             text not null references "order" (id),
  original_asset_id    text not null references digital_asset (id),
  replacement_asset_id text references digital_asset (id),
  reason_code          text not null,
  status               text not null,
  warranty_deadline    timestamptz,
  opened_at            timestamptz not null default now(),
  resolved_at          timestamptz,
  audit_event_id       text
);

-- ---------------------------------------------------------------------------
-- Support, reliability, audit
-- ---------------------------------------------------------------------------

create table support_ticket (
  id           text primary key,
  customer_id  text not null references customer (id),
  order_id     text references "order" (id),
  reason_code  text not null,
  status       text not null check (status in
                 ('OPEN','WAITING_SHOP','WAITING_CUSTOMER','RESOLVED','CLOSED','MANUAL_REVIEW')),
  safe_summary text not null,
  due_at       timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  version      integer not null default 1
);

create index support_ticket_customer_idx on support_ticket (customer_id);

create table webhook_inbox (
  id                text primary key,
  source            text not null,
  source_event_id   text not null,
  raw_hash          text not null,
  signature_status  text not null,
  received_at       timestamptz not null default now(),
  processing_status text not null default 'PENDING' check (processing_status in
                      ('PENDING','PROCESSING','PROCESSED','FAILED','DEAD')),
  attempt_count     integer not null default 0,
  next_attempt_at   timestamptz,
  processed_at      timestamptz,
  last_error_code   text
);

-- Dedupe inbound webhooks by (source, source_event_id).
create unique index webhook_inbox_source_uq
  on webhook_inbox (source, source_event_id);

create table outbox_event (
  id                text primary key,
  aggregate_type    text not null,
  aggregate_id      text not null,
  aggregate_version integer not null,
  event_type        text not null,
  payload_redacted  jsonb not null default '{}'::jsonb,
  occurred_at       timestamptz not null default now(),
  published_at      timestamptz,
  attempt_count     integer not null default 0,
  next_attempt_at   timestamptz,
  -- Infrastructure bookkeeping for the retry budget + dead-letter state (T018):
  -- last_error_code aids diagnosis; dead_lettered_at is set once the bounded
  -- attempt budget is exhausted so the poller stops re-delivering a poison event.
  last_error_code   text,
  dead_lettered_at  timestamptz
);

-- Exactly-once emission key: one row per aggregate transition + event type.
create unique index outbox_event_dedupe_uq
  on outbox_event (aggregate_type, aggregate_id, aggregate_version, event_type);
-- Poller reads unpublished rows in occurrence order.
create index outbox_event_unpublished_idx
  on outbox_event (occurred_at) where published_at is null;

create table audit_event (
  id                text primary key,
  actor_type        text not null,
  actor_id          text,
  action            text not null,
  target_type       text not null,
  target_id         text not null,
  reason            text not null,
  before_hash       text,
  after_hash        text,
  correlation_id    text not null,
  occurred_at       timestamptz not null default now(),
  metadata_redacted jsonb not null default '{}'::jsonb
);

create index audit_event_target_idx on audit_event (target_type, target_id, occurred_at);
create index audit_event_correlation_idx on audit_event (correlation_id);
