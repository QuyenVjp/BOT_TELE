-- Restore the owner order-search prompt kind omitted when migration 103
-- replaced admin_callback_state_kind_check. This is a CHECK-only repair: no
-- callback rows or payload/configuration are deleted or rewritten.

do $$
begin
  if to_regclass('public.admin_callback_state') is null then
    return;
  end if;

  alter table admin_callback_state drop constraint if exists admin_callback_state_kind_check;
  alter table admin_callback_state
    add constraint admin_callback_state_kind_check
    check (kind in (
      'CUSTOMER_DETAIL','CUSTOMER_MESSAGE_PROMPT','CUSTOMER_SEARCH_PROMPT','CUSTOMER_PAGE',
      'ORDER_DETAIL','ORDER_SEARCH_PROMPT','ORDER_PAGE','ORDER_MESSAGE_PROMPT','MANUAL_TASK_COMPLETE',
      'FILE_ARTIFACT_IMPORT_CONFIRM','QUANTITY_STOCK_ADJUST_CONFIRM','ADMIN_VARIANT_UPDATE',
      'TEST_CUSTOMER_ADD','CATEGORY_CREATE','CATEGORY_RENAME','WIZARD_CATEGORY_CREATE',
      'WIZARD_CUSTOM_FIELD','WIZARD_ADVANCED','WIZARD_DESC_CUSTOM','ADMIN_PRODUCT_CONTENT_EDIT',
      'WARRANTY_REFUND_ADJUST_PROMPT','ADMIN_RESALE_EVIDENCE_PROMPT',
      'ADMIN_PAYMENT_DISPOSITION_PROMPT','ADMIN_OUTBOX_DISPOSITION_PROMPT',
      'SUPPLIER_CURATE_PROMPT','SUPPLIER_CURATE_PREVIEW','ADMIN_INVENTORY_IMPORT_CONFIRM'
    ));
end;
$$;
