-- Notification preferences, durable campaigns/deliveries, and stock delta events.
create table if not exists notification_preference (
  customer_id text primary key references customer(id),
  shop_updates boolean not null default false,
  purchase_activity boolean not null default false,
  quiet_start time,
  quiet_end time,
  digest_minutes integer not null default 60 check (digest_minutes between 5 and 1440),
  version integer not null default 1,
  updated_at timestamptz not null default now()
);
create table if not exists notification_campaign (
  id text primary key,
  class text not null check (class in ('CRITICAL_SERVICE','SHOP_UPDATE','PURCHASE_ACTIVITY')),
  content text not null,
  status text not null default 'DRAFT' check (status in ('DRAFT','QUEUED','CANCELLED','COMPLETED')),
  idempotency_key text not null unique,
  created_by text not null,
  created_at timestamptz not null default now()
);
create table if not exists notification_delivery (
  id text primary key,
  campaign_id text not null references notification_campaign(id),
  customer_id text not null references customer(id),
  chat_id text not null,
  status text not null default 'PENDING' check (status in ('PENDING','SENT','RETRY','SUPPRESSED','DEAD')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  sent_at timestamptz,
  claimed_by text,
  claim_generation bigint not null default 0,
  claim_expires_at timestamptz,
  unique (campaign_id, customer_id)
);
create index if not exists notification_delivery_due_idx on notification_delivery(next_attempt_at) where status in ('PENDING','RETRY');
create index if not exists notification_delivery_claim_idx on notification_delivery(claim_expires_at, next_attempt_at) where status in ('PENDING','RETRY');

-- Capture every real inventory transition as a durable redacted event. The
-- worker decides whether it is customer-visible; corrections are never implied.
create or replace function capture_stock_delta() returns trigger language plpgsql as $$
declare
  delta integer;
  event_id text;
begin
  if tg_op = 'INSERT' and new.status = 'AVAILABLE' then delta := 1;
  elsif tg_op = 'UPDATE' and old.status <> 'AVAILABLE' and new.status = 'AVAILABLE' then delta := 1;
  elsif tg_op = 'UPDATE' and old.status = 'AVAILABLE' and new.status <> 'AVAILABLE' then delta := -1;
  else return new;
  end if;
  event_id := md5(random()::text || clock_timestamp()::text);
  insert into outbox_event(id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted)
  values (event_id, 'StockDelta', event_id,
    1, 'StockDelta', jsonb_build_object('assetId', new.id, 'variantId', new.variant_id, 'delta', delta, 'announce', current_setting('app.announce_stock', true) = 'true', 'stockAfter', (select count(*) from digital_asset where variant_id = new.variant_id and status = 'AVAILABLE')));
  return new;
end $$;
drop trigger if exists digital_asset_stock_delta on digital_asset;
create trigger digital_asset_stock_delta after insert or update of status on digital_asset
for each row execute function capture_stock_delta();
