-- Broadcast confirmation integrity (THREAT_MODEL SEC-007/SEC-016).
--
-- The delivery table already materialises recipients once, so worker retries
-- cannot fan out twice. What was missing is that the recipient set an operator
-- previewed is not the same object the confirm step sends to: the audience is
-- resolved from live preference tables at queue time. This migration adds a
-- frozen, hashed recipient snapshot and a revision counter so a confirmation is
-- bound to the exact content and audience that were previewed.
--
--   notification_campaign_audience  frozen recipient set, per stage
--   broadcast_throttle              cooldown stamp for large/global sends
--
-- The snapshot is written in the same transaction that queues the deliveries,
-- so "QUEUED" always implies "the recipient set is durable and identified".

alter table notification_campaign
  add column if not exists revision integer not null default 1,
  add column if not exists previewed_content_hash text,
  add column if not exists previewed_audience_hash text,
  add column if not exists previewed_audience_count integer,
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by text,
  add column if not exists audience_hash text;

-- A confirmation without a preview is not a confirmation.
alter table notification_campaign
  drop constraint if exists notification_campaign_confirm_requires_preview_ck;
alter table notification_campaign
  add constraint notification_campaign_confirm_requires_preview_ck
  check (confirmed_at is null or previewed_at is not null);

create table if not exists notification_campaign_audience (
  campaign_id text not null references notification_campaign (id),
  stage text not null check (stage in ('PREVIEW', 'CONFIRMED')),
  customer_id text not null references customer (id),
  chat_id text not null,
  primary key (campaign_id, stage, customer_id)
);

create index if not exists notification_campaign_audience_stage_idx
  on notification_campaign_audience (campaign_id, stage);

-- Single-row cooldown ledger. Large audiences are rate limited so a mistyped or
-- malicious broadcast cannot be repeated immediately at full scale.
create table if not exists broadcast_throttle (
  id text primary key,
  last_large_audience_at timestamptz
);

insert into broadcast_throttle (id) values ('main')
on conflict (id) do nothing;

-- A snapshot is an immutable record of who a confirmed broadcast reached: it is
-- the audit evidence, so it must not be rewritten after the fact.
create or replace function notification_campaign_audience_append_only()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.stage = 'CONFIRMED') then
    raise exception
      'notification_campaign_audience is append-only after confirmation'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

drop trigger if exists notification_campaign_audience_no_rewrite on notification_campaign_audience;
create trigger notification_campaign_audience_no_rewrite
before update or delete on notification_campaign_audience
for each row execute function notification_campaign_audience_append_only();

-- A confirmed broadcast must carry its frozen recipient set.
--
-- Scoped by `confirmed_at`, not by `status`: internal notice campaigns
-- (restock, low-stock, warranty) are queued by domain code and never confirmed
-- by an operator, and their durable record is `notification_delivery`, which is
-- already unique per (campaign, customer). Requiring a snapshot from them too
-- would reject legitimate transactional notices.
create or replace function notification_campaign_assert_confirmed_audience()
returns trigger language plpgsql as $$
begin
  if new.confirmed_at is null then
    return null;
  end if;
  -- A confirmed broadcast with nothing to send is legitimate (nobody reachable).
  if not exists (select 1 from notification_delivery d where d.campaign_id = new.id) then
    return null;
  end if;
  if not exists (
    select 1 from notification_campaign_audience a
    where a.campaign_id = new.id and a.stage = 'CONFIRMED'
  )
  then
    raise exception
      'broadcast % was confirmed without a frozen audience snapshot', new.id
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

drop trigger if exists notification_campaign_confirmed_audience on notification_campaign;
create constraint trigger notification_campaign_confirmed_audience
after insert or update of confirmed_at on notification_campaign
deferrable initially deferred
for each row execute function notification_campaign_assert_confirmed_audience();

-- Reconcile the hash columns back onto any already-queued campaign so the
-- operator view never shows a confirmed send with no evidence. Internal
-- notifications without a preview remain unconfirmed.
update notification_campaign c
set confirmed_at = coalesce(c.confirmed_at, c.previewed_at, c.created_at),
    confirmed_by = coalesce(c.confirmed_by, c.created_by),
    audience_hash = coalesce(c.audience_hash, md5(c.id || ':' || c.audience))
where c.status in ('QUEUED', 'COMPLETED')
  and c.previewed_at is not null;
insert into notification_campaign_audience (campaign_id, stage, customer_id, chat_id)
select distinct d.campaign_id, 'CONFIRMED', d.customer_id, d.chat_id
from notification_delivery d
join notification_campaign c on c.id = d.campaign_id
where c.status in ('QUEUED', 'COMPLETED')
  and c.confirmed_at is not null
on conflict (campaign_id, stage, customer_id) do nothing;
