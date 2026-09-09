-- Test-mode customer allowlist and tri-state store control.
alter table store_control drop constraint if exists store_control_status_check;
alter table store_control add constraint store_control_status_check check (status in ('OPEN', 'CLOSED', 'TEST'));

create table if not exists test_customer_allowlist (
  id text primary key,
  telegram_user_id text not null unique,
  note text,
  added_by text,
  created_at timestamptz not null default now()
);
