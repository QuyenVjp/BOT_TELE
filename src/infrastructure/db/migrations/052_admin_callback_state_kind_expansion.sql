-- The `AdminStateKind` union in src/modules/admin/customer-operations.ts grew
-- with the admin wizard sub-flows and community tooling, but the CHECK constraint
-- was never expanded past migration 037. Every insert of a missing kind failed with
-- SQLSTATE 23514 (admin_callback_state_kind_check), which made these flows unusable:
--
--   * wizard step 5   "Tự nhập" description   (WIZARD_DESC_CUSTOM)
--   * wizard step 7   "Trường nâng cao"       (WIZARD_ADVANCED)
--   * wizard step 7   "Trường tùy chỉnh"      (WIZARD_CUSTOM_FIELD)
--   * wizard step 3   "Tạo danh mục mới"      (WIZARD_CATEGORY_CREATE)
--   * admin categories create / rename        (CATEGORY_CREATE, CATEGORY_RENAME)
--   * Test Lab "thêm khách test"              (TEST_CUSTOMER_ADD)
--
-- Keep this list in sync with AdminStateKind; tests/integration/admin-callback-state-kinds.test.ts
-- asserts the schema accepts every kind that the union permits.
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
    'WIZARD_DESC_CUSTOM'
  ));
