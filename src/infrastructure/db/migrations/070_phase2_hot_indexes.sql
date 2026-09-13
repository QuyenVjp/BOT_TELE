-- Phase 2 RC profiling: support the two large equality-plus-recency lookups.
--
-- quantity_stock_ledger is queried by variant and newest created_at in the
-- admin inventory history. payment_intent is queried by order and newest
-- created_at for payment/order views. Both tables are append-heavy, so these
-- indexes preserve the existing keyset/order semantics without changing data.

create index if not exists quantity_stock_variant_created_idx
  on quantity_stock_ledger (variant_id, created_at desc, id desc);

create index if not exists payment_intent_order_created_idx
  on payment_intent (order_id, created_at desc, id desc);

