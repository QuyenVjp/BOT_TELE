-- Goal §81: editing a product's commercial content without recreating it.
--
-- The per-field editor needs a pending "which product, which field" state, and
-- `admin_callback_state` constrains the kind with an explicit allowlist (see 037/052).
-- Keep this list in sync with `AdminStateKind`; tests/integration/admin-callback-state-kinds.test.ts
-- asserts the schema accepts every kind the union permits.
alter table admin_callback_state
  drop constraint if exists admin_callback_state_kind_check;

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
    'ADMIN_PRODUCT_CONTENT_EDIT'
  ));
