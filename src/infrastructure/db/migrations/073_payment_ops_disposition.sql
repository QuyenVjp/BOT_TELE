-- Payment-ops remediation (Slice B) — operator disposition of open payment
-- discrepancies and dead-lettered outbox orphans.
--
-- Both dispositions are STATUS TRANSITIONS on the row that already holds the
-- evidence. A disposition never rewrites or deletes a bank transaction, a
-- payment allocation, or an outbox payload/attempt history: it records who
-- decided what, when, and why, next to the original evidence.
--
--   * `version` / `disposition_version` is the optimistic concurrency guard the
--     admin domain API compares before it writes.
--   * `*_request_id` is the idempotency key of one operator confirmation: the
--     same request id replayed against the same row is a no-op success, a
--     different decision under the same id is a conflict.

-- ---------------------------------------------------------------------------
-- discrepancy
-- ---------------------------------------------------------------------------

alter table discrepancy
  add column if not exists version integer not null default 1,
  add column if not exists resolution_note text,
  add column if not exists resolved_by text,
  add column if not exists disposition_request_id text;

-- Bounded-shape check. The typed disposition API enforces the closed
-- vocabulary; this database constraint keeps legacy rows readable while
-- rejecting malformed new values during the cutover.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'discrepancy'::regclass
      and conname = 'discrepancy_resolution_code_shape_check'
  ) then
    alter table discrepancy
      add constraint discrepancy_resolution_code_shape_check
      check (resolution_code is null or resolution_code ~ '^[A-Z0-9_]{1,64}$')
      not valid;
  end if;
end $$;

-- One operator confirmation resolves exactly one discrepancy. A replayed request
-- id is detected by reading the row; a request id reused on a DIFFERENT row
-- violates this index and is reported as a conflict rather than silently
-- resolving a second discrepancy.
create unique index if not exists discrepancy_disposition_request_uq
  on discrepancy (disposition_request_id)
  where disposition_request_id is not null;

-- ---------------------------------------------------------------------------
-- outbox_event (terminal orphan disposition)
-- ---------------------------------------------------------------------------

alter table outbox_event
  add column if not exists disposition_status text,
  add column if not exists disposition_code text,
  add column if not exists disposition_note text,
  add column if not exists dispositioned_at timestamptz,
  add column if not exists dispositioned_by text,
  add column if not exists disposition_request_id text,
  add column if not exists disposition_version integer not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'outbox_event'::regclass
      and conname = 'outbox_event_disposition_check'
  ) then
    alter table outbox_event
      add constraint outbox_event_disposition_check
      check (
        (disposition_status is null and disposition_code is null and dispositioned_at is null)
        or (disposition_status = 'RESOLVED'
            and disposition_code in (
              'HANDLED_MANUALLY','NO_LONGER_APPLICABLE','DUPLICATE_EVENT',
              'INVALID_EVENT','ESCALATED'
            )
            and dispositioned_at is not null)
      );
  end if;
end $$;

create unique index if not exists outbox_disposition_request_uq
  on outbox_event (disposition_request_id)
  where disposition_request_id is not null;

-- The operator queue reads only parked rows, newest first.
create index if not exists outbox_event_dead_letter_idx
  on outbox_event (dead_lettered_at desc, id)
  where dead_lettered_at is not null;
