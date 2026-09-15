-- Owner-initiated revocation of resale evidence (FLASH-003 operational gap).
--
-- 072 keeps evidence facts append-only and lets a revocation change only
-- lifecycle/provenance. This migration adds the provenance half of that: the
-- request id that carried the protected confirmation, so the same request is a
-- no-op replay and a request reused for another record fails closed.
--
-- Facts stay immutable: this file does NOT touch prevent_resale_evidence_mutation(),
-- which still refuses every change to id, variant_id, source, reference, summary,
-- metadata_redacted, created_by, registration_request_id and created_at.
--
-- Forward-only and idempotent: every statement is additive or drop/re-add, and the
-- runner executes this file inside one transaction that rolls the whole file back
-- on failure.

alter table resale_evidence
  add column if not exists revocation_request_id text;

-- Durable idempotency key for revocation requests (mirror of
-- resale_evidence_request_uq for registration).
create unique index if not exists resale_evidence_revocation_request_uq
  on resale_evidence (revocation_request_id) where revocation_request_id is not null;

-- A revocation request may only be recorded together with the revoked state, so an
-- ACTIVE record can never carry revocation provenance.
alter table resale_evidence
  drop constraint if exists resale_evidence_revocation_state_ck;

alter table resale_evidence
  add constraint resale_evidence_revocation_state_ck
  check (revocation_request_id is null or status = 'REVOKED');

-- Database half of the same closed set as DURABLE_ADMIN_COMMAND_REFS
-- (src/modules/identity/admin-confirmation.ts) and 075: a ref the code can issue
-- but this constraint rejects fails closed at insert, and a ref the constraint
-- allows but the code cannot reconstruct is refused when the confirmation is
-- consumed. The list is a superset of 075, so replacing the constraint validates
-- every deployed row.
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
      'catalog.evidence.register',
      'catalog.evidence.revoke'
    )
  );
