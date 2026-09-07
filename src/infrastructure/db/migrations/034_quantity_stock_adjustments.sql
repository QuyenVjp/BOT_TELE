alter table quantity_stock_ledger
  add column if not exists idempotency_key text;

create unique index if not exists quantity_stock_adjust_idempotency_uq
  on quantity_stock_ledger(idempotency_key)
  where entry_type = 'ADJUST' and idempotency_key is not null;

alter table admin_callback_state
  drop constraint if exists admin_callback_state_kind_check;

alter table admin_callback_state
  add constraint admin_callback_state_kind_check
  check (kind in ('CUSTOMER_DETAIL','CUSTOMER_MESSAGE_PROMPT','CUSTOMER_SEARCH_PROMPT','CUSTOMER_PAGE','MANUAL_TASK_COMPLETE','FILE_ARTIFACT_IMPORT_CONFIRM','QUANTITY_STOCK_ADJUST_CONFIRM','ADMIN_VARIANT_UPDATE'));
