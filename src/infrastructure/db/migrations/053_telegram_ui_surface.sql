-- Telegram UI supersession.
--
-- A callback that failed and is retried minutes later must not paint over whatever the
-- operator has navigated to in the meantime. Each editable surface (chat + message) records
-- the received_at of the newest inbox event that rendered it; a retry carries an older
-- received_at and is dropped instead of overwriting the current screen.
create table if not exists telegram_ui_surface (
  chat_id text not null,
  message_id text not null,
  event_received_at timestamptz not null,
  rendered_at timestamptz not null default now(),
  render_count integer not null default 1,
  primary key (chat_id, message_id)
);

create index if not exists telegram_ui_surface_rendered_idx
  on telegram_ui_surface (rendered_at);
