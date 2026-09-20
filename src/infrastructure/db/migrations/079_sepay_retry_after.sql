-- Persist provider-requested backoff so scheduled and manual reconciliation share one gate.
alter table sepay_reconciliation_cursor
  add column if not exists retry_after_until timestamptz;
