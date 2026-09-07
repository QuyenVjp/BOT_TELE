alter table admin_workflow
  add column if not exists existing_product_id text references product(id);

alter table admin_callback_state
  drop constraint if exists admin_callback_state_kind_check;

alter table admin_callback_state
  add constraint admin_callback_state_kind_check
  check (kind in ('CUSTOMER_DETAIL','CUSTOMER_MESSAGE_PROMPT','CUSTOMER_SEARCH_PROMPT','CUSTOMER_PAGE','MANUAL_TASK_COMPLETE','FILE_ARTIFACT_IMPORT_CONFIRM','ADMIN_VARIANT_UPDATE'));
