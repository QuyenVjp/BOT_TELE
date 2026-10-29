-- Extend the durable owner-command allowlist for file delivery recovery.
-- Forward-only and idempotent: preserve existing confirmation rows while
-- replacing the database half of the closed command-ref set.

alter table admin_confirmation
  drop constraint if exists admin_confirmation_command_ref_ck;

alter table admin_confirmation
  add constraint admin_confirmation_command_ref_ck
  check (
    allowlisted_command_ref is null
    or allowlisted_command_ref in (
      'discrepancy.resolve',
      'outbox.orphan.dispose',
      'wallet.refund',
      'manual_fulfillment.complete',
      'support.replacement.approve',
      'inventory.ready.release',
      'fulfillment.reconcile',
      'store.open',
      'store.close',
      'store.test',
      'catalog.publish',
      'catalog.evidence.register',
      'catalog.evidence.revoke',
      'file_delivery.recover'
    )
  );
