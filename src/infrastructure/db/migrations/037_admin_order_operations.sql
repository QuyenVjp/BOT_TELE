alter table admin_callback_state
  drop constraint if exists admin_callback_state_kind_check;

alter table admin_callback_state
  add constraint admin_callback_state_kind_check
  check (kind in ('CUSTOMER_DETAIL','CUSTOMER_MESSAGE_PROMPT','CUSTOMER_SEARCH_PROMPT','CUSTOMER_PAGE','ORDER_DETAIL','ORDER_PAGE','ORDER_MESSAGE_PROMPT','MANUAL_TASK_COMPLETE','FILE_ARTIFACT_IMPORT_CONFIRM','QUANTITY_STOCK_ADJUST_CONFIRM','ADMIN_VARIANT_UPDATE'));
