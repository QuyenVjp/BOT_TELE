-- Verified social-proof read model and root-admin payment alert delivery identity.
-- PostgreSQL remains authoritative; these columns only persist safe Telegram delivery metadata.
alter table notification_campaign
  add column if not exists buttons jsonb not null default '[]'::jsonb;

alter table notification_delivery
  add column if not exists message_id text;
