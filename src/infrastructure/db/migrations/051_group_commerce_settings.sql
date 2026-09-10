-- 051_group_commerce_settings.sql
-- Group commerce configuration, pinned shop panel durability, restock generation tracking, and acquisition analytics.

create table if not exists group_commerce_settings (
  id text primary key default 'main',
  group_chat_id text not null default '-1003906082671',
  group_reply_mode text not null default 'MENTION_ONLY' check (group_reply_mode in ('MENTION_ONLY', 'PASSIVE_COMMERCE')),
  shop_panel_enabled boolean not null default true,
  shop_panel_message_id text,
  shop_panel_version integer not null default 0,
  welcome_enabled boolean not null default true,
  welcome_cooldown_seconds integer not null default 30,
  last_welcome_at timestamptz,
  restock_publishing_enabled boolean not null default true,
  last_restock_published_at timestamptz,
  social_proof_mode text not null default 'INDIVIDUAL' check (social_proof_mode in ('OFF', 'INDIVIDUAL', 'DIGEST')),
  social_proof_min_interval_seconds integer not null default 120,
  last_social_proof_at timestamptz,
  shop_topic_id text,
  restock_topic_id text,
  support_topic_id text,
  announcement_topic_id text,
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into group_commerce_settings (id)
values ('main')
on conflict (id) do nothing;

create table if not exists group_restock_generation (
  variant_id text primary key,
  last_announced_stock integer not null default 0,
  announced_at timestamptz not null default now()
);

create table if not exists group_acquisition_log (
  id text primary key,
  token text not null,
  product_id text not null,
  variant_id text,
  group_chat_id text not null,
  actor_telegram_user_id text,
  action text not null, -- 'CARD_OPEN' | 'BUY_START' | 'CHECKOUT_COMPLETE'
  order_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_group_acquisition_token on group_acquisition_log(token);
create index if not exists idx_group_acquisition_product on group_acquisition_log(product_id);
create index if not exists idx_group_acquisition_created on group_acquisition_log(created_at desc);
