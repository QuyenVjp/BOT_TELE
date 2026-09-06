alter table notification_campaign
  add column if not exists previewed_at timestamptz;

create index if not exists notification_campaign_ready_idx
  on notification_campaign (id, created_by, status)
  where previewed_at is not null;
