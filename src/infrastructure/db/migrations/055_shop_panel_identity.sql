-- Durable shop panel identity.
--
-- The panel is one logical message the bot owns and edits in place. Persisting the chat id
-- next to the message id lets the worker verify it is editing the panel in the chat it was
-- created in, and lets a replacement (after the message was deleted) be recorded atomically
-- without ever reposting on every restock or order event.
alter table group_commerce_settings
  add column if not exists shop_panel_chat_id text;
