-- Variant-level payment presentation override (presentation-only).
--
-- This column carries display hints only: headline, extra/fulfillment notices,
-- and boolean toggles for what the payment screen renders. It deliberately does
-- NOT carry amount, bank, account, reference or callback data — those stay
-- server-derived, so a stored value can never restate an amount or redirect a
-- payment. The application's zod override schema is the real validator; the
-- database only enforces the shape it can check cheaply (object or null).

alter table product_variant
  add column if not exists presentation_profile jsonb;

do $$
begin
  alter table product_variant
    add constraint product_variant_presentation_profile_object_chk
    check (presentation_profile is null or jsonb_typeof(presentation_profile) = 'object');
exception
  when duplicate_object then null;
end;
$$;
