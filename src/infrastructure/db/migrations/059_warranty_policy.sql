-- Warranty policy, structured (goal: warranty vertical, §2/§3/§24/§40).
--
-- The rule cannot live in a free-text description: the customer is shown a specific coverage, the
-- admin is offered a specific set of actions, and a claim must be able to prove which policy it was
-- decided under. Coverage and exclusions are therefore written per variant and SNAPSHOTTED onto the
-- claim at report time — this is the one class of data that cannot be reconstructed later, because
-- editing the product afterwards must not change what a past claim was judged by.

alter table product_variant add column if not exists warranty_enabled boolean not null default false;
-- Proration on by default: the refund follows remaining usable time. Off means the policy refunds
-- the full paid amount for the affected line while the warranty is live.
alter table product_variant add column if not exists warranty_proration_enabled boolean not null default true;
alter table product_variant add column if not exists warranty_replacement_allowed boolean not null default true;
alter table product_variant add column if not exists warranty_refund_allowed boolean not null default true;
alter table product_variant add column if not exists warranty_replacement_behavior text not null default 'CONTINUE_ORIGINAL_END';
alter table product_variant add column if not exists warranty_coverage_vi text;
alter table product_variant add column if not exists warranty_exclusions_vi text;
alter table product_variant add column if not exists warranty_policy_version integer not null default 1;
alter table product_variant add column if not exists warranty_sla_hours integer not null default 12;

alter table product_variant drop constraint if exists product_variant_warranty_replacement_behavior_check;
alter table product_variant
  add constraint product_variant_warranty_replacement_behavior_check
  check (warranty_replacement_behavior in ('CONTINUE_ORIGINAL_END', 'RESET_FROM_REPLACEMENT'));

alter table product_variant drop constraint if exists product_variant_warranty_sla_hours_check;
alter table product_variant
  add constraint product_variant_warranty_sla_hours_check
  check (warranty_sla_hours between 1 and 720);

-- Existing warranties keep working: a variant that already declares days is enabled by definition.
update product_variant
set warranty_enabled = true
where warranty_days > 0 and warranty_enabled = false;

-- Claim-side snapshot of the policy the claim was judged under.
alter table warranty_claim add column if not exists policy_version integer;
alter table warranty_claim add column if not exists coverage_snapshot text;
alter table warranty_claim add column if not exists exclusions_snapshot text;
alter table warranty_claim add column if not exists proration_enabled boolean not null default true;
alter table warranty_claim add column if not exists replacement_allowed boolean not null default true;
alter table warranty_claim add column if not exists refund_allowed boolean not null default true;
alter table warranty_claim add column if not exists replacement_warranty_behavior text not null default 'CONTINUE_ORIGINAL_END';

-- Backfill for any claim opened before this migration, from the order's own snapshot.
update warranty_claim c
set policy_version = coalesce(c.policy_version, 1),
    coverage_snapshot = coalesce(c.coverage_snapshot, 'Bảo hành theo thời gian sử dụng.'),
    exclusions_snapshot = coalesce(c.exclusions_snapshot, '')
where c.policy_version is null;
