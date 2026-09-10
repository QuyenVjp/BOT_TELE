-- Goal §26: adjusting an approved refund requires a new amount AND a reason, which cannot be
-- expressed with buttons alone. The existing admin text states are all product/customer-scoped, so
-- this adds the one kind the warranty flow needs.
--
-- The list below is the authoritative constraint (058's set) plus the new kind. It must stay in
-- sync with `AdminStateKind` in src/modules/admin/customer-operations.ts;
-- tests/integration/admin-callback-state-kinds.test.ts asserts the schema accepts every kind the
-- union permits — a kind missing here fails at runtime with a check-constraint violation, which is
-- exactly the failure this list exists to prevent.
alter table admin_callback_state drop constraint if exists admin_callback_state_kind_check;
alter table admin_callback_state
  add constraint admin_callback_state_kind_check
  check (kind in (
    'CUSTOMER_DETAIL',
    'CUSTOMER_MESSAGE_PROMPT',
    'CUSTOMER_SEARCH_PROMPT',
    'CUSTOMER_PAGE',
    'ORDER_DETAIL',
    'ORDER_PAGE',
    'ORDER_MESSAGE_PROMPT',
    'MANUAL_TASK_COMPLETE',
    'FILE_ARTIFACT_IMPORT_CONFIRM',
    'QUANTITY_STOCK_ADJUST_CONFIRM',
    'ADMIN_VARIANT_UPDATE',
    'TEST_CUSTOMER_ADD',
    'CATEGORY_CREATE',
    'CATEGORY_RENAME',
    'WIZARD_CATEGORY_CREATE',
    'WIZARD_CUSTOM_FIELD',
    'WIZARD_ADVANCED',
    'WIZARD_DESC_CUSTOM',
    'ADMIN_PRODUCT_CONTENT_EDIT',
    'WARRANTY_REFUND_ADJUST_PROMPT'
  ));
