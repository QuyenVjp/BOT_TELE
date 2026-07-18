-- Migration 002 — Independent review remediation (Phase 9).
--
-- Adds durable claim/lease bookkeeping to the transactional outbox so a poll
-- cycle holds a row across handler dispatch (the previous FOR UPDATE SKIP LOCKED
-- on an autocommit pooled connection released the lock the instant the SELECT
-- returned, allowing two pollers to process the same event). Also adds a global
-- credential fingerprint uniqueness guard for delivered assets.

-- --- Outbox durable lease -------------------------------------------------
alter table outbox_event
  add column if not exists claimed_by      text,
  add column if not exists claimed_at      timestamptz,
  add column if not exists claim_expires_at timestamptz;

-- Fast lookup of due-or-reclaimable rows: unpublished, not dead-lettered,
-- backoff elapsed, and either unclaimed or with an expired lease.
create index if not exists outbox_event_claimable_idx
  on outbox_event (occurred_at)
  where published_at is null and dead_lettered_at is null;

-- --- Global credential fingerprint uniqueness (T147) -----------------------
-- Expand the live-fingerprint unique index to include AVAILABLE stock so the
-- same credential cannot be seeded twice as sellable inventory. The prior
-- index only covered RESERVED/READY/DELIVERED and allowed duplicate AVAILABLE
-- rows (independent review finding).
drop index if exists digital_asset_active_fingerprint_uq;
create unique index digital_asset_active_fingerprint_uq
  on digital_asset (fingerprint_hash)
  where status in ('AVAILABLE', 'RESERVED', 'READY', 'DELIVERED');
