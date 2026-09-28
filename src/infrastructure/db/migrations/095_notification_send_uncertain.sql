alter table notification_delivery
  drop constraint if exists notification_delivery_status_check;

alter table notification_delivery
  add constraint notification_delivery_status_check
  check (status in ('PENDING', 'SENT', 'RETRY', 'SUPPRESSED', 'DEAD', 'SEND_UNCERTAIN'));

create index if not exists notification_delivery_send_uncertain_idx
  on notification_delivery (campaign_id)
  where status = 'SEND_UNCERTAIN';

do $$
begin
  if exists (
    select 1
    from "order" o
    join notification_campaign legacy
      on legacy.id = 'admin-payment-settled:' || o.id
    where o.fulfillment_type = 'MANUAL_FULFILLMENT'
      and exists (
        select 1
        from notification_campaign target
        where target.id = 'admin-manual-order:' || o.id
          or target.idempotency_key = 'admin-manual-order:' || o.id
      )
  ) then
    raise exception 'manual alert campaign identity collision during migration 095';
  end if;
end;
$$;

insert into notification_campaign (
  id, class, content, status, idempotency_key, created_by, created_at,
  audience, previewed_at, product_variant_id, revision,
  previewed_content_hash, previewed_audience_hash, previewed_audience_count,
  confirmed_at, confirmed_by, audience_hash, buttons
)
select
  'admin-manual-order:' || o.id,
  legacy.class,
  legacy.content,
  legacy.status,
  'admin-manual-order:' || o.id,
  legacy.created_by,
  legacy.created_at,
  legacy.audience,
  legacy.previewed_at,
  legacy.product_variant_id,
  legacy.revision,
  legacy.previewed_content_hash,
  legacy.previewed_audience_hash,
  legacy.previewed_audience_count,
  legacy.confirmed_at,
  legacy.confirmed_by,
  legacy.audience_hash,
  legacy.buttons
from "order" o
join notification_campaign legacy
  on legacy.id = 'admin-payment-settled:' || o.id
where o.fulfillment_type = 'MANUAL_FULFILLMENT';

update notification_delivery d
set campaign_id = 'admin-manual-order:' || o.id
from "order" o
where o.fulfillment_type = 'MANUAL_FULFILLMENT'
  and d.campaign_id = 'admin-payment-settled:' || o.id;

update notification_campaign_audience a
set campaign_id = 'admin-manual-order:' || o.id
from "order" o
where o.fulfillment_type = 'MANUAL_FULFILLMENT'
  and a.campaign_id = 'admin-payment-settled:' || o.id;

delete from notification_campaign legacy
using "order" o
where o.fulfillment_type = 'MANUAL_FULFILLMENT'
  and legacy.id = 'admin-payment-settled:' || o.id;
