-- Product commercial copy and variant pricing metadata for the product wizard.
alter table product
  add column if not exists description_vi text,
  add column if not exists what_customer_receives_vi text,
  add column if not exists usage_instructions_vi text,
  add column if not exists delivery_eta_vi text,
  add column if not exists warranty_vi text,
  add column if not exists support_vi text,
  add column if not exists terms_vi text,
  add column if not exists tags text[];

alter table product_variant
  add column if not exists compare_at_price_vnd bigint;
