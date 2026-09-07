alter table variant_service_fulfillment
  drop constraint if exists variant_service_fulfillment_fulfillment_type_check;
alter table variant_service_fulfillment
  add constraint variant_service_fulfillment_fulfillment_type_check
  check (fulfillment_type in ('MANUAL_FULFILLMENT','UNLIMITED_SERVICE','QUANTITY_STOCK'));

alter table manual_fulfillment_task
  drop constraint if exists manual_fulfillment_task_fulfillment_type_check;
alter table manual_fulfillment_task
  add constraint manual_fulfillment_task_fulfillment_type_check
  check (fulfillment_type in ('MANUAL_FULFILLMENT','UNLIMITED_SERVICE','QUANTITY_STOCK'));

create unique index if not exists quantity_stock_deliver_uq on quantity_stock_ledger(parent_ledger_id) where entry_type='DELIVER';
