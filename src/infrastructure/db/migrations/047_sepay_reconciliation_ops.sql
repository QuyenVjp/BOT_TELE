-- Durable SePay reconciliation ops. Provider polling is independent of local
-- unpaid payment_intent backlog. No secrets or customer PII.
alter table sepay_reconciliation_cursor
  add column if not exists last_started_at timestamptz,
  add column if not exists last_success_at timestamptz,
  add column if not exists last_provider_cursor text,
  add column if not exists pages_scanned integer not null default 0,
  add column if not exists transactions_scanned integer not null default 0,
  add column if not exists missing_found integer not null default 0,
  add column if not exists backfilled integer not null default 0,
  add column if not exists unmatched integer not null default 0,
  add column if not exists failed integer not null default 0,
  add column if not exists consecutive_failures integer not null default 0,
  add column if not exists last_error_class text;
