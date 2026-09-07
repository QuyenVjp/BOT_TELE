alter table notification_campaign
  add column if not exists product_variant_id text references product_variant(id);
