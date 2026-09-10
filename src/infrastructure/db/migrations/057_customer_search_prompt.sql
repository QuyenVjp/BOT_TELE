-- Goal §28: the customer search prompt invites a typed product name.
--
-- Every other customer input the bot accepts is either a reply-keyboard label or a signed callback,
-- and the ingress deliberately drops raw text from a normal user (tests/contract/telegram-ingress
-- asserts it). Admitting arbitrary text would also swallow the keyboard labels that are not in the
-- label allowlist, so the search prompt needs its own scoped, one-shot permission:
--
--   * the prompt records a short-lived row for the chat when it renders;
--   * the next acceptable text message consumes it and is treated as the query;
--   * no row, no query — raw text stays dropped exactly as before.
create table if not exists customer_search_prompt (
  chat_id text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists customer_search_prompt_expiry_idx on customer_search_prompt(expires_at);
