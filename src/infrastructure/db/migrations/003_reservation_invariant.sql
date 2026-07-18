-- Migration 003 — Reservation invariant (Phase 10, follow-up review P1).
--
-- The follow-up review found there was no storage-layer guarantee that an Order
-- holds at most ONE active pre-payment / pre-delivery hold. When same-nonce
-- idempotency (T158) makes two transactions momentarily see the same Order, each
-- could reserve a distinct asset for it, over-allocating stock.
--
-- Scope of this unique index:
--   * Covers status IN ('RESERVED', 'READY') only — the live hold states.
--   * DELIVERED is intentionally EXCLUDED so a historical delivered asset can
--     keep `reserved_order_id` for audit lineage while a later replacement
--     (supersede) reserves a NEW asset for the same Order under RESERVED/READY.
--
-- Supersede semantics (normative, Feature 001+):
--   1. A replacement asset is inserted/claimed as RESERVED (or READY) for the
--      same order_id — the unique index admits it because the prior asset is
--      already DELIVERED (or its reserved_order_id was cleared under audit).
--   2. The prior asset remains DELIVERED with delivered_order_id set for audit;
--      it is never silently re-claimed.
--   3. Application code MUST transition the prior hold out of RESERVED/READY
--      before creating the replacement hold (atomic supersede in one txn).
--
-- Note: `delivered_order_id` is a separate column used after delivery.

create unique index if not exists digital_asset_one_active_reservation_per_order_uq
  on digital_asset (reserved_order_id)
  where reserved_order_id is not null
    and status in ('RESERVED', 'READY');
