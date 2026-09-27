alter table notification_delivery
  drop constraint if exists notification_delivery_status_check;

alter table notification_delivery
  add constraint notification_delivery_status_check
  check (status in ('PENDING', 'SENT', 'RETRY', 'SUPPRESSED', 'DEAD', 'SEND_UNCERTAIN'));

create index if not exists notification_delivery_send_uncertain_idx
  on notification_delivery (campaign_id)
  where status = 'SEND_UNCERTAIN';
