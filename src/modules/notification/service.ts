import { createHash } from "node:crypto";
import { sql } from "kysely";
import { ISSUE_TYPE_LABELS } from "../warranty/claims.js";
import type { OutboxEvent } from "../../infrastructure/outbox/repository.js";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import { formatVnd, makeVnd } from "../../shared/money/index.js";
import { newId } from "../../shared/ids/index.js";
import { appendAuditEvent } from "../identity/audit.js";

export type NotificationClass =
  "TRANSACTIONAL" | "CRITICAL_SERVICE" | "SHOP_UPDATE" | "PURCHASE_ACTIVITY";
export type BroadcastAudience = "all" | "shop" | "activity" | "root";
export type NotificationButton = { text: string; callbackData: string };
export interface NotificationPreferences {
  customerId: string;
  shopUpdates: boolean;
  purchaseActivity: boolean;
  quietStart: string | null;
  quietEnd: string | null;
  digestMinutes: number;
  version: number;
}
export interface NotificationDeliveryClaim {
  id: string;
  campaignId: string;
  customerId: string;
  chatId: string;
  telegramUserId?: string;
  content: string;
  class: NotificationClass;
  productVariantId?: string | null;
  buttons: NotificationButton[][];
  messageId: string | null;
  generation: number;
}
export interface BroadcastStatus {
  campaignId: string;
  status: string;
  audience: BroadcastAudience;
  total: number;
  pending: number;
  retry: number;
  sent: number;
  suppressed: number;
  dead: number;
}
export interface NotificationResponder {
  send(input: {
    chatId: string;
    telegramUserId: string;
    messageId: string | null;
    message: { text: string; buttons: Array<Array<{ text: string; callbackData: string }>> };
  }): Promise<unknown>;
}

type NotificationPreferenceRow = {
  customer_id: string;
  shop_updates: boolean;
  purchase_activity: boolean;
  quiet_start: string | null;
  quiet_end: string | null;
  digest_minutes: number;
  version: number;
};
type NotificationDeliveryClaimRow = {
  id: string;
  campaign_id: string;
  customer_id: string;
  chat_id: string;
  telegram_user_id: string;
  content: string;
  class: NotificationClass;
  product_variant_id: string | null;
  buttons: unknown;
  message_id: string | null;
  claim_generation: string | number;
};

function mapPreferences(row: NotificationPreferenceRow): NotificationPreferences {
  return {
    customerId: row.customer_id,
    shopUpdates: row.shop_updates,
    purchaseActivity: row.purchase_activity,
    quietStart: row.quiet_start,
    quietEnd: row.quiet_end,
    digestMinutes: row.digest_minutes,
    version: row.version,
  };
}

function safeButton(value: unknown): NotificationButton | null {
  if (!value || typeof value !== "object" || !("text" in value) || !("callbackData" in value))
    return null;
  const text = value.text;
  const callbackData = value.callbackData;
  return typeof text === "string" && typeof callbackData === "string"
    ? { text: text.slice(0, 64), callbackData: callbackData.slice(0, 128) }
    : null;
}

function safeButtons(value: unknown): NotificationButton[][] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) =>
      row.map(safeButton).filter((button): button is NotificationButton => button !== null),
    )
    .filter((row) => row.length > 0)
    .slice(0, 4)
    .map((row) => row.slice(0, 2));
}

function mapClaim(row: NotificationDeliveryClaimRow): NotificationDeliveryClaim {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    customerId: row.customer_id,
    chatId: row.chat_id,
    telegramUserId: row.telegram_user_id,
    content: row.content,
    class: row.class,
    productVariantId: row.product_variant_id,
    buttons: safeButtons(row.buttons),
    messageId: row.message_id,
    generation: Number(row.claim_generation),
  };
}

async function hasActiveRestockSubscriptionForDelivery(
  exec: Executor,
  delivery: Pick<NotificationDeliveryClaim, "campaignId" | "customerId">,
): Promise<boolean> {
  const r = await sql<{ id: string }>`select rs.id
    from notification_campaign c
    join outbox_event o on o.id = substring(c.id from 9)
    join restock_subscription rs on rs.customer_id = ${delivery.customerId}
      and rs.variant_id = o.payload_redacted->>'variantId'
      and rs.active
    where c.id = ${delivery.campaignId} and c.id like 'restock:%'
    limit 1`.execute(exec);
  return r.rows.length === 1;
}

export async function getNotificationPreferences(
  exec: Executor,
  customerId: string,
): Promise<NotificationPreferences> {
  await sql`insert into notification_preference(customer_id, shop_updates, purchase_activity) values (${customerId}, false, false) on conflict (customer_id) do nothing`.execute(
    exec,
  );
  const r =
    await sql<NotificationPreferenceRow>`select customer_id, shop_updates, purchase_activity, quiet_start::text, quiet_end::text, digest_minutes, version from notification_preference where customer_id=${customerId}`.execute(
      exec,
    );
  return mapPreferences(r.rows[0]!);
}

export async function setNotificationPreferences(
  exec: Executor,
  input: {
    customerId: string;
    shopUpdates?: boolean;
    purchaseActivity?: boolean;
    quietStart?: string | null;
    quietEnd?: string | null;
    digestMinutes?: number;
  },
): Promise<NotificationPreferences> {
  if (
    input.digestMinutes !== undefined &&
    (!Number.isInteger(input.digestMinutes) ||
      input.digestMinutes < 5 ||
      input.digestMinutes > 1440)
  )
    throw new RangeError("digestMinutes must be 5..1440");
  await getNotificationPreferences(exec, input.customerId);
  const r =
    await sql<NotificationPreferenceRow>`update notification_preference set shop_updates=coalesce(${input.shopUpdates ?? null},shop_updates), purchase_activity=coalesce(${input.purchaseActivity ?? null},purchase_activity), quiet_start=case when ${input.quietStart !== undefined} then ${input.quietStart ?? null}::time else quiet_start end, quiet_end=case when ${input.quietEnd !== undefined} then ${input.quietEnd ?? null}::time else quiet_end end, digest_minutes=coalesce(${input.digestMinutes ?? null},digest_minutes), version=version+1, updated_at=now() where customer_id=${input.customerId} returning customer_id,shop_updates,purchase_activity,quiet_start::text,quiet_end::text,digest_minutes,version`.execute(
      exec,
    );
  return mapPreferences(r.rows[0]!);
}

/** Emits a redacted stock delta; delivery policy evaluates opt-in at send time. */
export async function emitStockDelta(
  exec: Executor,
  input: { variantId: string; delta: number; stockAfter: number; correlationId: string },
): Promise<void> {
  if (
    !Number.isInteger(input.delta) ||
    input.delta === 0 ||
    !Number.isInteger(input.stockAfter) ||
    input.stockAfter < 0
  )
    throw new RangeError("invalid stock delta");
  await enqueueOutboxEvent(exec, {
    id: newId(),
    aggregateType: "ProductVariant",
    aggregateId: input.variantId,
    aggregateVersion: Date.now(),
    eventType: "StockDelta",
    payloadRedacted: {
      variantId: input.variantId,
      delta: input.delta,
      stockAfter: input.stockAfter,
      correlationId: input.correlationId,
    },
  });
}

export async function previewBroadcastAudience(
  exec: Executor,
  audience: BroadcastAudience,
  rootTelegramUserId?: string,
  campaignClass?: NotificationClass,
): Promise<number> {
  return (await selectBroadcastAudience(exec, audience, rootTelegramUserId, campaignClass)).length;
}

/** One frozen recipient of a broadcast. */
export interface BroadcastRecipient {
  customerId: string;
  chatId: string;
}

/**
 * The single audience query. Preview counts it and confirmation materialises the
 * deliveries from it, so "what the operator was shown" and "what is sent" cannot
 * drift apart by two copies of the same filter evolving separately.
 *
 * `campaignClass` carries the critical-service exemption on the `all` audience:
 * a CRITICAL_SERVICE notice reaches every reachable customer, not only the ones
 * who opted into shop updates. Omitted, the stricter opt-in rule applies.
 */
export async function selectBroadcastAudience(
  exec: Executor,
  audience: BroadcastAudience,
  rootTelegramUserId?: string,
  campaignClass?: NotificationClass,
): Promise<BroadcastRecipient[]> {
  const r = await sql<{ customer_id: string; chat_id: string }>`select distinct
      c.id as customer_id,
      coalesce(cps.chat_id, ci.channel_user_id) as chat_id
    from customer c
    left join customer_profile_snapshot cps on cps.customer_id=c.id
    left join channel_identity ci on ci.customer_id=c.id and ci.channel='TELEGRAM'
    left join notification_preference np on np.customer_id=c.id
    where c.status='ACTIVE'
      and (cps.customer_id is null or cps.reachable)
      and coalesce(cps.chat_id,ci.channel_user_id) is not null
      and ((${audience}='root' and ci.channel_user_id=${rootTelegramUserId ?? null})
        or (${audience}='all' and (${campaignClass ?? null}='CRITICAL_SERVICE' or np.shop_updates is true))
        or (${audience}='shop' and np.shop_updates is true)
        or (${audience}='activity' and np.purchase_activity is true))
    order by customer_id`.execute(exec);
  return r.rows.map((row) => ({ customerId: row.customer_id, chatId: row.chat_id }));
}

/**
 * Deterministic fingerprint of a frozen recipient set.
 *
 * Sorted, with explicit unit/record separators, so two different audiences
 * cannot collide by boundary shifting. This is an integrity identity — it
 * detects drift between preview and confirmation; it is not a secret.
 */
export function hashBroadcastAudience(recipients: readonly BroadcastRecipient[]): string {
  const canonical = recipients
    .map((recipient) => `${recipient.customerId}\u001f${recipient.chatId}`)
    .sort()
    .join("\u001e");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function hashBroadcastContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function recipientsToJson(recipients: readonly BroadcastRecipient[]): string {
  return JSON.stringify(
    recipients.map((recipient) => ({
      customer_id: recipient.customerId,
      chat_id: recipient.chatId,
    })),
  );
}

/** Persist the frozen recipient set for one stage of the broadcast lifecycle. */
async function freezeBroadcastAudience(
  exec: Executor,
  campaignId: string,
  stage: "PREVIEW" | "CONFIRMED",
  recipients: readonly BroadcastRecipient[],
): Promise<void> {
  await sql`
    insert into notification_campaign_audience (campaign_id, stage, customer_id, chat_id)
    select ${campaignId}, ${stage}, v.customer_id, v.chat_id
    from jsonb_to_recordset(${recipientsToJson(recipients)}::jsonb)
      as v(customer_id text, chat_id text)
    on conflict (campaign_id, stage, customer_id) do nothing
  `.execute(exec);
}

export async function markBroadcastPreviewed(
  exec: Executor,
  input: {
    campaignId: string;
    createdBy: string;
    content: string;
    /** Needed to freeze a `root`-only audience at preview time. */
    rootTelegramUserId?: string;
  },
): Promise<boolean> {
  const found = await sql<{ audience: BroadcastAudience; class: NotificationClass }>`
    select audience, class from notification_campaign where id=${input.campaignId}
  `.execute(exec);
  const target = found.rows[0];
  if (!target) return false;

  const recipients = await selectBroadcastAudience(
    exec,
    target.audience,
    input.rootTelegramUserId,
    target.class,
  );
  const r = await sql<{ id: string }>`update notification_campaign
    set content=${input.content.trim()},
        previewed_at=now(),
        revision=revision+1,
        previewed_content_hash=${hashBroadcastContent(input.content.trim())},
        previewed_audience_hash=${hashBroadcastAudience(recipients)},
        previewed_audience_count=${recipients.length}
    where id=${input.campaignId} and created_by=${input.createdBy} and status='DRAFT'
      and ${input.content.trim().length > 0} and ${input.content.length <= 4096}
    returning id`.execute(exec);
  if (r.rows.length !== 1) return false;

  await freezeBroadcastAudience(exec, input.campaignId, "PREVIEW", recipients);
  return true;
}

export type BroadcastRefusal =
  "NOT_FOUND" | "NOT_DRAFT" | "NOT_PREVIEWED" | "NOT_OWNED" | "STALE_PREVIEW" | "COOLDOWN_ACTIVE";

export type BroadcastConfirmation =
  | { ok: true; queued: number; revision: number; audienceHash: string }
  | { ok: false; reason: BroadcastRefusal };

export interface ConfirmBroadcastInput {
  campaignId: string;
  createdBy?: string;
  rootTelegramUserId?: string;
  correlationId: string;
  /** An audience this large is rate limited by `cooldownSeconds`. */
  largeAudienceThreshold: number;
  cooldownSeconds: number;
  /** Injectable clock so cooldown behaviour is testable. */
  now?: Date;
}

/** Refuse a large/global send while the previous one is still cooling down. */
async function broadcastCooldownActive(
  exec: Executor,
  audienceSize: number,
  input: ConfirmBroadcastInput,
): Promise<boolean> {
  if (audienceSize < input.largeAudienceThreshold || input.cooldownSeconds <= 0) return false;
  const throttle = await sql<{ last_large_audience_at: Date | null }>`
    select last_large_audience_at from broadcast_throttle where id='main' for update
  `.execute(exec);
  const last = throttle.rows[0]?.last_large_audience_at ?? null;
  if (last === null) return false;
  const now = input.now ?? new Date();
  return now.getTime() - new Date(last).getTime() < input.cooldownSeconds * 1000;
}

/**
 * Confirm a previewed broadcast: freeze the recipient set, then queue it.
 *
 * Fail-closed order:
 *  1. the campaign exists, belongs to this admin, and is still a DRAFT;
 *  2. it was previewed;
 *  3. its content still hashes to the previewed content — a divergence means the
 *     operator's confirmation refers to text they never reviewed;
 *  4. the frozen preview audience, when one exists, still matches the live
 *     audience — otherwise the preview is stale and must be re-reviewed;
 *  5. a large/global send respects the cooldown;
 *  6. only then are deliveries materialised from the frozen set, with the
 *     CONFIRMED snapshot written in the same transaction.
 *
 * A worker retry cannot fan out twice: the campaign leaves DRAFT exactly once
 * and `notification_delivery` is keyed by (campaign_id, customer_id).
 */
export async function confirmBroadcast(
  exec: Executor,
  input: ConfirmBroadcastInput,
): Promise<BroadcastConfirmation> {
  const found = await sql<{
    status: string;
    audience: BroadcastAudience;
    class: NotificationClass;
    created_by: string;
    revision: number;
    content: string;
    previewed_at: Date | null;
    previewed_content_hash: string | null;
    previewed_audience_hash: string | null;
  }>`select status, audience, class, created_by, revision, content, previewed_at,
            previewed_content_hash, previewed_audience_hash
    from notification_campaign where id=${input.campaignId} for update`.execute(exec);
  const campaign = found.rows[0];
  if (!campaign) return { ok: false, reason: "NOT_FOUND" };
  if (input.createdBy !== undefined && campaign.created_by !== input.createdBy) {
    return { ok: false, reason: "NOT_OWNED" };
  }
  if (campaign.status !== "DRAFT") return { ok: false, reason: "NOT_DRAFT" };
  if (campaign.previewed_at === null) return { ok: false, reason: "NOT_PREVIEWED" };

  const previewRows = await sql<{ customer_id: string; chat_id: string }>`
    select customer_id, chat_id from notification_campaign_audience
    where campaign_id=${input.campaignId} and stage='PREVIEW'
    order by customer_id
  `.execute(exec);
  const frozen: BroadcastRecipient[] = previewRows.rows.map((row) => ({
    customerId: row.customer_id,
    chatId: row.chat_id,
  }));

  const live = await selectBroadcastAudience(
    exec,
    campaign.audience,
    input.rootTelegramUserId,
    campaign.class,
  );

  // A frozen preview exists, so it is the reviewed set. Content that no longer
  // matches its previewed hash, or an audience that has since moved, means the
  // operator is about to confirm something they did not see.
  if (frozen.length > 0) {
    if (campaign.previewed_content_hash !== hashBroadcastContent(campaign.content)) {
      return { ok: false, reason: "STALE_PREVIEW" };
    }
    if (
      campaign.previewed_audience_hash !== null &&
      hashBroadcastAudience(live) !== campaign.previewed_audience_hash
    ) {
      return { ok: false, reason: "STALE_PREVIEW" };
    }
  }

  const recipients = frozen.length > 0 ? frozen : live;
  const audienceHash = hashBroadcastAudience(recipients);

  if (await broadcastCooldownActive(exec, recipients.length, input)) {
    return { ok: false, reason: "COOLDOWN_ACTIVE" };
  }

  await freezeBroadcastAudience(exec, input.campaignId, "CONFIRMED", recipients);

  const now = input.now ?? new Date();
  const queued = await sql<{ n: number }>`with confirmed as (
      update notification_campaign
      set status='QUEUED',
          confirmed_at=${now.toISOString()},
          confirmed_by=${input.createdBy ?? null},
          audience_hash=${audienceHash}
      where id=${input.campaignId} and status='DRAFT' and previewed_at is not null
      returning id
    ) insert into notification_delivery(id,campaign_id,customer_id,chat_id)
    select md5(${input.campaignId}||v.customer_id),${input.campaignId},v.customer_id,v.chat_id
    from confirmed, jsonb_to_recordset(${recipientsToJson(recipients)}::jsonb)
      as v(customer_id text, chat_id text)
    on conflict (campaign_id,customer_id) do nothing
    returning 1 as n`.execute(exec);

  if (queued.rows.length !== recipients.length) {
    // Lost the DRAFT race to another confirmer: the campaign is no longer ours.
    return { ok: false, reason: "NOT_DRAFT" };
  }

  if (recipients.length >= input.largeAudienceThreshold && input.cooldownSeconds > 0) {
    await sql`
      update broadcast_throttle set last_large_audience_at=${now.toISOString()} where id='main'
    `.execute(exec);
  }

  await appendAuditEvent(exec, {
    actorType: "ROOT_ADMIN",
    actorId: input.createdBy ?? "unknown",
    action: "broadcast.confirmed",
    targetType: "NotificationCampaign",
    targetId: input.campaignId,
    reason: `queued=${queued.rows.length} audience=${recipients.length}`,
    correlationId: input.correlationId,
    metadataRedacted: {
      revision: campaign.revision,
      audience: campaign.audience,
      audienceCount: recipients.length,
      audienceHash,
      contentHash: campaign.previewed_content_hash,
    },
  });

  return {
    ok: true,
    queued: queued.rows.length,
    revision: campaign.revision,
    audienceHash,
  };
}

export async function createBroadcast(
  exec: Executor,
  input: {
    campaignId?: string;
    class: Exclude<NotificationClass, "TRANSACTIONAL">;
    content: string;
    createdBy: string;
    idempotencyKey: string;
    audience?: BroadcastAudience;
    queued?: boolean;
  },
): Promise<string> {
  if (input.content.trim().length === 0 || input.content.length > 4096)
    throw new RangeError("invalid notification content");
  const id = input.campaignId ?? newId();
  const audience =
    input.audience ??
    (input.class === "SHOP_UPDATE"
      ? "shop"
      : input.class === "PURCHASE_ACTIVITY"
        ? "activity"
        : "all");
  await sql`insert into notification_campaign(id,class,content,status,created_by,idempotency_key,audience) values (${id},${input.class},${input.content.trim()},${input.queued ? "QUEUED" : "DRAFT"},${input.createdBy},${input.idempotencyKey},${audience}) on conflict (idempotency_key) do nothing`.execute(
    exec,
  );
  return id;
}

export async function previewStockAnnouncementBroadcast(
  exec: Executor,
  input: { variantId: string; createdBy: string; correlationId: string },
): Promise<{ campaignId: string; content: string; audience: "shop"; count: number } | null> {
  const idempotencyKey = `stock-announcement:${input.createdBy}:${input.variantId}:${input.correlationId}`;
  const result = await sql<{
    product_name: string;
    variant_name: string;
    price_vnd: string | number;
    available: number;
  }>`
    select p.name_vi as product_name, v.name_vi as variant_name, v.price_vnd,
      case when v.fulfillment_type = 'QUANTITY_STOCK'
        then coalesce(q.available_quantity, 0)::int
        else count(da.id)::int
      end as available
    from product_variant v
    join product p on p.id = v.product_id and p.is_active
    join category cat on cat.id = p.category_id and cat.is_active
    left join variant_quantity_stock q on q.variant_id = v.id
    left join digital_asset da on da.variant_id = v.id and da.status = 'AVAILABLE'
    where v.id = ${input.variantId}
      and v.is_active
      and v.fulfillment_type in ('STOCK_ACCOUNT', 'STOCK_CODE', 'QUANTITY_STOCK')
    group by p.name_vi, v.name_vi, v.price_vnd, v.fulfillment_type, q.available_quantity
    having case when v.fulfillment_type = 'QUANTITY_STOCK'
      then coalesce(q.available_quantity, 0)::int
      else count(da.id)::int
    end > 0
    limit 1
  `.execute(exec);
  const row = result.rows[0];
  if (!row) return null;
  const content = [
    "Sản phẩm đã có hàng/cập nhật tồn kho.",
    `Sản phẩm: ${row.product_name}`,
    `Gói: ${row.variant_name}`,
    `Tồn kho hiện tại: ${row.available}`,
    `Giá hiện tại: ${formatVnd(makeVnd(BigInt(row.price_vnd)))}`,
  ].join("\n");
  await sql`
    insert into notification_campaign(id,class,content,status,created_by,idempotency_key,audience,product_variant_id,previewed_at)
    values (${newId()},'SHOP_UPDATE',${content},'DRAFT',${input.createdBy},${idempotencyKey},'shop',${input.variantId},now())
    on conflict (idempotency_key) do nothing
  `.execute(exec);
  const persisted = await sql<{ id: string; content: string }>`
    select id, content from notification_campaign
    where idempotency_key = ${idempotencyKey} and created_by = ${input.createdBy}
    limit 1
  `.execute(exec);
  const campaign = persisted.rows[0];
  if (!campaign) return null;
  return {
    campaignId: campaign.id,
    content: campaign.content,
    audience: "shop",
    count: await previewBroadcastAudience(exec, "shop"),
  };
}

export async function enqueueBroadcastRecipients(
  exec: Executor,
  campaignId: string,
  rootTelegramUserId?: string,
  createdBy?: string,
): Promise<number> {
  // Compatibility path for existing callers: queue a previewed draft and return
  // the number of new deliveries. It now also freezes the CONFIRMED recipient
  // snapshot, so the "QUEUED implies a durable audience" invariant holds on this
  // path too. New code should prefer `confirmBroadcast`, which additionally
  // refuses a stale preview and applies the large-broadcast cooldown.
  const found = await sql<{
    status: string;
    audience: BroadcastAudience;
    class: NotificationClass;
    created_by: string;
  }>`select status, audience, class, created_by from notification_campaign
    where id=${campaignId} for update`.execute(exec);
  const campaign = found.rows[0];
  if (!campaign || campaign.status !== "DRAFT") return 0;
  if (createdBy !== undefined && campaign.created_by !== createdBy) return 0;

  const previewed = await sql<{ id: string }>`
    select id from notification_campaign
    where id=${campaignId} and status='DRAFT' and previewed_at is not null
  `.execute(exec);
  if (previewed.rows.length !== 1) return 0;

  const recipients = await selectBroadcastAudience(
    exec,
    campaign.audience,
    rootTelegramUserId,
    campaign.class,
  );
  await freezeBroadcastAudience(exec, campaignId, "CONFIRMED", recipients);

  const queued = await sql<{ n: number }>`with confirmed as (
      update notification_campaign
      set status='QUEUED',
          confirmed_at=now(),
          confirmed_by=${createdBy ?? null},
          audience_hash=${hashBroadcastAudience(recipients)}
      where id=${campaignId} and status='DRAFT' and previewed_at is not null
      returning id
    ) insert into notification_delivery(id,campaign_id,customer_id,chat_id)
    select md5(${campaignId}||v.customer_id),${campaignId},v.customer_id,v.chat_id
    from confirmed, jsonb_to_recordset(${recipientsToJson(recipients)}::jsonb)
      as v(customer_id text, chat_id text)
    on conflict (campaign_id,customer_id) do nothing
    returning 1 as n`.execute(exec);
  return queued.rows.length;
}

export async function cancelBroadcast(
  exec: Executor,
  campaignId: string,
  actor?: { actorId: string; correlationId: string },
): Promise<number> {
  const r = await sql<{ n: number }>`with cancelled as (
      update notification_campaign set status='CANCELLED'
      where id=${campaignId} and status in ('DRAFT','QUEUED') returning id
    ) update notification_delivery set status='SUPPRESSED', last_error='admin_cancelled'
    where campaign_id in (select id from cancelled) and status in ('PENDING','RETRY') returning 1 as n`.execute(
    exec,
  );
  if (actor) {
    const cancelled = await sql<{ status: string; revision: number }>`
      select status, revision from notification_campaign where id=${campaignId}
    `.execute(exec);
    if (cancelled.rows[0]?.status === "CANCELLED") {
      await appendAuditEvent(exec, {
        actorType: "ROOT_ADMIN",
        actorId: actor.actorId,
        action: "broadcast.cancelled",
        targetType: "NotificationCampaign",
        targetId: campaignId,
        reason: `suppressed=${r.rows.length}`,
        correlationId: actor.correlationId,
        metadataRedacted: { suppressed: r.rows.length, revision: cancelled.rows[0].revision },
      });
    }
  }
  return r.rows.length;
}

export async function getBroadcastStatus(
  exec: Executor,
  campaignId: string,
): Promise<BroadcastStatus | null> {
  const r = await sql<{
    campaign_id: string;
    status: string;
    audience: BroadcastAudience;
    total: number;
    pending: number;
    retry: number;
    sent: number;
    suppressed: number;
    dead: number;
  }>`select
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
  return row
    ? {
        campaignId: row.campaign_id,
        status: row.status,
        audience: row.audience,
        total: row.total,
        pending: row.pending,
        retry: row.retry,
        sent: row.sent,
        suppressed: row.suppressed,
        dead: row.dead,
      }
    : null;
}
export async function claimNotificationDeliveries(
  exec: Executor,
  limit: number,
): Promise<NotificationDeliveryClaim[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError("limit must be 1..100");
  const r = await sql<NotificationDeliveryClaimRow>`with picked as (
    select d.id from notification_delivery d join notification_campaign c on c.id=d.campaign_id
    where d.status in ('PENDING','RETRY') and d.next_attempt_at<=now() and c.status='QUEUED'
      and (d.claim_expires_at is null or d.claim_expires_at<=now())
    order by case when c.class='CRITICAL_SERVICE' then 0 else 1 end,d.next_attempt_at,d.id
    for update of d skip locked limit ${limit}
  ) update notification_delivery d set status='RETRY',attempts=d.attempts+1,
    next_attempt_at=now()+interval '30 seconds',claimed_by='notification-worker',
    claim_expires_at=now()+interval '30 seconds',claim_generation=d.claim_generation+1
    from picked p, notification_campaign c
    where d.id=p.id and c.id=d.campaign_id
    returning d.id,d.campaign_id,d.customer_id,d.chat_id,
      coalesce((select cps.telegram_user_id from customer_profile_snapshot cps where cps.customer_id=d.customer_id),
        (select ci.channel_user_id from channel_identity ci where ci.customer_id=d.customer_id and ci.channel='TELEGRAM' limit 1),
        d.chat_id) as telegram_user_id,
      c.content,c.class,c.product_variant_id,c.buttons,d.message_id,d.claim_generation`.execute(
    exec,
  );
  return r.rows.map(mapClaim);
}

export async function markNotificationSent(
  exec: Executor,
  id: string,
  generation: number,
  messageId: string | null = null,
): Promise<boolean> {
  const r = await sql<{
    id: string;
  }>`update notification_delivery set status='SENT',sent_at=now(),last_error=null,
      message_id=coalesce(${messageId}, message_id),
      claimed_by=null,claim_expires_at=null
      where id=${id} and status='RETRY' and claim_generation=${generation} returning id`.execute(
    exec,
  );
  return r.rows.length === 1;
}

export async function markNotificationSuppressed(
  exec: Executor,
  id: string,
  generation: number,
  reason: string,
): Promise<boolean> {
  const r = await sql<{
    id: string;
  }>`update notification_delivery set status='SUPPRESSED',last_error=${reason.slice(0, 200)},claimed_by=null,claim_expires_at=null where id=${id} and status='RETRY' and claim_generation=${generation} returning id`.execute(
    exec,
  );
  return r.rows.length === 1;
}

export async function markNotificationFailure(
  exec: Executor,
  id: string,
  generation: number,
  error: string,
  maxAttempts = 5,
  retryAfterSeconds = 30,
): Promise<boolean> {
  const delay = Number.isFinite(retryAfterSeconds)
    ? Math.max(1, Math.min(86400, Math.ceil(retryAfterSeconds)))
    : 30;
  const r = await sql<{
    id: string;
  }>`update notification_delivery set status=case when attempts>=${maxAttempts} then 'DEAD' else 'RETRY' end,next_attempt_at=case when attempts>=${maxAttempts} then next_attempt_at else now()+${delay}*interval '1 second' end,last_error=${error.slice(0, 200)},claimed_by=null,claim_expires_at=null where id=${id} and status='RETRY' and claim_generation=${generation} returning id`.execute(
    exec,
  );
  return r.rows.length === 1;
}

function sentMessageId(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("messageId" in value)) return null;
  const messageId = value.messageId;
  return typeof messageId === "string" && messageId.trim() ? messageId : null;
}

export async function processNotificationDeliveryClaim(
  exec: Executor,
  delivery: NotificationDeliveryClaim,
  responder: NotificationResponder,
  input?: {
    maxAttempts?: number;

    retryAfterSeconds?: (error: unknown) => number | null;
    onRateLimit?: (seconds: number) => Promise<void>;
  },
): Promise<"SENT" | "SUPPRESSED" | "RETRY" | "STALE"> {
  try {
    const active = await sql<{
      id: string;
    }>`select d.id from notification_delivery d join notification_campaign c on c.id=d.campaign_id where d.id=${delivery.id} and d.status='RETRY' and d.claim_generation=${delivery.generation} and d.claim_expires_at>now() and c.status='QUEUED'`.execute(
      exec,
    );
    if (!active.rows.length) return "STALE";
    const pref = await getNotificationPreferences(exec, delivery.customerId);
    const restockConsent =
      delivery.class === "SHOP_UPDATE" &&
      (await hasActiveRestockSubscriptionForDelivery(exec, delivery));
    if (
      (delivery.class === "SHOP_UPDATE" && !pref.shopUpdates && !restockConsent) ||
      (delivery.class === "PURCHASE_ACTIVITY" && !pref.purchaseActivity)
    ) {
      return (await markNotificationSuppressed(
        exec,
        delivery.id,
        delivery.generation,
        "preference_opt_out",
      ))
        ? "SUPPRESSED"
        : "STALE";
    }
    const sent = await responder.send({
      telegramUserId: delivery.telegramUserId ?? delivery.chatId,
      chatId: delivery.chatId,
      messageId: delivery.messageId,
      message: {
        text: delivery.content,
        buttons:
          delivery.buttons.length > 0
            ? delivery.buttons
            : delivery.productVariantId
              ? [[{ text: "Xem sản phẩm", callbackData: `var:view:${delivery.productVariantId}` }]]
              : [],
      },
    });
    return (await markNotificationSent(exec, delivery.id, delivery.generation, sentMessageId(sent)))
      ? "SENT"
      : "STALE";
  } catch (error) {
    const retryAfter = input?.retryAfterSeconds?.(error) ?? 30;
    if (retryAfter > 0 && input?.retryAfterSeconds?.(error)) await input.onRateLimit?.(retryAfter);
    if (
      typeof error === "object" &&
      error !== null &&
      "error_code" in error &&
      (error.error_code === 403 ||
        (error.error_code === 400 &&
          "description" in error &&
          /chat not found/i.test(String(error.description))))
    ) {
      const changed = await markNotificationSuppressed(
        exec,
        delivery.id,
        delivery.generation,
        "chat_unreachable",
      );
      if (changed)
        await sql`update customer_profile_snapshot set reachable=false where customer_id=${delivery.customerId} and chat_id=${delivery.chatId}`.execute(
          exec,
        );
      return changed ? "SUPPRESSED" : "STALE";
    }
    return (await markNotificationFailure(
      exec,
      delivery.id,
      delivery.generation,
      error instanceof Error ? error.name : "TELEGRAM_ERROR",
      input?.maxAttempts,
      retryAfter,
    ))
      ? "RETRY"
      : "STALE";
  }
}

function positiveRestockDelta(
  event: OutboxEvent,
): { variantId: string; quantityAdded: number; stockAfter: number } | null {
  if (event.eventType !== "StockDelta") return null;
  const { variantId, delta, stockAfter } = event.payloadRedacted;
  return typeof variantId === "string" &&
    typeof delta === "number" &&
    delta > 0 &&
    typeof stockAfter === "number" &&
    stockAfter - delta <= 0
    ? { variantId, quantityAdded: delta, stockAfter }
    : null;
}

async function restockCampaignSnapshot(
  exec: Executor,
  stock: { variantId: string; quantityAdded: number; stockAfter: number },
): Promise<{ content: string; variantId: string } | null> {
  const result = await sql<{
    product_name: string;
    variant_name: string;
    price_vnd: string | number;
  }>`
    select p.name_vi as product_name, v.name_vi as variant_name, v.price_vnd
    from product_variant v
    join product p on p.id = v.product_id
    where v.id = ${stock.variantId} and v.is_active and p.is_active
    limit 1
  `.execute(exec);
  const row = result.rows[0];
  if (!row) return null;
  return {
    variantId: stock.variantId,
    content: [
      "Sản phẩm bạn theo dõi đã có hàng lại.",
      `Sản phẩm: ${row.product_name}`,
      `Gói: ${row.variant_name}`,
      `Mới thêm: ${stock.quantityAdded}`,
      `Tồn kho hiện tại: ${stock.stockAfter}`,
      `Giá hiện tại: ${formatVnd(makeVnd(BigInt(row.price_vnd)))}`,
    ].join("\n"),
  };
}

function lowStockAlertDelta(
  event: OutboxEvent,
): { variantId: string; stockAfter: number; threshold: number } | null {
  if (event.eventType !== "StockDelta" || event.payloadRedacted.lowStockAlert !== true) return null;
  const { variantId, stockAfter, threshold } = event.payloadRedacted;
  return typeof variantId === "string" &&
    typeof stockAfter === "number" &&
    stockAfter >= 0 &&
    typeof threshold === "number" &&
    threshold > 0 &&
    stockAfter <= threshold
    ? { variantId, stockAfter, threshold }
    : null;
}

function walletNotification(
  event: OutboxEvent,
): { campaignId: string; customerId: string; amount: string; content: string } | null {
  const { customerId, amountVnd } = event.payloadRedacted;
  if (typeof customerId !== "string" || !customerId.trim()) return null;
  if (typeof amountVnd === "number" && !Number.isSafeInteger(amountVnd)) return null;
  const amount = typeof amountVnd === "number" ? String(amountVnd) : amountVnd;
  if (
    typeof amount !== "string" ||
    !/^[0-9]{1,19}$/.test(amount) ||
    BigInt(amount) <= 0n ||
    BigInt(amount) > 9223372036854775807n
  )
    return null;
  switch (event.eventType) {
    case "WalletTopupPresented":
      return {
        campaignId: `wallet-topup-presented:${event.aggregateId}`,
        customerId,
        amount,
        content: `Yêu cầu nạp ví ${amount}đ đang chờ thanh toán.`,
      };
    case "WalletTopupCredited":
      return {
        campaignId: `wallet-topup-credited:${event.aggregateId}`,
        customerId,
        amount,
        content: `Ví của bạn đã được cộng ${amount}đ.`,
      };
    case "WalletRefunded":
      return {
        campaignId: `wallet-refunded:${event.aggregateId}`,
        customerId,
        amount,
        content: `Ví của bạn đã được hoàn ${amount}đ.`,
      };
    default:
      return null;
  }
}

async function queueCustomerCriticalNotification(
  trx: Executor,
  notice: { campaignId: string; customerId: string; content: string },
): Promise<boolean> {
  const target = await sql<{ chat_id: string }>`
    select coalesce(cps.chat_id, ci.channel_user_id) as chat_id
    from customer c
    left join customer_profile_snapshot cps on cps.customer_id = c.id and cps.reachable
    left join channel_identity ci on ci.customer_id = c.id and ci.channel = 'TELEGRAM'
    where c.id = ${notice.customerId} and c.status = 'ACTIVE'
    limit 1
  `.execute(trx);
  const chatId = target.rows[0]?.chat_id;
  if (!chatId) return false;
  await sql`
    insert into notification_campaign(id, class, content, status, created_by, idempotency_key)
    values (${notice.campaignId}, 'CRITICAL_SERVICE', ${notice.content}, 'QUEUED', 'system', ${notice.campaignId})
    on conflict (idempotency_key) do nothing
  `.execute(trx);
  await sql`
    insert into notification_delivery(id, campaign_id, customer_id, chat_id)
    values (${newId()}, ${notice.campaignId}, ${notice.customerId}, ${chatId})
    on conflict (campaign_id, customer_id) do nothing
  `.execute(trx);
  return true;
}

/** Queue a critical notice to the owner's own chat. Same shape as the low-stock alert. */
async function queueRootCriticalNotification(
  trx: Executor,
  notice: { campaignId: string; content: string; buttons?: NotificationButton[][] },
  rootTelegramUserId: number | undefined,
): Promise<boolean> {
  if (rootTelegramUserId === undefined) return false;
  const root = await sql<{ customer_id: string; chat_id: string }>`
    select customer_id, channel_user_id as chat_id
    from channel_identity
    where channel = 'TELEGRAM' and channel_user_id = ${String(rootTelegramUserId)}
    limit 1
  `.execute(trx);
  const target = root.rows[0];
  if (!target) return false;
  await sql`
    insert into notification_campaign(id, class, content, status, created_by, idempotency_key, buttons)
    values (${notice.campaignId}, 'CRITICAL_SERVICE', ${notice.content}, 'QUEUED', 'system',
      ${notice.campaignId}, ${JSON.stringify(notice.buttons ?? [])}::jsonb)
    on conflict (idempotency_key) do nothing
  `.execute(trx);
  await sql`
    insert into notification_delivery(id, campaign_id, customer_id, chat_id)
    values (${newId()}, ${notice.campaignId}, ${target.customer_id}, ${target.chat_id})
    on conflict (campaign_id, customer_id) do nothing
  `.execute(trx);
  return true;
}

async function queueRootLowStockAlert(
  trx: Executor,
  event: OutboxEvent,
  alert: { variantId: string; stockAfter: number; threshold: number },
  rootTelegramUserId: number | undefined,
): Promise<boolean> {
  if (rootTelegramUserId === undefined) return false;
  const root = await sql<{ customer_id: string; chat_id: string }>`
    select customer_id, channel_user_id as chat_id
    from channel_identity
    where channel = 'TELEGRAM' and channel_user_id = ${String(rootTelegramUserId)}
    limit 1
  `.execute(trx);
  const target = root.rows[0];
  if (!target) return false;
  const campaignId = `low-stock:${event.id}`;
  await sql`
    insert into notification_campaign(id, class, content, status, created_by, idempotency_key)
    values (${campaignId}, 'CRITICAL_SERVICE', ${`Sản phẩm ${alert.variantId} sắp hết hàng: còn ${alert.stockAfter}, ngưỡng ${alert.threshold}.`}, 'QUEUED', 'system', ${campaignId})
    on conflict (idempotency_key) do nothing
  `.execute(trx);
  await sql`
    insert into notification_delivery(id, campaign_id, customer_id, chat_id)
    values (${newId()}, ${campaignId}, ${target.customer_id}, ${target.chat_id})
    on conflict (campaign_id, customer_id) do nothing
  `.execute(trx);
  return true;
}

export async function queueManualFulfillmentNotification(
  db: Db,
  input: {
    customerId: string;
    taskId: string;
    state: "WAITING" | "COMPLETED";
    correlationId: string;
  },
): Promise<boolean> {
  const content =
    input.state === "WAITING"
      ? "Đơn hàng của bạn đang chờ nhân viên xử lý thủ công. Shop sẽ thông báo khi hoàn tất."
      : "Đơn hàng xử lý thủ công của bạn đã hoàn tất. Cảm ơn bạn đã chờ.";
  return withTransaction(db, async (trx) => {
    const target = await sql<{ chat_id: string }>`
      select coalesce(cps.chat_id, ci.channel_user_id) as chat_id
      from customer c
      left join customer_profile_snapshot cps on cps.customer_id = c.id and cps.reachable
      left join channel_identity ci on ci.customer_id = c.id and ci.channel = 'TELEGRAM'
      where c.id = ${input.customerId} and c.status = 'ACTIVE'
      limit 1
    `.execute(trx);
    const chatId = target.rows[0]?.chat_id;
    if (!chatId) return false;
    const campaignId = `manual-fulfillment:${input.taskId}:${input.state}`;
    await sql`
      insert into notification_campaign(id, class, content, status, created_by, idempotency_key)
      values (${campaignId}, 'CRITICAL_SERVICE', ${content}, 'QUEUED', 'system', ${campaignId})
      on conflict (idempotency_key) do nothing
    `.execute(trx);
    await sql`
      insert into notification_delivery(id, campaign_id, customer_id, chat_id)
      values (${newId()}, ${campaignId}, ${input.customerId}, ${chatId})
      on conflict (campaign_id, customer_id) do nothing
    `.execute(trx);
    return true;
  });
}

function shopCancelNotification(
  event: OutboxEvent,
): { campaignId: string; customerId: string; content: string } | null {
  if (event.eventType !== "PreorderShopCancelled") return null;
  const { customerId, amountDue } = event.payloadRedacted;
  if (typeof customerId !== "string" || !customerId.trim()) return null;
  const amount =
    typeof amountDue === "number"
      ? amountDue
      : typeof amountDue === "string" && /^[0-9]{1,19}$/.test(amountDue)
        ? Number(amountDue)
        : 0;
  if (!Number.isSafeInteger(amount) || amount < 0) return null;
  const lines = ["Shop không thể cung cấp sản phẩm này.", "Yêu cầu của bạn đã được huỷ."];
  if (amount > 0) {
    lines.push(`Số tiền cần hoàn: ${amount.toLocaleString("vi-VN")} đ`);
    lines.push("Đang chờ hoàn tiền");
  }
  return {
    campaignId: `preorder-shop-cancelled:${event.aggregateId}`,
    customerId,
    content: lines.join("\n"),
  };
}

/**
 * Warranty claim notices (goal: warranty vertical).
 *
 * Admin alert on submission so a claim is never left waiting silently, and customer notices on
 * every resolution. The copy never exposes a credential, never promises money before it has moved,
 * and never claims a refund was paid before the admin confirms the transfer.
 */
/** Owner-facing reason labels; the customer-facing wording lives in the support presenter. */
const SUPPORT_REASON_ADMIN_LABELS: Record<string, string> = {
  ASSET_NOT_WORKING: "Tài khoản không dùng được",
  PAYMENT_QUESTION: "Thắc mắc thanh toán",
  DELIVERY_NOT_RECEIVED: "Chưa nhận hàng",
  REFUND_REQUEST: "Yêu cầu hoàn tiền",
  GENERAL_QUESTION: "Câu hỏi chung",
  OTHER: "Khác",
};

/**
 * A customer opening a ticket is work the owner must see: the ticket exists in the queue either
 * way, but nothing pushed it to the owner's chat. Same shape as the warranty alert, delivered to
 * the root chat.
 */
function ticketOpenedAdminAlert(
  event: OutboxEvent,
): { campaignId: string; content: string } | null {
  if (event.eventType !== "TicketOpened") return null;
  const p = event.payloadRedacted;
  if (typeof p.ticketId !== "string" || typeof p.customerId !== "string") return null;
  const reason = typeof p.reasonCode === "string" ? p.reasonCode : "";
  return {
    campaignId: `ticket-opened:${event.aggregateId}`,
    content: [
      "🛡 Yêu cầu hỗ trợ mới",
      "",
      `Khách: ${p.customerId.slice(-4).padStart(8, "•")}`,
      `Loại: ${SUPPORT_REASON_ADMIN_LABELS[reason] ?? "Khác"}`,
      "Mở mục Hỗ trợ để xử lý.",
    ].join("\n"),
  };
}

function warrantyAdminAlert(event: OutboxEvent): { campaignId: string; content: string } | null {
  if (event.eventType !== "WarrantyClaimOpened") return null;
  const p = event.payloadRedacted;
  if (typeof p.claimNumber !== "string" || typeof p.customerId !== "string") return null;
  const amount = typeof p.calculatedRefundVnd === "string" ? BigInt(p.calculatedRefundVnd) : 0n;
  return {
    campaignId: `warranty-opened:${event.aggregateId}`,
    content: [
      "🚨 Yêu cầu bảo hành mới",
      "",
      `Mã: ${p.claimNumber}`,
      `Khách: ${String(p.customerId).slice(-4).padStart(8, "•")}`,
      typeof p.orderNumber === "string" ? `Đơn: ${p.orderNumber}` : null,
      // The owner reads the human symptom, not the internal code (goal §16).
      `Lỗi: ${ISSUE_TYPE_LABELS[p.issueType as keyof typeof ISSUE_TYPE_LABELS] ?? String(p.issueType ?? "")}`,
      `Đã dùng: ${String(p.usedDays ?? "?")} ngày`,
      `Còn bảo hành: ${String(p.remainingDays ?? "?")} ngày`,
      "",
      `💰 Hoàn dự kiến nếu lỗi hợp lệ: ${amount.toLocaleString("vi-VN")} ₫`,
      "Admin xác minh tài khoản đã giao trước khi quyết định.",
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  };
}

function warrantyCustomerNotice(
  event: OutboxEvent,
): { campaignId: string; customerId: string; content: string } | null {
  const p = event.payloadRedacted;
  const customerId = typeof p.customerId === "string" ? p.customerId : null;
  if (!customerId) return null;
  const amount =
    typeof p.amountVnd === "string" && /^[0-9]{1,19}$/.test(p.amountVnd)
      ? BigInt(p.amountVnd)
      : null;
  switch (event.eventType) {
    // Verifying is a resolution step the customer is waiting on: without this the claim goes quiet
    // between "we received it" and "here is your refund", which reads as being ignored.
    case "WarrantyClaimVerified":
      return {
        campaignId: `warranty-verified:${event.aggregateId}`,
        customerId,
        content: [
          "✅ Đã xác nhận bảo hành",
          "",
          "Shop đã kiểm tra và xác nhận sản phẩm của bạn thuộc phạm vi bảo hành.",
          "Shop sẽ liên hệ để đổi tài khoản hoặc hoàn tiền.",
        ].join("\n"),
      };
    // Stock arrived and the rest is owed. The deposit notice promised exactly this message, so
    // without it the customer's first word after paying is the forfeit notice.
    case "PreorderStockAllocated": {
      const owed =
        typeof p.balanceVnd === "number" && Number.isSafeInteger(p.balanceVnd)
          ? BigInt(p.balanceVnd)
          : typeof p.balanceVnd === "string" && /^[0-9]{1,19}$/.test(p.balanceVnd)
            ? BigInt(p.balanceVnd)
            : null;
      const hours =
        typeof p.balanceDueHours === "number" && Number.isSafeInteger(p.balanceDueHours)
          ? p.balanceDueHours
          : typeof p.holdHours === "number" && Number.isSafeInteger(p.holdHours)
            ? p.holdHours
            : null;
      return {
        campaignId: `preorder-allocated:${event.aggregateId}`,
        customerId,
        content: [
          "📦 Hàng đã về — Giữ suất cho bạn",
          "",
          owed ? `Còn phải thanh toán: ${owed.toLocaleString("vi-VN")} ₫` : null,
          hours ? `Bạn có ${hours} giờ để thanh toán phần còn lại.` : null,
          "Mở «📌 Đặt cọc của tôi» để lấy mã chuyển khoản.",
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      };
    }
    // The deposit landed: tell the customer, or their money disappears into silence until they
    // think to reopen the reservation screen.
    case "PreorderDepositPaid":
      return {
        campaignId: `preorder-deposit-paid:${event.aggregateId}`,
        customerId,
        content: [
          "✅ Đã nhận tiền cọc",
          "",
          "Shop đã ghi nhận tiền cọc của bạn và giữ suất trong hàng chờ.",
          "Shop sẽ thông báo ngay khi hàng về.",
        ].join("\n"),
      };
    // The hold expired and the deposit is kept. Silence here is the worst outcome: the customer
    // paid money and would only find out by opening the screen.
    case "PreorderHoldForfeited": {
      // Same shape as shopCancelNotification: a `::bigint` payload lands as a JSON number, so
      // checking only for a numeric string silently dropped the amount from the one message whose
      // job is to explain money that was kept.
      const deposit =
        typeof p.depositVnd === "number" && Number.isSafeInteger(p.depositVnd)
          ? BigInt(p.depositVnd)
          : typeof p.depositVnd === "string" && /^[0-9]{1,19}$/.test(p.depositVnd)
            ? BigInt(p.depositVnd)
            : null;
      return {
        campaignId: `preorder-forfeited:${event.aggregateId}`,
        customerId,
        content: [
          "⌛ Hết hạn giữ suất đặt cọc",
          "",
          "Shop đã giữ hàng đến hạn nhưng chưa nhận được phần thanh toán còn lại, nên suất giữ hàng được nhả cho khách khác.",
          deposit ? `Tiền cọc đã thanh toán: ${deposit.toLocaleString("vi-VN")} ₫` : null,
          "Nếu bạn vẫn muốn mua, hãy đặt cọc lại hoặc liên hệ Hỗ trợ.",
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      };
    }
    case "WarrantyRefundDue":
      return {
        campaignId: `warranty-refund-due:${event.aggregateId}`,
        customerId,
        content: [
          "✅ Yêu cầu bảo hành đã được duyệt",
          "",
          amount ? `Tiền hoàn: ${amount.toLocaleString("vi-VN")} ₫` : null,
          "Trạng thái: ⏳ Chờ shop chuyển tiền",
          "",
          "Admin sẽ thực hiện chuyển khoản sau khi xác minh thông tin nhận tiền.",
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      };
    case "WarrantyRefundPaid":
      return {
        campaignId: `warranty-refund-paid:${event.aggregateId}`,
        customerId,
        content: [
          "💸 Hoàn tiền đã được xử lý",
          "",
          amount ? `Số tiền: ${amount.toLocaleString("vi-VN")} ₫` : null,
          "Trạng thái: ✅ Shop đã xác nhận chuyển khoản",
          "",
          "Nếu sau thời gian ngân hàng xử lý bạn chưa nhận được tiền, hãy liên hệ Admin.",
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      };
    case "WarrantyClaimRejected":
      return {
        campaignId: `warranty-rejected:${event.aggregateId}`,
        customerId,
        content: [
          "❌ Yêu cầu chưa đủ điều kiện bảo hành",
          "",
          typeof p.reason === "string" && p.reason ? `Lý do: ${p.reason}` : null,
          "Nếu bạn cần trao đổi thêm, hãy liên hệ Admin.",
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      };
    case "WarrantyClaimNeedsInfo":
      return {
        campaignId: `warranty-needs-info:${event.aggregateId}`,
        customerId,
        content: [
          "🔎 Shop cần thêm thông tin cho yêu cầu bảo hành",
          "",
          typeof p.note === "string" && p.note ? p.note : null,
          "Vui lòng trả lời trong chat này để shop tiếp tục kiểm tra.",
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      };
    case "WarrantyReplacementApproved":
      return {
        campaignId: `warranty-replacement:${event.aggregateId}`,
        customerId,
        content: [
          "🔄 Yêu cầu đổi tài khoản đã được duyệt",
          "",
          "Shop đã gửi thông tin nhận hàng mới cho đơn của bạn.",
        ].join("\n"),
      };
    default:
      return null;
  }
}

type AdminAlert = {
  campaignId: string;
  content: string;
  buttons: NotificationButton[][];
};

const ADMIN_ALERT_BUTTONS: NotificationButton[][] = [
  [
    { text: "Xem đơn", callbackData: "admin:orders" },
    { text: "Thanh toán", callbackData: "admin:payments" },
  ],
  [{ text: "Khách hàng", callbackData: "admin:customers" }],
];

function safeAdminText(value: string | null | undefined, fallback: string): string {
  const cleaned = [...(value ?? "")]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? " " : character;
    })
    .join("")
    .trim();
  return cleaned ? cleaned.slice(0, 120) : fallback;
}

function eventPayloadString(event: OutboxEvent, key: string): string | null {
  const value = event.payloadRedacted[key];
  return typeof value === "string" && value.trim() ? value : null;
}

async function buildPaymentSettledAdminAlert(
  exec: Executor,
  orderId: string,
): Promise<AdminAlert | null> {
  const result = await sql<{
    order_id: string;
    order_number: string;
    customer_id: string;
    display_name: string | null;
    username: string | null;
    order_status: string;
    product_name: string;
    variant_name: string;
    amount_vnd: string;
    settled_at: Date | string | null;
    remaining_stock: number | null;
    delivered: boolean;
  }>`
    select
      o.id as order_id,
      o.order_number,
      o.customer_id,
      cps.display_name,
      cps.username,
      o.status as order_status,
      coalesce(nullif(o.product_name_vi, ''), p.name_vi) as product_name,
      coalesce(nullif(o.variant_name_vi, ''), v.name_vi) as variant_name,
      pa.allocated_amount_vnd::text as amount_vnd,
      coalesce(pi.settled_at, o.paid_at) as settled_at,
      case
        when v.fulfillment_type in ('STOCK_ACCOUNT','STOCK_CODE') then
          (select count(*)::int from digital_asset a where a.variant_id = v.id and a.status = 'AVAILABLE')
        when v.fulfillment_type = 'QUANTITY_STOCK' then
          coalesce((select q.available_quantity from variant_quantity_stock q where q.variant_id = v.id), 0)::int
        when v.fulfillment_type = 'DIGITAL_FILE' then
          (select count(*)::int from variant_file_artifact f where f.variant_id = v.id and f.is_active)
        else null
      end as remaining_stock,
      (
        exists (
          select 1 from delivery_bundle b
          join digital_asset a on a.id = b.asset_id
          where b.order_id = o.id and b.status = 'CONSUMED' and a.status = 'DELIVERED'
        )
        or exists (select 1 from file_delivery_job f where f.order_id = o.id and f.status = 'SENT')
        or exists (select 1 from manual_fulfillment_task m where m.order_id = o.id and m.status = 'COMPLETED')
      ) as delivered
    from "order" o
    join product_variant v on v.id = o.variant_id
    join product p on p.id = v.product_id
    join lateral (
      select pi.*
      from payment_intent pi
      where pi.order_id = o.id and pi.status = 'SUCCEEDED'
      order by pi.settled_at desc nulls last, pi.id desc
      limit 1
    ) pi on true
    join payment_allocation pa on pa.payment_intent_id = pi.id and pa.status = 'SETTLED'
    join bank_transaction bt on bt.id = pa.bank_transaction_id
      and lower(bt.provider) = 'sepay'
      and bt.direction = 'IN'
      and bt.signature_status = 'VERIFIED'
    left join customer_profile_snapshot cps on cps.customer_id = o.customer_id
    where o.id = ${orderId}
      and o.status in ('PAID','PROCESSING','COMPLETED')
      and not p.is_test and not p.is_archived
      and p.name_vi not ilike '%canary%'
      and not exists (
        select 1
        from test_customer_allowlist a
        join channel_identity ci
          on ci.channel = 'TELEGRAM'
         and ci.channel_user_id = a.telegram_user_id
         and ci.customer_id = o.customer_id
      )
    limit 1
  `.execute(exec);
  const row = result.rows[0];
  if (!row) return null;
  const customer = safeAdminText(row.display_name, "Khách không có tên");
  const username = row.username ? ` (@${safeAdminText(row.username, "").replace(/^@+/, "")})` : "";
  const stock =
    row.remaining_stock === null ? "không áp dụng" : `${Math.max(0, row.remaining_stock)} sản phẩm`;
  const fulfillment = row.delivered
    ? "✅ Đã giao"
    : row.order_status === "COMPLETED"
      ? "✅ Đã hoàn tất"
      : row.order_status === "PROCESSING"
        ? "⏳ Đang xử lý"
        : "⏳ Chờ giao";
  const settledAt = row.settled_at ? new Date(row.settled_at).toISOString() : "chưa ghi nhận";
  return {
    campaignId: `admin-payment-settled:${row.order_id}`,
    content: [
      "✅ KHÁCH VỪA THANH TOÁN",
      "",
      `Đơn: ${safeAdminText(row.order_number, "không rõ")}`,
      `Khách: ${customer}${username}`,
      `Mã khách an toàn: ${row.customer_id.slice(-8).padStart(8, "•")}`,
      `Sản phẩm: ${safeAdminText(row.product_name, "không rõ")}`,
      `Gói: ${safeAdminText(row.variant_name, "không rõ")}`,
      "Số lượng: 1",
      `Số tiền: ${BigInt(row.amount_vnd).toLocaleString("vi-VN")} ₫`,
      "Nguồn: SePay · ✅ Đã xác minh · ✅ Đã đối soát",
      `Thời điểm: ${settledAt}`,
      `Fulfillment: ${fulfillment}`,
      `Tồn còn lại: ${stock}`,
    ].join("\n"),
    buttons: ADMIN_ALERT_BUTTONS,
  };
}

function paymentReviewAdminAlert(event: OutboxEvent): AdminAlert | null {
  if (event.eventType !== "PaymentNeedsReview") return null;
  const orderId = eventPayloadString(event, "orderId");
  const reason = safeAdminText(
    eventPayloadString(event, "reason"),
    "Bằng chứng thanh toán chưa đủ",
  );
  return {
    campaignId: `admin-payment-review:${event.aggregateId}`,
    content: [
      "⚠️ THANH TOÁN CẦN SOÁT",
      "",
      orderId ? `Đơn: ${orderId.slice(-12).padStart(12, "•")}` : "Đơn: chưa xác định",
      `Lý do: ${reason}`,
      "Không tự giao hàng hoặc ghi nhận đã thanh toán.",
    ].join("\n"),
    buttons: ADMIN_ALERT_BUTTONS,
  };
}

async function queueRootAdminAlert(
  trx: Executor,
  alert: AdminAlert,
  rootTelegramUserId: number | undefined,
  mode: "IMMEDIATE" | "OFF" = "IMMEDIATE",
): Promise<boolean> {
  if (mode === "OFF") return true;
  if (rootTelegramUserId === undefined) return false;
  const root = await sql<{ customer_id: string; chat_id: string }>`
    select customer_id, channel_user_id as chat_id
    from channel_identity
    where channel = 'TELEGRAM' and channel_user_id = ${String(rootTelegramUserId)}
    limit 1
  `.execute(trx);
  const target = root.rows[0];
  if (!target) return false;
  await sql`
    insert into notification_campaign(id, class, content, status, created_by, idempotency_key, buttons)
    values (${alert.campaignId}, 'CRITICAL_SERVICE', ${alert.content}, 'QUEUED', 'system',
      ${alert.campaignId}, ${JSON.stringify(alert.buttons)}::jsonb)
    on conflict (idempotency_key) do nothing
  `.execute(trx);
  await sql`
    insert into notification_delivery(id, campaign_id, customer_id, chat_id)
    values (${newId()}, ${alert.campaignId}, ${target.customer_id}, ${target.chat_id})
    on conflict (campaign_id, customer_id) do nothing
  `.execute(trx);
  return true;
}

async function refreshRootAdminAlert(trx: Executor, alert: AdminAlert): Promise<void> {
  await sql`
    update notification_campaign
    set content = ${alert.content}, buttons = ${JSON.stringify(alert.buttons)}::jsonb,
        status = 'QUEUED'
    where id = ${alert.campaignId} and status <> 'CANCELLED'
  `.execute(trx);
  await sql`
    update notification_delivery
    set status = case when status in ('SENT','PENDING','RETRY') then 'RETRY' else status end,
        next_attempt_at = now(), last_error = null, claimed_by = null,
        claim_expires_at = null, claim_generation = claim_generation + 1
    where campaign_id = ${alert.campaignId} and status in ('SENT','PENDING','RETRY')
  `.execute(trx);
}

async function fulfillmentUpdateAlert(
  exec: Executor,
  event: OutboxEvent,
): Promise<AdminAlert | null> {
  if (
    !["DigitalAssetDelivered", "ManualFulfillmentTaskCompleted", "FulfillmentCompleted"].includes(
      event.eventType,
    )
  )
    return null;
  const orderId = eventPayloadString(event, "orderId");
  return orderId ? buildPaymentSettledAdminAlert(exec, orderId) : null;
}

export async function handleNotificationOutboxEvent(
  db: Db,
  event: OutboxEvent,
  options: {
    rootTelegramUserId?: number;
    adminAlertMode?: "IMMEDIATE" | "OFF";
  } = {},
): Promise<
  | { kind: "PUBLISHED" }
  | { kind: "RETRY"; errorCode: string }
  | { kind: "TERMINAL_REVIEW"; errorCode: string }
> {
  const stock = positiveRestockDelta(event);
  const lowStock = lowStockAlertDelta(event);
  const walletEvent =
    event.eventType === "WalletTopupPresented" ||
    event.eventType === "WalletTopupCredited" ||
    event.eventType === "WalletRefunded";
  const wallet = walletNotification(event);
  const shopCancel = shopCancelNotification(event);
  const warrantyAdmin = warrantyAdminAlert(event);
  const ticketAdmin = ticketOpenedAdminAlert(event);
  const warrantyCustomer = warrantyCustomerNotice(event);
  const paymentSettled =
    event.eventType === "PaymentSettled"
      ? await buildPaymentSettledAdminAlert(db, eventPayloadString(event, "orderId") ?? "")
      : null;
  const paymentReview = paymentReviewAdminAlert(event);
  const fulfillmentUpdate = await fulfillmentUpdateAlert(db, event);
  if (walletEvent && !wallet)
    return { kind: "TERMINAL_REVIEW", errorCode: "WALLET_NOTIFICATION_PAYLOAD_INVALID" };
  if (
    !stock &&
    !lowStock &&
    !wallet &&
    !shopCancel &&
    !warrantyAdmin &&
    !ticketAdmin &&
    !warrantyCustomer &&
    !paymentSettled &&
    !paymentReview &&
    !fulfillmentUpdate
  )
    return { kind: "PUBLISHED" };
  let missingWalletTarget = false;
  let missingWarrantyTarget = false;
  let missingLowStockTarget = false;
  let missingShopCancelTarget = false;
  let missingPaymentTarget = false;
  await withTransaction(db, async (trx) => {
    if (stock) {
      const snapshot = await restockCampaignSnapshot(trx, stock);
      if (!snapshot) return;
      const campaignId = `restock:${event.id}`;
      await sql`insert into notification_campaign(id,class,content,status,created_by,idempotency_key,product_variant_id) values (${campaignId},'SHOP_UPDATE',${snapshot.content},'QUEUED','system',${campaignId},${snapshot.variantId}) on conflict (idempotency_key) do nothing`.execute(
        trx,
      );
      await sql<{ n: number }>`insert into notification_delivery(id,campaign_id,customer_id,chat_id)
        select md5(${campaignId}||rs.customer_id),${campaignId},rs.customer_id,coalesce(cps.chat_id,ci.channel_user_id)
        from restock_subscription rs
        join customer c on c.id=rs.customer_id and c.status='ACTIVE'
        left join customer_profile_snapshot cps on cps.customer_id=rs.customer_id and cps.reachable
        left join channel_identity ci on ci.customer_id=rs.customer_id and ci.channel='TELEGRAM'
        where rs.variant_id=${stock.variantId} and rs.active
          and coalesce(cps.chat_id,ci.channel_user_id) is not null
        on conflict (campaign_id,customer_id) do nothing returning 1 as n`.execute(trx);
    }
    if (wallet && !(await queueCustomerCriticalNotification(trx, wallet)))
      missingWalletTarget = true;
    if (
      lowStock &&
      !(await queueRootLowStockAlert(trx, event, lowStock, options.rootTelegramUserId))
    )
      missingLowStockTarget = true;
    if (shopCancel && !(await queueCustomerCriticalNotification(trx, shopCancel)))
      missingShopCancelTarget = true;
    if (
      warrantyAdmin &&
      !(await queueRootCriticalNotification(trx, warrantyAdmin, options.rootTelegramUserId))
    )
      missingWarrantyTarget = true;
    if (
      ticketAdmin &&
      !(await queueRootCriticalNotification(trx, ticketAdmin, options.rootTelegramUserId))
    )
      missingWarrantyTarget = true;
    if (warrantyCustomer && !(await queueCustomerCriticalNotification(trx, warrantyCustomer)))
      missingWarrantyTarget = true;
    if (
      paymentSettled &&
      !(await queueRootAdminAlert(
        trx,
        paymentSettled,
        options.rootTelegramUserId,
        options.adminAlertMode,
      ))
    )
      missingPaymentTarget = true;
    if (
      paymentReview &&
      !(await queueRootAdminAlert(
        trx,
        paymentReview,
        options.rootTelegramUserId,
        options.adminAlertMode,
      ))
    )
      missingPaymentTarget = true;
    if (fulfillmentUpdate) await refreshRootAdminAlert(trx, fulfillmentUpdate);
  });
  if (missingWarrantyTarget)
    return { kind: "RETRY", errorCode: "CRITICAL_NOTIFICATION_TARGET_MISSING" };
  if (missingWalletTarget)
    return { kind: "RETRY", errorCode: "CRITICAL_NOTIFICATION_TARGET_MISSING" };
  if (missingLowStockTarget)
    return { kind: "RETRY", errorCode: "LOW_STOCK_ROOT_NOTIFICATION_TARGET_MISSING" };
  if (missingShopCancelTarget)
    return { kind: "RETRY", errorCode: "CRITICAL_NOTIFICATION_TARGET_MISSING" };
  if (missingPaymentTarget)
    return { kind: "RETRY", errorCode: "CRITICAL_NOTIFICATION_TARGET_MISSING" };
  return { kind: "PUBLISHED" };
}
