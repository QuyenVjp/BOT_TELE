-- 061_preorder_payment_intents.sql
-- Deposit / balance payments for a preorder reservation.
--
-- A preorder is paid in two legs (deposit, then the remaining balance when stock is
-- actually allocated). Neither leg belongs to an Order: the Order only exists once the
-- customer has paid in full, because until then nothing is deliverable. Migration 042
-- already added `kind` and `preorder_id` to payment_intent, but `order_id` was still
-- mandatory, so no intent could ever be written for a reservation.

-- Owner is either an Order (order payment) or a preorder reservation (deposit / balance).
alter table payment_intent alter column order_id drop not null;

alter table payment_intent drop constraint if exists payment_intent_owner_check;
alter table payment_intent
  add constraint payment_intent_owner_check
  check (order_id is not null or preorder_id is not null);

-- At most one live intent per reservation LEG: the deposit stays PRESENTED until SePay
-- confirms it, and the balance intent is minted in the same transaction that confirms the
-- deposit (when stock was already available), so both legs can be live at once.
create unique index if not exists payment_intent_active_preorder_leg_uq
  on payment_intent (preorder_id, kind)
  where status in ('CREATED', 'PRESENTED') and preorder_id is not null;
