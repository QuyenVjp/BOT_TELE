create table if not exists payment_reminder (
  order_id      text primary key references "order"(id) on delete cascade,
  customer_id   text not null references customer(id) on delete cascade,
  last_sent_at  timestamptz not null default now(),
  send_count    integer not null default 0 check (send_count >= 0)
);

create index if not exists payment_reminder_customer_idx
  on payment_reminder(customer_id, last_sent_at desc);
