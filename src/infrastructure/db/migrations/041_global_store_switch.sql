-- Global store kill-switch state (OPEN vs CLOSED)
create table if not exists store_control (
  id text primary key,
  status text not null check (status in ('OPEN', 'CLOSED')),
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into store_control (id, status, updated_at, updated_by)
values ('main', 'OPEN', now(), 'system')
on conflict (id) do nothing;
