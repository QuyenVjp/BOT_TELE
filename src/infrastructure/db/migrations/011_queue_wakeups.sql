-- 011_queue_wakeups.sql
-- NOTIFY is only a wake hint. PostgreSQL durable queue rows remain authoritative.
-- Triggers run in the producer transaction, so notifications are delivered only
-- after the durable INSERT commits; missed notifications are safe under polling.

create or replace function notify_bot_tele_queue() returns trigger
language plpgsql
as $$
begin
  if tg_table_name = 'outbox_event' then
    perform pg_notify('bot_tele_outbox', '');
  elsif new.source = 'telegram' then
    perform pg_notify('bot_tele_telegram_inbox', '');
  elsif new.source = 'sepay' then
    perform pg_notify('bot_tele_sepay_inbox', '');
  end if;
  return new;
end;
$$;

drop trigger if exists webhook_inbox_queue_wakeup on webhook_inbox;
create trigger webhook_inbox_queue_wakeup
after insert on webhook_inbox
for each row execute function notify_bot_tele_queue();

drop trigger if exists outbox_event_queue_wakeup on outbox_event;
create trigger outbox_event_queue_wakeup
after insert on outbox_event
for each row execute function notify_bot_tele_queue();
