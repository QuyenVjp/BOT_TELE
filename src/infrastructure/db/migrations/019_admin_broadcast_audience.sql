alter table notification_campaign
  add column if not exists audience text not null default 'all' check (audience in ('all','shop','activity','root'));

create index if not exists notification_campaign_status_idx
  on notification_campaign (status, created_at);
