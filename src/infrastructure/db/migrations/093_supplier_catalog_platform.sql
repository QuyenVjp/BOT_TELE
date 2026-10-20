-- Generic supplier catalog snapshots, owner mappings, and durable purchase evidence.
-- Provider-specific response fields stop at the adapter boundary; this schema stores
-- only normalized safe metadata and local owner decisions.

alter table supplier_order
  add column if not exists provider_client_order_id text,
  add column if not exists response_fingerprint text,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists retry_after_seconds integer,
  add column if not exists uncertain_at timestamptz,
  add column if not exists needs_review_at timestamptz;

do $$
begin
  alter table supplier_order
    add constraint supplier_order_attempt_count_chk check (attempt_count >= 0);
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  alter table supplier_order
    add constraint supplier_order_retry_after_chk check (
      retry_after_seconds is null or retry_after_seconds between 0 and 86_400
    );
exception
  when duplicate_object then null;
end;
$$;

create unique index if not exists supplier_order_provider_client_uq
  on supplier_order (supplier_id, provider_client_order_id)
  where provider_client_order_id is not null;

alter table supplier
  add column if not exists base_url text,
  add column if not exists provider_capabilities jsonb not null default '[]'::jsonb,
  add column if not exists last_health_check timestamptz,
  add column if not exists updated_at timestamptz not null default now();

create table if not exists supplier_catalog_product (
  id                         text primary key,
  supplier_id                text not null references supplier(id),
  external_product_id        text not null,
  external_variant_id        text not null default '',
  upstream_name_vi           text not null,
  upstream_name_en           text,
  upstream_description_vi    text,
  upstream_description_en    text,
  upstream_warranty_vi       text,
  upstream_warranty_en       text,
  customer_input_type        text,
  requires_customer_input    boolean not null default false,
  customer_inputs_per_item   integer not null default 0,
  customer_prompt_vi         text,
  customer_prompt_en         text,
  fulfillment_mode           text,
  availability               text not null check (availability in ('AVAILABLE','LOW','OUT','UNKNOWN','MISSING')),
  domain_status              text not null default 'SUPPORTED'
                               check (domain_status in ('SUPPORTED','UNSUPPORTED')),
  domain_unsupported_reason  text,
  stock_type                 text,
  stock_quantity             integer,
  min_quantity               integer not null default 1,
  max_quantity               integer,
  fixed_quantity             integer,
  supplier_cost_vnd          bigint not null check (supplier_cost_vnd >= 0),
  currency                   text not null,
  pricing_source             text,
  upstream_updated_at        timestamptz,
  selection_status           text not null default 'DISCOVERED' check (selection_status in ('DISCOVERED','SELECTED')),
  is_enabled                 boolean not null default false,
  is_missing                 boolean not null default false,
  local_product_id           text references product(id),
  local_variant_id           text references product_variant(id),
  supplier_sku_id            text references supplier_sku(id),
  local_name_vi              text,
  local_variant_name_vi      text,
  local_description_vi       text,
  last_synced_at             timestamptz not null default now(),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  version                    integer not null default 1,
  unique (supplier_id, external_product_id, external_variant_id),
  check (stock_quantity is null or stock_quantity >= 0),
  check (min_quantity >= 1),
  check (max_quantity is null or max_quantity >= 0),
  check (fixed_quantity is null or fixed_quantity >= 0),
  check (customer_inputs_per_item >= 0),
  check (
    not requires_customer_input
    or customer_inputs_per_item > 0
    or domain_status = 'UNSUPPORTED'
  ),
  check (
    domain_status = 'UNSUPPORTED'
    or max_quantity is null
    or max_quantity >= min_quantity
  ),
  check (
    domain_status = 'UNSUPPORTED'
    or fixed_quantity is null
    or fixed_quantity >= 1
  ),
  check (
    (domain_status = 'SUPPORTED' and domain_unsupported_reason is null)
    or (domain_status = 'UNSUPPORTED' and domain_unsupported_reason is not null)
  ),
  check (
    domain_unsupported_reason is null
    or char_length(domain_unsupported_reason) between 1 and 128
  ),
  check (domain_status = 'SUPPORTED' or not is_enabled)
);

create index if not exists supplier_catalog_product_page_idx
  on supplier_catalog_product (supplier_id, selection_status, is_enabled, is_missing, external_product_id);

create unique index if not exists supplier_catalog_product_local_variant_uq
  on supplier_catalog_product (supplier_id, local_variant_id)
  where local_variant_id is not null;

create unique index if not exists supplier_catalog_product_supplier_sku_uq
  on supplier_catalog_product (supplier_sku_id)
  where supplier_sku_id is not null;

alter table admin_callback_state drop constraint if exists admin_callback_state_kind_check;
alter table admin_callback_state
  add constraint admin_callback_state_kind_check
  check (kind in (
    'CUSTOMER_DETAIL','CUSTOMER_MESSAGE_PROMPT','CUSTOMER_SEARCH_PROMPT','CUSTOMER_PAGE',
    'ORDER_DETAIL','ORDER_PAGE','ORDER_MESSAGE_PROMPT','MANUAL_TASK_COMPLETE',
    'FILE_ARTIFACT_IMPORT_CONFIRM','QUANTITY_STOCK_ADJUST_CONFIRM','ADMIN_VARIANT_UPDATE',
    'TEST_CUSTOMER_ADD','CATEGORY_CREATE','CATEGORY_RENAME','WIZARD_CATEGORY_CREATE',
    'WIZARD_CUSTOM_FIELD','WIZARD_ADVANCED','WIZARD_DESC_CUSTOM','ADMIN_PRODUCT_CONTENT_EDIT',
    'WARRANTY_REFUND_ADJUST_PROMPT','ADMIN_RESALE_EVIDENCE_PROMPT',
    'ADMIN_PAYMENT_DISPOSITION_PROMPT','ADMIN_OUTBOX_DISPOSITION_PROMPT',
    'SUPPLIER_CURATE_PROMPT','SUPPLIER_CURATE_PREVIEW'
  ));
