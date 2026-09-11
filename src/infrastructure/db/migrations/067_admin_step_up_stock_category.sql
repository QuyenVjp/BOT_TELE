-- Add STOCK_ADJUSTMENT as a step-up category (migration 066 is SePay's alias work).
--
-- Inventory quantity is money-adjacent: a wrong adjustment either sells stock that does not
-- exist or hides stock that does, so `adjustQuantityStock` now takes a second factor. The
-- category list is enforced by a CHECK constraint on `admin_step_up_grant`, which is the
-- right place for it — a category the database rejects can never be granted — so the
-- constraint must learn the new value in the same release as the code that mints it.
--
-- Dropping and re-adding is the only way to widen a CHECK. The replacement is a strict
-- superset of the previous list: every category that was valid before is still valid, so no
-- existing grant is invalidated and no row is rewritten.

alter table admin_step_up_grant
  drop constraint if exists admin_step_up_grant_category_check;

alter table admin_step_up_grant
  add constraint admin_step_up_grant_category_check check (
    category in (
      'WALLET_ADJUSTMENT', 'PAYMENT_OVERRIDE', 'REFUND', 'SUPPLIER_CONFIG',
      'DELIVERY_REISSUE', 'BULK_PRICE_CHANGE', 'PERMISSION_CHANGE',
      'SECURITY_CONFIG', 'BROADCAST', 'STOCK_ADJUSTMENT'
    )
  );
