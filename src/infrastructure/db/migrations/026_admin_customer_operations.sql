create table if not exists admin_callback_state (
  id text primary key,
  admin_telegram_user_id text not null,
  kind text not null check (kind in ('CUSTOMER_DETAIL','CUSTOMER_MESSAGE_PROMPT','CUSTOMER_SEARCH_PROMPT','CUSTOMER_PAGE','MANUAL_TASK_COMPLETE')),
  payload_redacted jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists admin_callback_state_admin_expiry_idx on admin_callback_state(admin_telegram_user_id, expires_at);

create table if not exists admin_customer_message_draft (
  admin_telegram_user_id text primary key,
  customer_id text not null references customer(id),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists admin_customer_message_draft_expiry_idx on admin_customer_message_draft(expires_at);

create index if not exists customer_profile_snapshot_username_idx on customer_profile_snapshot(lower(username));
create index if not exists customer_profile_snapshot_phone_shared_idx on customer_profile_snapshot(phone_number) where phone_shared_at is not null;
create index if not exists support_ticket_open_customer_idx on support_ticket(customer_id) where status in ('OPEN','WAITING_SHOP','WAITING_CUSTOMER','MANUAL_REVIEW');
