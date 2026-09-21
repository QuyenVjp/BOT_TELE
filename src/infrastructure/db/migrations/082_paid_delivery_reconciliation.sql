-- Keep the database half of the durable paid-delivery reconciliation allowlist
-- in sync with TypeScript owner and worker resolution paths.

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
      'catalog.evidence.revoke'
    )
  );
