-- Extend durable admin confirmation allowlist for support replacement approval.
-- Preserve previously deployed command refs and update the check in place.

alter table admin_confirmation
  drop constraint if exists admin_confirmation_command_ref_ck;

alter table admin_confirmation
  add constraint admin_confirmation_command_ref_ck
  check (
    allowlisted_command_ref is null
    or allowlisted_command_ref in (
      'discrepancy.resolve',
      'wallet.refund',
      'manual_fulfillment.complete',
      'support.replacement.approve'
    )
  );
