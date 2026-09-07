create or replace function capture_stock_delta() returns trigger language plpgsql as $$
declare
  delta integer;
  event_id text;
  previous_available integer;
  current_available integer;
  threshold integer;
begin
  if tg_op = 'INSERT' and new.status = 'AVAILABLE' then delta := 1;
  elsif tg_op = 'UPDATE' and old.status <> 'AVAILABLE' and new.status = 'AVAILABLE' then delta := 1;
  elsif tg_op = 'UPDATE' and old.status = 'AVAILABLE' and new.status <> 'AVAILABLE' then delta := -1;
  else return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.variant_id));

  select low_stock_threshold into threshold
  from product_variant
  where id = new.variant_id;

  select count(*)::int into current_available
  from digital_asset
  where variant_id = new.variant_id and status = 'AVAILABLE';
  previous_available := current_available - delta;

  event_id := md5(random()::text || clock_timestamp()::text);
  insert into outbox_event(id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted)
  values (event_id, 'StockDelta', event_id,
    1, 'StockDelta', jsonb_build_object(
      'assetId', new.id,
      'variantId', new.variant_id,
      'delta', delta,
      'announce', current_setting('app.announce_stock', true) = 'true',
      'stockAfter', current_available,
      'source', 'DISCRETE',
      'lowStockAlert', coalesce(threshold > 0 and previous_available > threshold and current_available <= threshold, false),
      'threshold', threshold
    ));
  return new;
end $$;
