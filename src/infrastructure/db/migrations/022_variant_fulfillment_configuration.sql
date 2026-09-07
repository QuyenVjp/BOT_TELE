-- 022_variant_fulfillment_configuration.sql — add the new fulfillment config
-- alongside the legacy product_variant fields. Current services keep using
-- delivery_type + stock_policy until router cutover.

alter table product_variant
  add column if not exists fulfillment_type text,
  add column if not exists inventory_fields jsonb not null default '[]'::jsonb,
  add column if not exists low_stock_threshold integer;

do $$
begin
  alter table product_variant
    add constraint product_variant_fulfillment_type_check
    check (fulfillment_type in ('STOCK_ACCOUNT','STOCK_CODE','DIGITAL_FILE','SUPPLIER_API','MANUAL_FULFILLMENT','QUANTITY_STOCK','UNLIMITED_SERVICE') or fulfillment_type is null);
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  alter table product_variant
    add constraint product_variant_low_stock_threshold_check
    check (low_stock_threshold is null or low_stock_threshold >= 0);
exception
  when duplicate_object then null;
end;
$$;

create or replace function product_variant_default_fulfillment_type(
  delivery_type text,
  stock_policy text,
  fulfillment_type text
) returns text
language plpgsql
immutable
as $$
begin
  if fulfillment_type is not null then
    return fulfillment_type;
  end if;

  if stock_policy = 'SUPPLIER_ONLY' then
    return 'SUPPLIER_API';
  end if;

  case delivery_type
    when 'CREDENTIAL' then return 'STOCK_ACCOUNT';
    when 'LICENSE' then return 'STOCK_CODE';
    when 'ACTIVATION_KEY' then return 'STOCK_CODE';
    when 'MANUAL_REVIEW' then return 'MANUAL_FULFILLMENT';
    when 'INVITE' then return 'MANUAL_FULFILLMENT';
    else return 'MANUAL_FULFILLMENT';
  end case;
end;
$$;

create or replace function product_variant_sync_fulfillment_type()
returns trigger
language plpgsql
as $$
begin
  new.fulfillment_type := product_variant_default_fulfillment_type(
    new.delivery_type,
    new.stock_policy,
    new.fulfillment_type
  );
  return new;
end;
$$;

drop trigger if exists product_variant_sync_fulfillment_type on product_variant;
create trigger product_variant_sync_fulfillment_type
before insert or update of delivery_type, stock_policy, fulfillment_type
on product_variant
for each row execute function product_variant_sync_fulfillment_type();

update product_variant
set fulfillment_type = product_variant_default_fulfillment_type(
  delivery_type,
  stock_policy,
  fulfillment_type
)
where fulfillment_type is null;

alter table product_variant
  alter column fulfillment_type set not null;
