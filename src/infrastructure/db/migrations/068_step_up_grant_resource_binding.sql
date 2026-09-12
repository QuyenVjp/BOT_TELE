-- Bind a step-up grant to the exact object it authorizes (066 is SePay's alias work,
-- 067 is the stock category).
--
-- A grant was bound to (admin, category) only. That is a category check, not a transaction
-- authorization: a `BULK_PRICE_CHANGE` grant minted for variant A would also satisfy a change
-- to variant B, because nothing in the row said which object the owner had actually looked at.
-- The owner approves ONE change to ONE thing, so the grant records which one.
--
-- Nullable on purpose. Existing rows (and the development/test posture, where step-up is off)
-- carry no binding and keep working: `consume` requires a match only when the grant HAS a
-- binding, so a bound grant can never be spent on a different object while an unbound one
-- behaves exactly as before. No row is rewritten and no grant is invalidated.

alter table admin_step_up_grant
  add column if not exists resource_type text null,
  add column if not exists resource_id text null;

-- A binding is all-or-nothing: half a binding cannot be matched, so it must not be storable.
alter table admin_step_up_grant
  drop constraint if exists admin_step_up_grant_binding_ck;
alter table admin_step_up_grant
  add constraint admin_step_up_grant_binding_ck check (
    (resource_type is null and resource_id is null)
    or (resource_type is not null and resource_id is not null)
  );

-- The consume lookup filters on the binding, so it must be indexed with the columns it
-- already filters on, not on its own.
drop index if exists admin_step_up_grant_lookup_idx;
create index if not exists admin_step_up_grant_lookup_idx
  on admin_step_up_grant (admin_telegram_user_id, category, expires_at);
