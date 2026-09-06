create table notification_rate_slot (
  scope text primary key,
  next_at timestamptz not null
);
