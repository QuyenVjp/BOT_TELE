import { sql } from "kysely";
import type { OutboxEvent } from "../../infrastructure/outbox/repository.js";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import { newId } from "../../shared/ids/index.js";

export type NotificationClass = "TRANSACTIONAL" | "CRITICAL_SERVICE" | "SHOP_UPDATE" | "PURCHASE_ACTIVITY";
export type BroadcastAudience = "all" | "shop" | "activity" | "root";
export interface NotificationPreferences { customerId: string; shopUpdates: boolean; purchaseActivity: boolean; quietStart: string | null; quietEnd: string | null; digestMinutes: number; version: number; }
export interface NotificationDeliveryClaim { id: string; campaignId: string; customerId: string; chatId: string; content: string; class: NotificationClass; generation: number; }
export interface BroadcastStatus { campaignId: string; status: string; audience: BroadcastAudience; total: number; pending: number; retry: number; sent: number; suppressed: number; dead: number; }

type NotificationPreferenceRow = { customer_id: string; shop_updates: boolean; purchase_activity: boolean; quiet_start: string | null; quiet_end: string | null; digest_minutes: number; version: number; };
type NotificationDeliveryClaimRow = { id: string; campaign_id: string; customer_id: string; chat_id: string; content: string; class: NotificationClass; claim_generation: string | number; };

function mapPreferences(row: NotificationPreferenceRow): NotificationPreferences {
  return { customerId: row.customer_id, shopUpdates: row.shop_updates, purchaseActivity: row.purchase_activity, quietStart: row.quiet_start, quietEnd: row.quiet_end, digestMinutes: row.digest_minutes, version: row.version };
}

function mapClaim(row: NotificationDeliveryClaimRow): NotificationDeliveryClaim {
  return { id: row.id, campaignId: row.campaign_id, customerId: row.customer_id, chatId: row.chat_id, content: row.content, class: row.class, generation: Number(row.claim_generation) };
}

export async function getNotificationPreferences(exec: Executor, customerId: string): Promise<NotificationPreferences> {
  await sql`insert into notification_preference(customer_id, shop_updates, purchase_activity) values (${customerId}, false, false) on conflict (customer_id) do nothing`.execute(exec);
  const r = await sql<NotificationPreferenceRow>`select customer_id, shop_updates, purchase_activity, quiet_start::text, quiet_end::text, digest_minutes, version from notification_preference where customer_id=${customerId}`.execute(exec);
  return mapPreferences(r.rows[0]!);
}

export async function setNotificationPreferences(exec: Executor, input: { customerId: string; shopUpdates?: boolean; purchaseActivity?: boolean; quietStart?: string | null; quietEnd?: string | null; digestMinutes?: number }): Promise<NotificationPreferences> {
  if (input.digestMinutes !== undefined && (!Number.isInteger(input.digestMinutes) || input.digestMinutes < 5 || input.digestMinutes > 1440)) throw new RangeError("digestMinutes must be 5..1440");
  await getNotificationPreferences(exec, input.customerId);
  const r = await sql<NotificationPreferenceRow>`update notification_preference set shop_updates=coalesce(${input.shopUpdates ?? null},shop_updates), purchase_activity=coalesce(${input.purchaseActivity ?? null},purchase_activity), quiet_start=case when ${input.quietStart !== undefined} then ${input.quietStart ?? null}::time else quiet_start end, quiet_end=case when ${input.quietEnd !== undefined} then ${input.quietEnd ?? null}::time else quiet_end end, digest_minutes=coalesce(${input.digestMinutes ?? null},digest_minutes), version=version+1, updated_at=now() where customer_id=${input.customerId} returning customer_id,shop_updates,purchase_activity,quiet_start::text,quiet_end::text,digest_minutes,version`.execute(exec);
  return mapPreferences(r.rows[0]!);
}

/** Emits a redacted stock delta; delivery policy evaluates opt-in at send time. */
export async function emitStockDelta(exec: Executor, input: { variantId: string; delta: number; stockAfter: number; correlationId: string }): Promise<void> {
  if (!Number.isInteger(input.delta) || input.delta === 0 || !Number.isInteger(input.stockAfter) || input.stockAfter < 0) throw new RangeError("invalid stock delta");
  await enqueueOutboxEvent(exec, { id: newId(), aggregateType: "ProductVariant", aggregateId: input.variantId, aggregateVersion: Date.now(), eventType: "StockDelta", payloadRedacted: { variantId: input.variantId, delta: input.delta, stockAfter: input.stockAfter, correlationId: input.correlationId } });
}

export async function previewBroadcastAudience(exec: Executor, audience: BroadcastAudience, rootTelegramUserId?: string): Promise<number> {
  const r = await sql<{ count: number }>`select count(*)::int
    from customer c
    left join customer_profile_snapshot cps on cps.customer_id=c.id
    left join channel_identity ci on ci.customer_id=c.id and ci.channel='TELEGRAM'
    left join notification_preference np on np.customer_id=c.id
    where c.status='ACTIVE'
      and (cps.customer_id is null or cps.reachable)
      and coalesce(cps.chat_id,ci.channel_user_id) is not null
      and ((${audience}='root' and ci.channel_user_id=${rootTelegramUserId ?? null})
        or (${audience}='all')
        or (${audience}='shop' and np.shop_updates is true)
        or (${audience}='activity' and np.purchase_activity is true))`.execute(exec);
  return r.rows[0]?.count ?? 0;
}

export async function markBroadcastPreviewed(exec: Executor, input: { campaignId: string; createdBy: string; content: string }): Promise<boolean> {
  const r = await sql<{ id: string }>`update notification_campaign
    set content=${input.content.trim()}, previewed_at=now()
    where id=${input.campaignId} and created_by=${input.createdBy} and status='DRAFT'
      and ${input.content.trim().length > 0} and ${input.content.length <= 4096}
    returning id`.execute(exec);
  return r.rows.length === 1;
}

export async function createBroadcast(exec: Executor, input: { campaignId?: string; class: Exclude<NotificationClass,"TRANSACTIONAL">; content: string; createdBy: string; idempotencyKey: string; audience?: BroadcastAudience; queued?: boolean }): Promise<string> {
  if (input.content.trim().length === 0 || input.content.length > 4096) throw new RangeError("invalid notification content");
  const id = input.campaignId ?? newId();
  const audience = input.audience ?? (input.class === "SHOP_UPDATE" ? "shop" : input.class === "PURCHASE_ACTIVITY" ? "activity" : "all");
  await sql`insert into notification_campaign(id,class,content,status,created_by,idempotency_key,audience) values (${id},${input.class},${input.content.trim()},${input.queued ? "QUEUED" : "DRAFT"},${input.createdBy},${input.idempotencyKey},${audience}) on conflict (idempotency_key) do nothing`.execute(exec);
  return id;
}

export async function enqueueBroadcastRecipients(exec: Executor, campaignId: string, rootTelegramUserId?: string, createdBy?: string): Promise<number> {
  const r = await sql<{ n: number }>`with campaign as (
      update notification_campaign set status='QUEUED'
      where id=${campaignId} and status='DRAFT'
        and (${createdBy ?? null}::text is null or created_by=${createdBy ?? null})
        and previewed_at is not null
      returning id,audience
    ) insert into notification_delivery(id,campaign_id,customer_id,chat_id)
    select md5(${campaignId}||c.id),${campaignId},c.id,coalesce(cps.chat_id,ci.channel_user_id)
    from campaign nc
    join customer c on c.status='ACTIVE'
    left join customer_profile_snapshot cps on cps.customer_id=c.id
    left join channel_identity ci on ci.customer_id=c.id and ci.channel='TELEGRAM'
    left join notification_preference np on np.customer_id=c.id
    where nc.audience <> 'root'
      and (cps.customer_id is null or cps.reachable)
      and coalesce(cps.chat_id,ci.channel_user_id) is not null
      and (nc.audience='all'
        or (nc.audience='shop' and np.shop_updates is true)
        or (nc.audience='activity' and np.purchase_activity is true))
    union all
    select md5(${campaignId}||ci.customer_id),${campaignId},ci.customer_id,coalesce(cps.chat_id,ci.channel_user_id)
    from campaign nc
    join channel_identity ci on ci.channel='TELEGRAM' and ci.channel_user_id=${rootTelegramUserId ?? null}
    join customer c on c.id=ci.customer_id and c.status='ACTIVE'
    left join customer_profile_snapshot cps on cps.customer_id=c.id
    where nc.audience='root'
      and (cps.customer_id is null or cps.reachable)
      and coalesce(cps.chat_id,ci.channel_user_id) is not null
    on conflict (campaign_id,customer_id) do nothing returning 1 as n`.execute(exec);
  return r.rows.length;
}

export async function cancelBroadcast(exec: Executor, campaignId: string): Promise<number> {
  const r = await sql<{ n: number }>`with cancelled as (
      update notification_campaign set status='CANCELLED'
      where id=${campaignId} and status in ('DRAFT','QUEUED') returning id
    ) update notification_delivery set status='SUPPRESSED', last_error='admin_cancelled'
    where campaign_id in (select id from cancelled) and status in ('PENDING','RETRY') returning 1 as n`.execute(exec);
  return r.rows.length;
}

export async function getBroadcastStatus(exec: Executor, campaignId: string): Promise<BroadcastStatus | null> {
  const r = await sql<{ campaign_id: string; status: string; audience: BroadcastAudience; total: number; pending: number; retry: number; sent: number; suppressed: number; dead: number }>`select
      c.id as campaign_id, c.status, c.audience,
      count(d.id)::int as total,
      count(d.id) filter (where d.status='PENDING')::int as pending,
      count(d.id) filter (where d.status='RETRY')::int as retry,
      count(d.id) filter (where d.status='SENT')::int as sent,
      count(d.id) filter (where d.status='SUPPRESSED')::int as suppressed,
      count(d.id) filter (where d.status='DEAD')::int as dead
    from notification_campaign c
    left join notification_delivery d on d.campaign_id=c.id
    where c.id=${campaignId}
    group by c.id`.execute(exec);
  const row = r.rows[0];
  return row ? { campaignId: row.campaign_id, status: row.status, audience: row.audience, total: row.total, pending: row.pending, retry: row.retry, sent: row.sent, suppressed: row.suppressed, dead: row.dead } : null;
}

export async function claimNotificationDeliveries(exec: Executor, limit: number): Promise<NotificationDeliveryClaim[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be 1..100");
  const r = await sql<NotificationDeliveryClaimRow>`with picked as (
    select d.id from notification_delivery d join notification_campaign c on c.id=d.campaign_id
    where d.status in ('PENDING','RETRY') and d.next_attempt_at<=now() and c.status='QUEUED'
      and (d.claim_expires_at is null or d.claim_expires_at<=now())
    order by d.next_attempt_at,d.id for update of d skip locked limit ${limit}
  ) update notification_delivery d set status='RETRY',attempts=d.attempts+1,
    next_attempt_at=now()+interval '30 seconds',claimed_by='notification-worker',
    claim_expires_at=now()+interval '30 seconds',claim_generation=d.claim_generation+1
    from picked p, notification_campaign c where d.id=p.id and c.id=d.campaign_id
    returning d.id,d.campaign_id,d.customer_id,d.chat_id,c.content,c.class,d.claim_generation`.execute(exec);
  return r.rows.map(mapClaim);
}

export async function markNotificationSent(exec: Executor, id: string, generation: number): Promise<boolean> {
  const r = await sql<{ id: string }>`update notification_delivery set status='SENT',sent_at=now(),last_error=null,claimed_by=null,claim_expires_at=null where id=${id} and status='RETRY' and claim_generation=${generation} returning id`.execute(exec);
  return r.rows.length === 1;
}

export async function markNotificationSuppressed(exec: Executor, id: string, generation: number, reason: string): Promise<boolean> {
  const r = await sql<{ id: string }>`update notification_delivery set status='SUPPRESSED',last_error=${reason.slice(0,200)},claimed_by=null,claim_expires_at=null where id=${id} and status='RETRY' and claim_generation=${generation} returning id`.execute(exec);
  return r.rows.length === 1;
}

export async function markNotificationFailure(exec: Executor, id: string, generation: number, error: string, maxAttempts=5, retryAfterSeconds=30): Promise<boolean> {
  const delay = Number.isFinite(retryAfterSeconds) ? Math.max(1, Math.min(86400, Math.ceil(retryAfterSeconds))) : 30;
  const r = await sql<{ id: string }>`update notification_delivery set status=case when attempts>=${maxAttempts} then 'DEAD' else 'RETRY' end,next_attempt_at=case when attempts>=${maxAttempts} then next_attempt_at else now()+${delay}*interval '1 second' end,last_error=${error.slice(0,200)},claimed_by=null,claim_expires_at=null where id=${id} and status='RETRY' and claim_generation=${generation} returning id`.execute(exec);
  return r.rows.length === 1;
}

export async function processNotificationDeliveryClaim(exec: Executor, delivery: NotificationDeliveryClaim, responder: { send(input: { chatId: string; messageId: null; message: { text: string; buttons: [] } }): Promise<unknown> }, input?: { maxAttempts?: number; retryAfterSeconds?: (error: unknown) => number | null; onRateLimit?: (seconds: number) => Promise<void> }): Promise<"SENT" | "SUPPRESSED" | "RETRY" | "STALE"> {
  try {
    const active = await sql<{ id: string }>`select d.id from notification_delivery d join notification_campaign c on c.id=d.campaign_id where d.id=${delivery.id} and d.status='RETRY' and d.claim_generation=${delivery.generation} and d.claim_expires_at>now() and c.status='QUEUED'`.execute(exec);
    if (!active.rows.length) return "STALE";
    const pref = await getNotificationPreferences(exec, delivery.customerId);
    if ((delivery.class === "SHOP_UPDATE" && !pref.shopUpdates) || (delivery.class === "PURCHASE_ACTIVITY" && !pref.purchaseActivity)) {
      return await markNotificationSuppressed(exec, delivery.id, delivery.generation, "preference_opt_out") ? "SUPPRESSED" : "STALE";
    }
    await responder.send({ chatId: delivery.chatId, messageId: null, message: { text: delivery.content, buttons: [] } });
    return await markNotificationSent(exec, delivery.id, delivery.generation) ? "SENT" : "STALE";
  } catch (error) {
    const retryAfter = input?.retryAfterSeconds?.(error) ?? 30;
    if (retryAfter > 0 && input?.retryAfterSeconds?.(error)) await input.onRateLimit?.(retryAfter);
    if (typeof error === "object" && error !== null && "error_code" in error && (error.error_code === 403 || (error.error_code === 400 && "description" in error && /chat not found/i.test(String(error.description))))) {
      const changed = await markNotificationSuppressed(exec, delivery.id, delivery.generation, "chat_unreachable");
      if (changed) await sql`update customer_profile_snapshot set reachable=false where customer_id=${delivery.customerId} and chat_id=${delivery.chatId}`.execute(exec);
      return changed ? "SUPPRESSED" : "STALE";
    }
    return await markNotificationFailure(exec, delivery.id, delivery.generation, error instanceof Error ? error.name : "TELEGRAM_ERROR", input?.maxAttempts, retryAfter) ? "RETRY" : "STALE";
  }
}

function positiveRestockDelta(event: OutboxEvent): { variantId: string } | null {
  if (event.eventType !== "StockDelta") return null;
  if (event.payloadRedacted.announce !== true) return null;
  const { variantId, delta, stockAfter } = event.payloadRedacted;
  return typeof variantId === "string" && typeof delta === "number" && delta > 0 && typeof stockAfter === "number" && stockAfter >= 1
    ? { variantId } : null;
}

export async function handleNotificationOutboxEvent(db: Db, event: OutboxEvent): Promise<{ kind: "PUBLISHED" } | { kind: "RETRY"; errorCode: string }> {
  const stock = positiveRestockDelta(event);
  if (!stock) return { kind: "PUBLISHED" };

  await withTransaction(db, async (trx) => {
    const campaignId = `restock:${event.id}`;
    await sql`insert into notification_campaign(id,class,content,status,created_by,idempotency_key) values (${campaignId},'SHOP_UPDATE','Sản phẩm bạn theo dõi đã có hàng lại.','QUEUED','system',${campaignId}) on conflict (idempotency_key) do nothing`.execute(trx);
    await sql<{ n: number }>`insert into notification_delivery(id,campaign_id,customer_id,chat_id)
      select md5(${campaignId}||rs.customer_id),${campaignId},rs.customer_id,coalesce(cps.chat_id,ci.channel_user_id)
      from restock_subscription rs
      join customer c on c.id=rs.customer_id and c.status='ACTIVE'
      left join customer_profile_snapshot cps on cps.customer_id=rs.customer_id and cps.reachable
      left join channel_identity ci on ci.customer_id=rs.customer_id and ci.channel='TELEGRAM'
      join notification_preference np on np.customer_id=rs.customer_id and np.shop_updates is true
      where rs.variant_id=${stock.variantId} and rs.active
        and coalesce(cps.chat_id,ci.channel_user_id) is not null
      on conflict (campaign_id,customer_id) do nothing returning 1 as n`.execute(trx);
  });
  return { kind: "PUBLISHED" };
}
