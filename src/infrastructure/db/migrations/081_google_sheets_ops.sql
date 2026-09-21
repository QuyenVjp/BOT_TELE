-- Google Sheets is an asynchronous operations projection, never commerce authority.
-- This migration stores only safe metadata, request idempotency, and sync observability.

create table if not exists google_sheets_asset_metadata (
  asset_id       text primary key references digital_asset(id) on delete cascade,
  cost_price_vnd bigint check (cost_price_vnd >= 0),
  safe_note      text not null default '',
  operational_status text not null default 'ACTIVE'
    check (operational_status in ('ACTIVE', 'DISABLED', 'REVIEW')),
  review_note    text not null default '',
  updated_by     text not null,
  updated_at     timestamptz not null default now(),
  version        integer not null default 1 check (version > 0)
);

create table if not exists google_sheets_request (
  request_id       text primary key,
  requested_at     timestamptz not null default now(),
  requested_by     text not null,
  requested_action text not null,
  target_type      text not null,
  target_ref       text not null,
  expected_version integer not null check (expected_version > 0),
  safe_payload     jsonb not null default '{}'::jsonb,
  status           text not null default 'PENDING'
    check (status in ('PENDING', 'PROCESSING', 'SUCCEEDED', 'REJECTED', 'STALE', 'FAILED')),
  result_code      text,
  result_note      text,
  processed_at     timestamptz,
  source_row_ref   text,
  audit_event_id   text,
  version          integer not null default 1 check (version > 0)
);

create index if not exists google_sheets_request_status_idx
  on google_sheets_request(status, requested_at, request_id);

create table if not exists google_sheets_sync_state (
  id                    text primary key check (id = 'main'),
  schema_version        integer not null default 3 check (schema_version > 0),
  last_attempt_at       timestamptz,
  last_success_at       timestamptz,
  last_outbox_event_id  text,
  last_error_code       text,
  last_error_note       text,
  last_rows_written     integer not null default 0 check (last_rows_written >= 0),
  last_orphan_count     integer not null default 0 check (last_orphan_count >= 0),
  last_request_at       timestamptz,
  version               integer not null default 1 check (version > 0)
);

insert into google_sheets_sync_state (id, schema_version)
values ('main', 3)
on conflict (id) do nothing;

update google_sheets_sync_state
   set schema_version = 3
 where id = 'main' and schema_version < 3;
