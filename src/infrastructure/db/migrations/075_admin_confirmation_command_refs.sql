-- Widen the durable AdminConfirmation allowlist to every high-risk owner verb
-- that mints a confirmation instead of mutating immediately.
--
-- The TypeScript vocabulary is DURABLE_ADMIN_COMMAND_REFS
-- (src/modules/identity/admin-confirmation.ts) and this constraint is the
-- database half of the same closed set: a ref the code can issue but the
-- constraint rejects fails closed at insert, and a ref the constraint allows
-- but the code cannot reconstruct is refused when the confirmation is consumed.
--
-- The list is a superset of the refs added by 036, so replacing the constraint
-- validates every deployed row. Forward-only and idempotent: the drop/re-add is
-- safe to re-run, and the runner executes each file in one transaction that
-- rolls the whole file back on failure.

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
      'store.open',
      'store.close',
      'store.test',
      'catalog.publish',
      'catalog.evidence.register'
    )
  );
