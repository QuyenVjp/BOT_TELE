-- Customer profile snapshot projection for Telegram verified updates.
--
-- Authoritative identity remains customer/channel_identity. This projection
-- stores verified Telegram profile/contact metadata for UI and notifications.

create table if not exists customer_profile_snapshot (
  customer_id      text primary key references customer (id),
  telegram_user_id text not null,
  chat_id          text not null,
  username         text,
  first_name       text,
  last_name        text,
  display_name     text,
  language_code    text,
  reachable        boolean not null default true,
  phone_number     text,
  phone_shared_at  timestamptz,
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  check (telegram_user_id ~ '^[1-9][0-9]{0,19}$'),
  check (chat_id ~ '^[1-9][0-9]{0,19}$')
);

create unique index if not exists customer_profile_snapshot_telegram_user_uq
  on customer_profile_snapshot (telegram_user_id);

create index if not exists customer_profile_snapshot_last_seen_idx
  on customer_profile_snapshot (last_seen_at);
