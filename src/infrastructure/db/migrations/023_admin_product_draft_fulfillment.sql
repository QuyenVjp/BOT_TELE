-- Durable product creation draft fulfillment configuration.
alter table admin_workflow
  add column if not exists variant_name text,
  add column if not exists fulfillment_type text,
  add column if not exists inventory_fields jsonb not null default '[]'::jsonb;

alter table admin_workflow
  drop constraint if exists admin_workflow_step_check;

alter table admin_workflow
  add constraint admin_workflow_step_check
  check (step in ('name','sku','variantName','price','category','fulfillmentType','inventoryFields','threshold','confirm'));

do $$
begin
  alter table admin_workflow
    add constraint admin_workflow_fulfillment_type_check
    check (fulfillment_type in ('STOCK_ACCOUNT','STOCK_CODE','DIGITAL_FILE','SUPPLIER_API','MANUAL_FULFILLMENT','QUANTITY_STOCK','UNLIMITED_SERVICE') or fulfillment_type is null);
exception
  when duplicate_object then null;
end;
$$;

alter table admin_workflow
  alter column inventory_fields set default '[]'::jsonb;

update admin_workflow
set inventory_fields = '[]'::jsonb
where inventory_fields is null;
