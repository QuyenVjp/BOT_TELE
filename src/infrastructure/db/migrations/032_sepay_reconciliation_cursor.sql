create table if not exists sepay_reconciliation_cursor (
  provider text primary key,
  window_from_sec integer not null check (window_from_sec >= 0),
  window_to_sec integer not null check (window_to_sec >= window_from_sec),
  page integer not null default 1 check (page > 0),
  per_page integer not null check (per_page between 1 and 100),
  generation integer not null default 1 check (generation > 0),
  updated_at timestamptz not null default now()
);
