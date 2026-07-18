-- Durable SePay ingress uses the shared webhook_inbox table with source='sepay'.
-- The envelope is an allowlisted, redacted evidence copy; raw request bytes are
-- intentionally not persisted in plaintext.
create index if not exists webhook_inbox_sepay_due_idx
  on webhook_inbox (next_attempt_at, received_at, id)
  where source = 'sepay' and processing_status = 'RETRY';

create index if not exists webhook_inbox_sepay_event_idx
  on webhook_inbox (source, source_event_id);

create or replace function protect_sepay_inbox_evidence()
returns trigger language plpgsql as $$
begin
  if old.source = 'sepay' and (
    new.source is distinct from old.source or
    new.source_event_id is distinct from old.source_event_id or
    new.raw_hash is distinct from old.raw_hash or
    new.signature_status is distinct from old.signature_status or
    new.envelope is distinct from old.envelope or
    new.received_at is distinct from old.received_at
  ) then
    raise exception 'SePay inbox evidence is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists webhook_inbox_sepay_evidence_immutable on webhook_inbox;
create trigger webhook_inbox_sepay_evidence_immutable
before update on webhook_inbox
for each row execute function protect_sepay_inbox_evidence();

alter table discrepancy
  add column if not exists source text,
  add column if not exists source_event_id text,
  add column if not exists incoming_raw_hash text;

create unique index if not exists discrepancy_sepay_mutation_uq
  on discrepancy (source, source_event_id, incoming_raw_hash)
  where source = 'sepay' and owner = 'payments-security'
    and type = 'REFERENCE_COLLISION';

-- Feature 001 identity and delivery security objects belong to migration 009.
-- Keep this file frozen after SePay-only objects so databases that recorded 008
-- can be upgraded deterministically without replaying unrelated DDL.
