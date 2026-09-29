-- Durable, owner-only supplier commissioning canaries.
-- This table is intentionally not linked to commerce orders, payment intents,
-- wallet ledger rows, digital assets, or customer delivery bundles.


alter table supplier_order
  add column if not exists query_key text;
alter table admin_confirmation
  drop constraint if exists admin_confirmation_command_ref_ck;

alter table admin_confirmation
  add constraint admin_confirmation_command_ref_ck
  check (
    allowlisted_command_ref is null
    or allowlisted_command_ref in (
      'discrepancy.resolve',
      'outbox.orphan.dispose',
      'wallet.refund',
      'manual_fulfillment.complete',
      'support.replacement.approve',
      'inventory.ready.release',
      'fulfillment.reconcile',
      'group.publication.disable',
      'store.open',
      'store.close',
      'store.test',
      'catalog.publish',
      'catalog.evidence.register',
      'catalog.evidence.revoke',
      'supplier.canary.purchase'
    )
  );

create table supplier_canary_run (
  id                    text primary key,
  confirmation_id       text unique references admin_confirmation(id),
  supplier_id           text not null references supplier(id),
  supplier_sku_id       text not null references supplier_sku(id),
  variant_id             text not null references product_variant(id),
  provider_key          text not null,
  external_sku          text not null,
  region                text,
  idempotency_key       text not null,
  request_fingerprint   text not null,
  status                text not null check (status in
                         ('PREVIEWED','AUTHORIZED','SUBMITTED','PENDING','FULFILLED',
                          'UNKNOWN','REJECTED','BLOCKED')),
  approved_cost_vnd     bigint not null check (approved_cost_vnd >= 0),
  cost_vnd_snapshot     bigint not null check (cost_vnd_snapshot >= 0),
  query_key              text,
  balance_vnd_snapshot  bigint check (balance_vnd_snapshot is null or balance_vnd_snapshot >= 0),
  currency              text not null,
  external_order_id     text,
  response_fingerprint  text,
  last_error_code       text,
  retry_after_seconds   integer check (
    retry_after_seconds is null or retry_after_seconds between 0 and 86_400
  ),
  uncertain_at          timestamptz,
  submitted_at          timestamptz,
  last_queried_at       timestamptz,
  needs_review_at       timestamptz,
  next_reconcile_at     timestamptz,
  created_by            text not null,
  correlation_id        text not null,
  version               integer not null default 1 check (version >= 1),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (supplier_id, idempotency_key)
);

create index supplier_canary_run_status_idx
  on supplier_canary_run (status, next_reconcile_at, created_at);
create index supplier_canary_run_owner_idx
  on supplier_canary_run (created_by, created_at desc);
create unique index supplier_canary_run_external_order_uq
  on supplier_canary_run (supplier_id, external_order_id)
  where external_order_id is not null;
