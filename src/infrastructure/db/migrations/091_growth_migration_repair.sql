-- Forward repair for the legacy payment reminder migration receipt.
-- The canonical 090 migration already creates this column on fresh databases.
alter table payment_reminder
  add column if not exists send_count integer not null default 0 check (send_count >= 0);
