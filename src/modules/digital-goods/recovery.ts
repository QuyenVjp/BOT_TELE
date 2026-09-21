import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import {
  ageSeconds,
  validateRecoveryBatchSize,
  type RecoveryTelemetry,
} from "../recovery-result.js";
import { releaseReservedAsset } from "./repository.js";
import { appendAuditEvent } from "../identity/audit.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import { nextVersion } from "../../infrastructure/db/version.js";
import { isId, newId } from "../../shared/ids/index.js";
import { findOrderByIdForUpdate, transitionOrder } from "../commerce/repository.js";

export type ReadyAssetRecoveryResult =
  { ok: true; assetId: string; newVersion: number } | { ok: false; code: "RECOVERY_NOT_SAFE" };

interface ReadyAssetProof {
  unsafe_order_status: boolean;
  paid_payment_intent: boolean;
  live_payment_intent: boolean;
  settled_allocation: boolean;
  open_discrepancy: boolean;
  delivery_evidence: boolean;
  delivery_handoff: boolean;
  refund_obligation: boolean;
  replacement_obligation: boolean;
  warranty_obligation: boolean;
  manual_fulfillment: boolean;
}

function hasUnsafeReadyAssetProof(proof: ReadyAssetProof): boolean {
  return Object.values(proof).some(Boolean);
}

export async function releaseReadyAssetInTransaction(
  exec: Executor,
  input: {
    assetId: string;
    expectedVersion: number;
    actorId: string;
    reason: string;
    correlationId: string;
    requestId: string;
  },
): Promise<ReadyAssetRecoveryResult> {
  if (
    !isId(input.assetId) ||
    input.expectedVersion < 1 ||
    !Number.isInteger(input.expectedVersion) ||
    !/^[1-9][0-9]{0,19}$/u.test(input.actorId) ||
    input.reason.trim().length === 0 ||
    input.reason.length > 500 ||
    input.correlationId.length === 0 ||
    input.correlationId.length > 128 ||
    input.requestId.length === 0 ||
    input.requestId.length > 128
  ) {
    return { ok: false, code: "RECOVERY_NOT_SAFE" };
  }
  const initial = await sql<{ reserved_order_id: string | null }>`
    select reserved_order_id from digital_asset where id = ${input.assetId}
  `.execute(exec);
  const orderId = initial.rows[0]?.reserved_order_id;
  if (!orderId) return { ok: false, code: "RECOVERY_NOT_SAFE" };
  const order = await sql<{ id: string }>`
    select id from "order" where id = ${orderId} for update
  `.execute(exec);
  if (!order.rows[0]) return { ok: false, code: "RECOVERY_NOT_SAFE" };
  const asset = await sql<{
    id: string;
    version: number;
    status: string;
    reserved_order_id: string | null;
    delivered_order_id: string | null;
  }>`
    select id, version, status, reserved_order_id, delivered_order_id
    from digital_asset where id = ${input.assetId} for update
  `.execute(exec);
  const row = asset.rows[0];
  if (
    !row ||
    row.version !== input.expectedVersion ||
    row.status !== "READY" ||
    row.reserved_order_id !== orderId ||
    row.delivered_order_id !== null
  ) {
    return { ok: false, code: "RECOVERY_NOT_SAFE" };
  }
  const proof = await sql<ReadyAssetProof>`
    select
      (o.status not in ('DRAFT','PENDING_PAYMENT','CANCELLED','EXPIRED','REJECTED')) as unsafe_order_status,
      exists (
        select 1 from payment_intent
        where order_id = o.id and status in ('SUCCEEDED','NEEDS_REVIEW')
      ) as paid_payment_intent,
      exists (
        select 1 from payment_intent
        where order_id = o.id and status in ('CREATED','PRESENTED')
      ) as live_payment_intent,
      exists (
        select 1 from payment_allocation a
        join payment_intent i on i.id = a.payment_intent_id
        where i.order_id = o.id and a.status = 'SETTLED'
      ) as settled_allocation,
      exists (select 1 from discrepancy where order_id = o.id and status = 'OPEN') as open_discrepancy,
      exists (
        select 1 from delivery_bundle
        where order_id = o.id and status in ('CREATED','AVAILABLE','VIEWED','CONSUMED')
      ) as delivery_evidence,
      exists (
        select 1
        from delivery_notification_handoff h
        join delivery_bundle b on b.id = h.bundle_id
        where b.order_id = o.id
      ) as delivery_handoff,
      (
        exists (
          select 1 from shop_refund_obligation r
          where r.order_id = o.id and r.status = 'OPEN'
        )
        or exists (
          select 1 from warranty_claim c
          left join shop_refund_obligation r on r.id = c.refund_obligation_id
          where c.order_id = o.id
            and (
              c.status not in ('REJECTED','RESOLVED','CANCELLED','REFUND_PAID')
              or r.status = 'OPEN'
            )
        )
      ) as refund_obligation,
      exists (
        select 1 from replacement_case
        where order_id = o.id and status not in ('REJECTED','CLOSED')
      ) as replacement_obligation,
      exists (
        select 1 from warranty_claim
        where order_id = o.id and status not in ('REJECTED','RESOLVED','CANCELLED','REFUND_PAID')
      ) as warranty_obligation,
      exists (
        select 1 from manual_fulfillment_task
        where order_id = o.id and status = 'OPEN'
      ) as manual_fulfillment
    from "order" o where o.id = ${orderId}
  `.execute(exec);
  if (!proof.rows[0] || hasUnsafeReadyAssetProof(proof.rows[0])) {
    return { ok: false, code: "RECOVERY_NOT_SAFE" };
  }
  const newVersion = nextVersion(input.expectedVersion);
  const updated = await sql<{ version: number }>`
    update digital_asset
    set status = 'AVAILABLE', reserved_order_id = null, reserved_until = null,
        version = ${newVersion}, updated_at = now()
    where id = ${input.assetId} and status = 'READY' and version = ${input.expectedVersion}
      and reserved_order_id = ${orderId} and delivered_order_id is null
    returning version
  `.execute(exec);
  if (!updated.rows[0]) return { ok: false, code: "RECOVERY_NOT_SAFE" };
  await appendAuditEvent(exec, {
    actorType: "ROOT_ADMIN",
    actorId: input.actorId,
    action: "digital_asset.ready_released",
    targetType: "DigitalAsset",
    targetId: input.assetId,
    reason: input.reason,
    correlationId: input.correlationId,
    metadataRedacted: {
      requestId: input.requestId,
      orderId,
      previousStatus: "READY",
      status: "AVAILABLE",
      previousVersion: input.expectedVersion,
      version: newVersion,
    },
  });
  return { ok: true, assetId: input.assetId, newVersion };
}

export async function reconcilePaidDeliveryInTransaction(
  exec: Executor,
  input: {
    orderId: string;
    expectedOrderVersion: number;
    actorId: string;
    reason: string;
    correlationId: string;
    requestId: string;
  },
): Promise<
  | {
      ok: true;
      orderId: string;
      status: "FULFILLMENT_NEEDS_REVIEW";
      previousStatus: "PROCESSING";
      alreadyApplied: boolean;
    }
  | { ok: false; code: "NOT_FOUND" | "STALE" | "RECONCILIATION_NOT_SAFE"; message?: string }
> {
  if (
    !isId(input.orderId) ||
    !Number.isInteger(input.expectedOrderVersion) ||
    input.expectedOrderVersion < 1 ||
    !/^[1-9][0-9]{0,19}$/u.test(input.actorId) ||
    input.reason.trim().length === 0 ||
    input.reason.length > 500 ||
    input.correlationId.length === 0 ||
    input.correlationId.length > 128 ||
    input.requestId.length === 0 ||
    input.requestId.length > 128
  ) {
    return { ok: false, code: "RECONCILIATION_NOT_SAFE" };
  }
  const order = await findOrderByIdForUpdate(exec, input.orderId);
  if (!order) return { ok: false, code: "NOT_FOUND" };

  const prior = await sql<{ id: string }>`
    select id from audit_event
    where action = 'fulfillment.reconcile'
      and target_type = 'Order'
      and target_id = ${input.orderId}
      and metadata_redacted->>'requestId' = ${input.requestId}
    limit 1
  `.execute(exec);
  const latestTransition = await sql<{
    from_status: string;
    to_status: string;
    reason_code: string;
  }>`
    select from_status, to_status, reason_code
    from order_transition
    where order_id = ${input.orderId}
    order by occurred_at desc, id desc
    limit 1
  `.execute(exec);
  const last = latestTransition.rows[0];
  if (
    prior.rows[0] &&
    order.status === "FULFILLMENT_NEEDS_REVIEW" &&
    last?.from_status === "PROCESSING" &&
    last.to_status === "FULFILLMENT_NEEDS_REVIEW" &&
    last.reason_code === "PAID_FULFILLMENT_RECONCILIATION_REVIEW"
  ) {
    return {
      ok: true,
      orderId: order.id,
      status: "FULFILLMENT_NEEDS_REVIEW",
      previousStatus: "PROCESSING",
      alreadyApplied: true,
    };
  }
  if (order.version !== input.expectedOrderVersion) {
    return { ok: false, code: "STALE", message: "Đơn hàng đã thay đổi." };
  }
  if (order.status !== "PROCESSING") {
    return { ok: false, code: "RECONCILIATION_NOT_SAFE" };
  }

  const latestPayment = await sql<{ id: string }>`
    select id from payment_intent
    where order_id = ${input.orderId}
    order by created_at desc, id desc
    limit 1 for update
  `.execute(exec);
  const latestIntentId = latestPayment.rows[0]?.id;
  if (latestIntentId) {
    await sql`select id from payment_allocation where payment_intent_id = ${latestIntentId} for update`.execute(
      exec,
    );
  }
  const latestBundle = await sql<{ id: string; asset_id: string }>`
    select id, asset_id from delivery_bundle
    where order_id = ${input.orderId}
    order by created_at desc, id desc
    limit 1 for update
  `.execute(exec);
  const bundle = latestBundle.rows[0];
  if (bundle) {
    await sql`select id from digital_asset where id = ${bundle.asset_id} for update`.execute(exec);
    await sql`select id from delivery_notification_handoff where bundle_id = ${bundle.id} for update`.execute(
      exec,
    );
  }

  const evidence = await sql<{
    payment_intent_id: string | null;
    payment_status: string | null;
    settled_allocation: boolean;
    asset_id: string | null;
    asset_status: string | null;
    asset_reserved_order_id: string | null;
    asset_delivered_order_id: string | null;
    bundle_id: string | null;
    bundle_status: string | null;
    handoff_id: string | null;
    handoff_status: string | null;
    handoff_sent_at: Date | string | null;
    consumed_bundle: boolean;
    delivered_asset: boolean;
    delivered_event: boolean;
    manual_fulfillment: boolean;
  }>`
    select
      pi.id as payment_intent_id,
      pi.status as payment_status,
      exists (
        select 1 from payment_allocation pa
        join payment_intent settled_pi on settled_pi.id = pa.payment_intent_id
        where settled_pi.id = pi.id
          and settled_pi.order_id = o.id
          and settled_pi.status = 'SUCCEEDED'
          and pa.status = 'SETTLED'
      ) as settled_allocation,
      a.id as asset_id,
      a.status as asset_status,
      a.reserved_order_id as asset_reserved_order_id,
      a.delivered_order_id as asset_delivered_order_id,
      b.id as bundle_id,
      b.status as bundle_status,
      h.id as handoff_id,
      h.status as handoff_status,
      h.sent_at as handoff_sent_at,
      exists (
        select 1 from delivery_bundle consumed
        where consumed.order_id = o.id and consumed.status = 'CONSUMED'
      ) as consumed_bundle,
      exists (
        select 1 from digital_asset delivered
        where delivered.delivered_order_id = o.id and delivered.status = 'DELIVERED'
      ) as delivered_asset,
      exists (
        select 1 from outbox_event delivered_event
        where delivered_event.event_type = 'DigitalAssetDelivered'
          and delivered_event.payload_redacted->>'orderId' = o.id
      ) as delivered_event,
      exists (
        select 1 from manual_fulfillment_task mft
        where mft.order_id = o.id and mft.status = 'OPEN'
      ) as manual_fulfillment
    from "order" o
    left join lateral (
      select id, status from payment_intent
      where order_id = o.id
      order by created_at desc, id desc
      limit 1
    ) pi on true
    left join lateral (
      select id, asset_id, status from delivery_bundle
      where order_id = o.id
      order by created_at desc, id desc
      limit 1
    ) b on true
    left join lateral (
      select id, status, reserved_order_id, delivered_order_id
      from digital_asset where id = b.asset_id limit 1
    ) a on true
    left join lateral (
      select id, status, sent_at
      from delivery_notification_handoff
      where bundle_id = b.id
      order by created_at desc, id desc
      limit 1
    ) h on true
    where o.id = ${input.orderId}
    limit 1
  `.execute(exec);
  const row = evidence.rows[0];
  const exactTuple =
    row !== undefined &&
    row.payment_intent_id !== null &&
    row.payment_status === "SUCCEEDED" &&
    row.settled_allocation &&
    row.asset_id !== null &&
    row.asset_status === "READY" &&
    row.asset_reserved_order_id === input.orderId &&
    row.asset_delivered_order_id === null &&
    row.bundle_id !== null &&
    row.bundle_status === "EXPIRED" &&
    row.handoff_id !== null &&
    row.handoff_status === "SENT" &&
    row.handoff_sent_at !== null &&
    !row.consumed_bundle &&
    !row.delivered_asset &&
    !row.delivered_event &&
    !row.manual_fulfillment;
  if (!exactTuple) return { ok: false, code: "RECONCILIATION_NOT_SAFE" };

  const transitioned = await transitionOrder(
    exec,
    order,
    "FULFILLMENT_NEEDS_REVIEW",
    "PAID_FULFILLMENT_RECONCILIATION_REVIEW",
    input.correlationId,
    { type: "ROOT_ADMIN", id: input.actorId },
  );
  await appendAuditEvent(exec, {
    actorType: "ROOT_ADMIN",
    actorId: input.actorId,
    action: "fulfillment.reconcile",
    targetType: "Order",
    targetId: input.orderId,
    reason: input.reason,
    correlationId: input.correlationId,
    metadataRedacted: {
      requestId: input.requestId,
      decision: "PARK_REVIEW",
      previousStatus: order.status,
      status: transitioned.status,
      orderVersion: transitioned.version,
      paymentStatus: row.payment_status,
      allocationStatus: "SETTLED",
      assetStatus: row.asset_status,
      bundleStatus: row.bundle_status,
      handoffStatus: row.handoff_status,
    },
  });
  return {
    ok: true,
    orderId: transitioned.id,
    status: "FULFILLMENT_NEEDS_REVIEW",
    previousStatus: "PROCESSING",
    alreadyApplied: false,
  };
}

type ProviderProof = {
  chatId: string;
  messageId: string;
  succeededAt: string;
};

function readProviderProof(value: unknown): ProviderProof | null {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  const chatId = row.providerChatId;
  const messageId = row.providerMessageId;
  const succeededAt = row.providerSucceededAt;
  return typeof chatId === "string" &&
    chatId.length > 0 &&
    chatId.length <= 128 &&
    typeof messageId === "string" &&
    messageId.length > 0 &&
    messageId.length <= 128 &&
    typeof succeededAt === "string" &&
    succeededAt.length > 0 &&
    succeededAt.length <= 64
    ? { chatId, messageId, succeededAt }
    : null;
}

type DeliveredReconciliationInput = {
  orderId: string;
  expectedOrderVersion?: number;
  actorId: string;
  actorType: "ROOT_ADMIN" | "SYSTEM";
  reason: string;
  correlationId: string;
  requestId: string;
  handoffId?: string;
  claimOwner?: string;
  claimGeneration?: number;
};

export type DeliveredReconciliationResult =
  | {
      ok: true;
      orderId: string;
      status: "COMPLETED";
      previousStatus: "PROCESSING" | "FULFILLMENT_NEEDS_REVIEW";
      alreadyApplied: boolean;
    }
  | { ok: false; code: "NOT_FOUND" | "STALE" | "RECONCILIATION_NOT_SAFE"; message?: string };

export async function reconcilePaidDeliveryDeliveredInTransaction(
  exec: Executor,
  input: DeliveredReconciliationInput,
): Promise<DeliveredReconciliationResult> {
  const hasClaimOwner = input.claimOwner !== undefined;
  const hasClaimGeneration = input.claimGeneration !== undefined;
  if (input.actorType !== "ROOT_ADMIN" && input.actorType !== "SYSTEM") {
    return { ok: false, code: "RECONCILIATION_NOT_SAFE" };
  }
  if (hasClaimOwner !== hasClaimGeneration) {
    return { ok: false, code: "RECONCILIATION_NOT_SAFE" };
  }
  if (
    input.actorType === "SYSTEM" &&
    (!input.handoffId ||
      !hasClaimOwner ||
      !hasClaimGeneration ||
      input.claimOwner!.length === 0 ||
      !Number.isInteger(input.claimGeneration))
  ) {
    return { ok: false, code: "RECONCILIATION_NOT_SAFE" };
  }
  if (
    !isId(input.orderId) ||
    (input.expectedOrderVersion !== undefined &&
      (!Number.isInteger(input.expectedOrderVersion) || input.expectedOrderVersion < 1)) ||
    input.actorId.length === 0 ||
    input.actorId.length > 128 ||
    input.reason.trim().length === 0 ||
    input.reason.length > 500 ||
    input.correlationId.length === 0 ||
    input.correlationId.length > 128 ||
    input.requestId.length === 0 ||
    input.requestId.length > 128
  ) {
    return { ok: false, code: "RECONCILIATION_NOT_SAFE" };
  }
  const order = await findOrderByIdForUpdate(exec, input.orderId);
  if (!order) return { ok: false, code: "NOT_FOUND" };
  const prior = await sql<{ id: string }>`
    select id
    from audit_event
    where action = 'fulfillment.reconcile'
      and target_type = 'Order'
      and target_id = ${input.orderId}
      and metadata_redacted->>'requestId' = ${input.requestId}
      and metadata_redacted->>'decision' = 'RECONCILE_DELIVERED'
    limit 1
  `.execute(exec);
  if (prior.rows[0] && order.status === "COMPLETED") {
    return {
      ok: true,
      orderId: order.id,
      status: "COMPLETED",
      previousStatus: "FULFILLMENT_NEEDS_REVIEW",
      alreadyApplied: true,
    };
  }
  if (input.expectedOrderVersion !== undefined && order.version !== input.expectedOrderVersion) {
    return { ok: false, code: "STALE", message: "Đơn hàng đã thay đổi." };
  }
  const expectedOrderStatus =
    input.actorType === "ROOT_ADMIN" ? "FULFILLMENT_NEEDS_REVIEW" : "PROCESSING";
  if (order.status !== expectedOrderStatus) {
    return { ok: false, code: "RECONCILIATION_NOT_SAFE" };
  }

  const evidence = await sql<{
    customer_id: string;
    payment_intent_id: string | null;
    payment_status: string | null;
    payment_amount_vnd: string | null;
    settled_allocation: boolean;
    allocation_amount_vnd: string | null;
    reversed_payment: boolean;
    refund_obligation: boolean;
    open_discrepancy: boolean;
    asset_id: string | null;
    asset_status: string | null;
    asset_reserved_order_id: string | null;
    asset_delivered_order_id: string | null;
    bundle_id: string | null;
    bundle_status: string | null;
    bundle_order_id: string | null;
    bundle_customer_id: string | null;
    bundle_asset_id: string | null;
    bundle_version: number | null;
    handoff_id: string | null;
    handoff_customer_id: string | null;
    handoff_chat_id: string | null;
    handoff_status: string | null;
    handoff_sent_at: Date | string | null;
    handoff_claimed_by: string | null;
    handoff_claim_generation: number | null;
    handoff_claim_active: boolean;
    handoff_payload: unknown;
    telegram_identity_matches: boolean;
    consumed_bundle: boolean;
    delivered_asset: boolean;
    delivered_event: boolean;
    manual_fulfillment: boolean;
  }>`
    select
      o.customer_id,
      pi.id as payment_intent_id,
      pi.status as payment_status,
      pi.amount_vnd::text as payment_amount_vnd,
      exists (
        select 1
        from payment_allocation pa
        where pa.payment_intent_id = pi.id
          and pa.status = 'SETTLED'
      ) as settled_allocation,
      (
        select pa.allocated_amount_vnd::text
        from payment_allocation pa
        where pa.payment_intent_id = pi.id and pa.status = 'SETTLED'
        order by pa.decided_at desc, pa.id desc
        limit 1
      ) as allocation_amount_vnd,
      exists (
        select 1
        from payment_allocation pa
        join payment_intent reversed_pi on reversed_pi.id = pa.payment_intent_id
        where reversed_pi.order_id = o.id
          and (
            pa.status = 'REVERSED'
            or reversed_pi.status in ('PARTIALLY_REFUNDED','REFUNDED')
          )
      ) as reversed_payment,
      exists (
        select 1
        from shop_refund_obligation r
        where r.order_id = o.id and r.status = 'OPEN'
      ) as refund_obligation,
      exists (
        select 1 from discrepancy d where d.order_id = o.id and d.status = 'OPEN'
      ) as open_discrepancy,
      a.id as asset_id,
      a.status as asset_status,
      a.reserved_order_id as asset_reserved_order_id,
      a.delivered_order_id as asset_delivered_order_id,
      b.id as bundle_id,
      b.status as bundle_status,
      b.order_id as bundle_order_id,
      b.customer_id as bundle_customer_id,
      b.asset_id as bundle_asset_id,
      b.version as bundle_version,
      h.id as handoff_id,
      h.customer_id as handoff_customer_id,
      h.telegram_chat_id as handoff_chat_id,
      h.status as handoff_status,
      h.sent_at as handoff_sent_at,
      h.claimed_by as handoff_claimed_by,
      h.claim_generation::int as handoff_claim_generation,
      h.claim_expires_at > now() as handoff_claim_active,
      h.payload_redacted as handoff_payload,
      exists (
        select 1
        from channel_identity ci
        where ci.customer_id = o.customer_id
          and ci.channel = 'TELEGRAM'
          and ci.channel_user_id = h.telegram_chat_id
      ) as telegram_identity_matches,
      exists (
        select 1 from delivery_bundle other
        where other.order_id = o.id and other.status = 'CONSUMED'
      ) as consumed_bundle,
      exists (
        select 1 from digital_asset other
        where other.delivered_order_id = o.id and other.status = 'DELIVERED'
      ) as delivered_asset,
      exists (
        select 1 from outbox_event e
        where e.event_type = 'DigitalAssetDelivered'
          and e.payload_redacted->>'orderId' = o.id
      ) as delivered_event,
      exists (
        select 1 from manual_fulfillment_task mft
        where mft.order_id = o.id and mft.status = 'OPEN'
      ) as manual_fulfillment
    from "order" o
    left join lateral (
      select id, status, amount_vnd
      from payment_intent
      where order_id = o.id
      order by created_at desc, id desc
      limit 1
      for update
    ) pi on true
    left join lateral (
      select id, order_id, customer_id, asset_id, status, version
      from delivery_bundle
      where order_id = o.id
      order by created_at desc, id desc
      limit 1
      for update
    ) b on true
    left join lateral (
      select id, status, reserved_order_id, delivered_order_id
      from digital_asset
      where id = b.asset_id
      limit 1
      for update
    ) a on true
    left join lateral (
      select id, customer_id, telegram_chat_id, status, sent_at,
        claimed_by, claim_generation, claim_expires_at, payload_redacted
      from delivery_notification_handoff
      where bundle_id = b.id
      order by created_at desc, id desc
      limit 1
      for update
    ) h on true
    where o.id = ${input.orderId}
    limit 1
  `.execute(exec);
  const row = evidence.rows[0];
  const provider = row ? readProviderProof(row.handoff_payload) : null;
  const bundleStatusAllowed =
    input.actorType === "ROOT_ADMIN"
      ? row?.bundle_status === "EXPIRED"
      : ["CREATED", "AVAILABLE", "VIEWED", "EXPIRED"].includes(row?.bundle_status ?? "");
  const handoffStatusAllowed =
    row?.handoff_status === (input.actorType === "ROOT_ADMIN" ? "SENT" : "PROCESSING");
  const exact =
    row !== undefined &&
    row.payment_intent_id !== null &&
    row.payment_status === "SUCCEEDED" &&
    row.payment_amount_vnd === order.priceVnd &&
    row.settled_allocation &&
    row.allocation_amount_vnd === order.priceVnd &&
    !row.reversed_payment &&
    !row.refund_obligation &&
    !row.open_discrepancy &&
    row.asset_id !== null &&
    row.asset_status === "READY" &&
    row.asset_reserved_order_id === input.orderId &&
    row.asset_delivered_order_id === null &&
    row.bundle_id !== null &&
    row.bundle_order_id === input.orderId &&
    row.bundle_customer_id === row.customer_id &&
    row.bundle_asset_id === row.asset_id &&
    row.bundle_version !== null &&
    bundleStatusAllowed &&
    row.handoff_id !== null &&
    (!input.handoffId || row.handoff_id === input.handoffId) &&
    row.handoff_customer_id === row.customer_id &&
    row.handoff_chat_id !== null &&
    row.telegram_identity_matches &&
    handoffStatusAllowed &&
    (input.actorType === "SYSTEM"
      ? row.handoff_claimed_by === input.claimOwner &&
        row.handoff_claim_generation === input.claimGeneration &&
        row.handoff_claim_active
      : row.handoff_sent_at !== null) &&
    provider !== null &&
    provider.chatId === row.handoff_chat_id &&
    !row.consumed_bundle &&
    !row.delivered_asset &&
    !row.delivered_event &&
    !row.manual_fulfillment;
  if (!exact || !row || !provider) return { ok: false, code: "RECONCILIATION_NOT_SAFE" };
  const bundleId = row.bundle_id;
  const bundleVersion = row.bundle_version;
  const assetId = row.asset_id;
  const handoffId = row.handoff_id;
  if (bundleId === null || bundleVersion === null || assetId === null || handoffId === null) {
    return { ok: false, code: "RECONCILIATION_NOT_SAFE" };
  }
  if (
    input.claimOwner !== undefined &&
    input.claimGeneration !== undefined &&
    (input.handoffId !== row.handoff_id ||
      input.claimOwner.length === 0 ||
      !Number.isInteger(input.claimGeneration))
  ) {
    return { ok: false, code: "RECONCILIATION_NOT_SAFE" };
  }
  const bundleUpdate = await sql`
    update delivery_bundle
    set status = 'CONSUMED', consumed_at = coalesce(consumed_at, now()), version = version + 1
    where id = ${bundleId}
      and status in ('CREATED','AVAILABLE','VIEWED','EXPIRED')
      and version = ${bundleVersion}
    returning id
  `.execute(exec);
  if (!bundleUpdate.rows[0]) {
    throw new Error("DELIVERY_RECONCILIATION_BUNDLE_CONFLICT");
  }
  await sql`
    update delivery_session
    set used_at = coalesce(used_at, now())
    where bundle_id = ${bundleId}
      and customer_id = ${row.customer_id}
      and used_at is null
      and revoked_at is null
  `.execute(exec);
  const assetUpdate = await sql`
    update digital_asset
    set status = 'DELIVERED',
        delivered_order_id = ${input.orderId},
        version = version + 1,
        updated_at = now()
    where id = ${assetId}
      and status = 'READY'
      and reserved_order_id = ${input.orderId}
      and delivered_order_id is null
  `.execute(exec);
  if (Number(assetUpdate.numAffectedRows ?? 0) !== 1) {
    throw new Error("DELIVERY_RECONCILIATION_ASSET_CONFLICT");
  }
  if (input.actorType === "SYSTEM") {
    const claimUpdate = await sql`
      update delivery_notification_handoff
      set status = 'SENT', sent_at = coalesce(sent_at, now()),
          claimed_by = null, claim_expires_at = null
      where id = ${handoffId}
        and status = 'PROCESSING'
        and claimed_by = ${input.claimOwner}
        and claim_generation = ${input.claimGeneration}
      returning id
    `.execute(exec);
    if (!claimUpdate.rows[0]) {
      throw new Error("DELIVERY_RECONCILIATION_CLAIM_CONFLICT");
    }
  } else {
    await sql`
      update delivery_notification_handoff
      set claimed_by = null, claim_expires_at = null
      where id = ${handoffId} and status = 'SENT'
    `.execute(exec);
  }
  await enqueueOutboxEvent(exec, {
    id: newId(),
    aggregateType: "DeliveryBundle",
    aggregateId: bundleId,
    aggregateVersion: bundleVersion + 1,
    eventType: "DigitalAssetDelivered",
    payloadRedacted: {
      bundleId,
      orderId: input.orderId,
      customerId: row.customer_id,
      assetId,
      correlationId: input.correlationId,
    },
  });
  const transitioned = await transitionOrder(
    exec,
    order,
    "COMPLETED",
    "PAID_FULFILLMENT_DELIVERY_RECONCILED",
    input.correlationId,
    { type: input.actorType, id: input.actorId },
  );
  await appendAuditEvent(exec, {
    actorType: input.actorType,
    actorId: input.actorId,
    action: "fulfillment.reconcile",
    targetType: "Order",
    targetId: input.orderId,
    reason: input.reason,
    correlationId: input.correlationId,
    metadataRedacted: {
      requestId: input.requestId,
      decision: "RECONCILE_DELIVERED",
      previousStatus: order.status,
      status: transitioned.status,
      orderVersion: transitioned.version,
      paymentStatus: row.payment_status,
      allocationStatus: "SETTLED",
      assetStatus: "DELIVERED",
      bundleStatus: "CONSUMED",
      handoffStatus: "SENT",
      providerMessageId: provider.messageId,
      providerChatId: provider.chatId,
    },
  });
  return {
    ok: true,
    orderId: transitioned.id,
    status: "COMPLETED",
    previousStatus: order.status,
    alreadyApplied: false,
  };
}

export async function parkPaidDeliveryUncertainInTransaction(
  exec: Executor,
  input: {
    handoffId: string;
    owner?: string;
    generation?: number;
    actorId: string;
    reason: string;
    correlationId: string;
    requestId: string;
  },
): Promise<{ ok: true; alreadyApplied: boolean } | { ok: false; code: "NOT_SAFE" }> {
  if (
    input.owner === undefined ||
    input.generation === undefined ||
    input.owner.length === 0 ||
    !Number.isInteger(input.generation)
  ) {
    return { ok: false, code: "NOT_SAFE" };
  }
  if (
    !isId(input.handoffId) ||
    input.actorId.length === 0 ||
    input.actorId.length > 128 ||
    input.reason.trim().length === 0 ||
    input.reason.length > 500 ||
    input.correlationId.length === 0 ||
    input.correlationId.length > 128 ||
    input.requestId.length === 0 ||
    input.requestId.length > 128
  ) {
    return { ok: false, code: "NOT_SAFE" };
  }
  const prior = await sql<{ id: string }>`
    select id from audit_event
    where action = 'fulfillment.delivery_uncertain'
      and target_type = 'Order'
      and metadata_redacted->>'requestId' = ${input.requestId}
    limit 1
  `.execute(exec);
  const handoff = await sql<{
    order_id: string;
    customer_id: string;
    bundle_id: string;
    status: string;
    claimed_by: string | null;
    claim_generation: number;
    payload_redacted: unknown;
  }>`
    select b.order_id, b.customer_id, h.bundle_id, h.status, h.claimed_by,
      h.claim_generation::int as claim_generation, h.payload_redacted
    from delivery_notification_handoff h
    join delivery_bundle b on b.id = h.bundle_id
    where h.id = ${input.handoffId}
    for update of h, b
  `.execute(exec);
  const row = handoff.rows[0];
  if (!row) return { ok: false, code: "NOT_SAFE" };
  if (prior.rows[0]) return { ok: true, alreadyApplied: true };
  if (
    row.status !== "PROCESSING" ||
    (input.owner !== undefined && row.claimed_by !== input.owner) ||
    (input.generation !== undefined && row.claim_generation !== input.generation)
  ) {
    return { ok: false, code: "NOT_SAFE" };
  }
  const provider = readProviderProof(row.payload_redacted);
  const order = await findOrderByIdForUpdate(exec, row.order_id);
  if (!order || !["PROCESSING", "FULFILLMENT_NEEDS_REVIEW"].includes(order.status)) {
    return { ok: false, code: "NOT_SAFE" };
  }
  let nextOrder = order;
  if (order.status === "PROCESSING") {
    nextOrder = await transitionOrder(
      exec,
      order,
      "FULFILLMENT_NEEDS_REVIEW",
      "PAID_FULFILLMENT_DELIVERY_UNCERTAIN",
      input.correlationId,
      { type: "SYSTEM", id: input.actorId },
    );
  }
  await sql`
    update delivery_notification_handoff
    set status = case when ${provider !== null} then 'SENT' else 'DEAD' end,
        sent_at = case when ${provider !== null} then coalesce(sent_at, now()) else sent_at end,
        next_attempt_at = now(),
        last_error_code = case
          when ${provider !== null} then 'DELIVERY_RECONCILIATION_REVIEW'
          else 'DELIVERY_UNCERTAIN'
        end,
        claimed_by = null,
        claim_expires_at = null
    where id = ${input.handoffId} and status = 'PROCESSING'
  `.execute(exec);
  await appendAuditEvent(exec, {
    actorType: "SYSTEM",
    actorId: input.actorId,
    action: "fulfillment.delivery_uncertain",
    targetType: "Order",
    targetId: row.order_id,
    reason: input.reason,
    correlationId: input.correlationId,
    metadataRedacted: {
      requestId: input.requestId,
      handoffId: input.handoffId,
      bundleId: row.bundle_id,
      customerId: row.customer_id,
      orderStatus: nextOrder.status,
      providerMessageIdPresent: provider !== null,
      disposition: provider ? "PROVIDER_SUCCESS_REVIEW" : "KEEP_UNRESOLVED",
    },
  });
  return { ok: true, alreadyApplied: false };
}

export async function keepPaidDeliveryUncertainInTransaction(
  exec: Executor,
  input: {
    orderId: string;
    expectedOrderVersion: number;
    actorId: string;
    reason: string;
    correlationId: string;
    requestId: string;
  },
): Promise<
  | { ok: true; orderId: string; status: "FULFILLMENT_NEEDS_REVIEW"; alreadyApplied: boolean }
  | { ok: false; code: "NOT_FOUND" | "STALE" | "NOT_SAFE"; message?: string }
> {
  if (
    !isId(input.orderId) ||
    !Number.isInteger(input.expectedOrderVersion) ||
    input.expectedOrderVersion < 1 ||
    !/^[1-9][0-9]{0,19}$/u.test(input.actorId) ||
    input.reason.trim().length === 0 ||
    input.reason.length > 500 ||
    input.correlationId.length === 0 ||
    input.correlationId.length > 128 ||
    input.requestId.length === 0 ||
    input.requestId.length > 128
  ) {
    return { ok: false, code: "NOT_SAFE" };
  }
  const order = await findOrderByIdForUpdate(exec, input.orderId);
  if (!order) return { ok: false, code: "NOT_FOUND" };
  const prior = await sql<{ id: string }>`
    select id
    from audit_event
    where action = 'fulfillment.reconcile'
      and target_type = 'Order'
      and target_id = ${input.orderId}
      and metadata_redacted->>'requestId' = ${input.requestId}
      and metadata_redacted->>'decision' = 'KEEP_UNCERTAIN'
    limit 1
  `.execute(exec);
  if (prior.rows[0] && order.status === "FULFILLMENT_NEEDS_REVIEW") {
    return {
      ok: true,
      orderId: order.id,
      status: "FULFILLMENT_NEEDS_REVIEW",
      alreadyApplied: true,
    };
  }
  if (order.version !== input.expectedOrderVersion) {
    return { ok: false, code: "STALE", message: "Đơn hàng đã thay đổi." };
  }
  if (order.status !== "FULFILLMENT_NEEDS_REVIEW") {
    return { ok: false, code: "NOT_SAFE" };
  }
  const evidence = await sql<{
    payment_status: string | null;
    allocation_settled: boolean;
    asset_status: string | null;
    bundle_status: string | null;
    handoff_status: string | null;
    handoff_sent_at: Date | string | null;
    provider_message_id: string | null;
    provider_success_at: string | null;
  }>`
    select
      pi.status as payment_status,
      exists (
        select 1
        from payment_allocation pa
        where pa.payment_intent_id = pi.id and pa.status = 'SETTLED'
      ) as allocation_settled,
      a.status as asset_status,
      b.status as bundle_status,
      h.status as handoff_status,
      h.sent_at as handoff_sent_at,
      h.payload_redacted->>'providerMessageId' as provider_message_id,
      h.payload_redacted->>'providerSucceededAt' as provider_success_at
    from "order" o
    left join lateral (
      select id, status
      from payment_intent
      where order_id = o.id
      order by created_at desc, id desc
      limit 1
    ) pi on true
    left join lateral (
      select asset_id, status
      from delivery_bundle
      where order_id = o.id
      order by created_at desc, id desc
      limit 1
    ) b on true
    left join digital_asset a on a.id = b.asset_id
    left join lateral (
      select status, sent_at, payload_redacted
      from delivery_notification_handoff
      where bundle_id = (
        select id
        from delivery_bundle
        where order_id = o.id
        order by created_at desc, id desc
        limit 1
      )
      order by created_at desc, id desc
      limit 1
    ) h on true
    where o.id = ${input.orderId}
    limit 1
  `.execute(exec);
  const row = evidence.rows[0];
  if (!row) return { ok: false, code: "NOT_SAFE" };
  await appendAuditEvent(exec, {
    actorType: "ROOT_ADMIN",
    actorId: input.actorId,
    action: "fulfillment.reconcile",
    targetType: "Order",
    targetId: input.orderId,
    reason: input.reason,
    correlationId: input.correlationId,
    metadataRedacted: {
      requestId: input.requestId,
      decision: "KEEP_UNCERTAIN",
      orderVersion: order.version,
      paymentStatus: row.payment_status,
      allocationStatus: row.allocation_settled ? "SETTLED" : "UNKNOWN",
      assetStatus: row.asset_status,
      bundleStatus: row.bundle_status,
      handoffStatus: row.handoff_status,
      handoffSentAt: row.handoff_sent_at ? new Date(row.handoff_sent_at).toISOString() : null,
      providerMessageIdPresent: row.provider_message_id !== null,
      providerSuccessAt: row.provider_success_at,
      disposition: "DELIVERY_UNCERTAIN",
    },
  });
  return {
    ok: true,
    orderId: order.id,
    status: "FULFILLMENT_NEEDS_REVIEW",
    alreadyApplied: false,
  };
}

export async function recoverStaleReservationsBatch(
  db: Db,
  options: { batchSize: number; now?: Date },
): Promise<RecoveryTelemetry> {
  validateRecoveryBatchSize(options.batchSize);
  const now = options.now ?? new Date();
  const excluded: string[] = [];
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;

  for (let index = 0; index < options.batchSize; index += 1) {
    let selectedId: string | null = null;
    try {
      const processed = await withTransaction(db, async (trx) => {
        const excludedFilter =
          excluded.length === 0
            ? sql``
            : sql`and id not in (${sql.join(excluded.map((id) => sql`${id}`))})`;
        const candidate = await sql<{ id: string; version: number }>`
          select id, version from digital_asset
          where status = 'RESERVED'
            and reserved_until is not null
            and reserved_until < ${now.toISOString()}
            ${excludedFilter}
          order by reserved_until asc, id asc
          limit 1
          for update skip locked
        `.execute(trx);
        const selected = candidate.rows[0];
        selectedId = selected?.id ?? null;
        if (!selected) return false;
        return releaseReservedAsset(trx, selected.id, selected.version);
      });
      if (selectedId === null) break;
      claimed += 1;
      excluded.push(selectedId);
      if (processed) succeeded += 1;
    } catch {
      if (selectedId === null)
        throw new Error("reservation recovery failed before selecting a row");
      claimed += 1;
      failed += 1;
      excluded.push(selectedId);
    }
  }

  const remaining = await sql<{ backlog: number; oldest: Date | string | null }>`
    select count(*)::int as backlog, min(reserved_until) as oldest
    from digital_asset
    where status = 'RESERVED'
      and reserved_until is not null
      and reserved_until < ${now.toISOString()}
  `.execute(db);
  const row = remaining.rows[0];
  return {
    claimed,
    succeeded,
    failed,
    backlog: row?.backlog ?? 0,
    oldestAgeSeconds: ageSeconds(now, row?.oldest),
  };
}

export async function recoverExpiredDeliveryBundlesBatch(
  db: Db,
  options: { batchSize: number; now?: Date },
): Promise<RecoveryTelemetry> {
  validateRecoveryBatchSize(options.batchSize);
  const now = options.now ?? new Date();
  const excluded: string[] = [];
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;

  for (let index = 0; index < options.batchSize; index += 1) {
    let selectedId: string | null = null;
    try {
      const processed = await withTransaction(db, async (trx) => {
        const excludedFilter =
          excluded.length === 0
            ? sql``
            : sql`and id not in (${sql.join(excluded.map((id) => sql`${id}`))})`;
        const candidate = await sql<{ id: string }>`
          select id from delivery_bundle
          where status in ('CREATED','AVAILABLE','VIEWED')
            and expires_at < ${now.toISOString()}
            ${excludedFilter}
          order by expires_at asc, id asc
          limit 1
          for update skip locked
        `.execute(trx);
        selectedId = candidate.rows[0]?.id ?? null;
        if (selectedId === null) return false;
        const updated = await sql`
          update delivery_bundle
          set status = 'EXPIRED', version = version + 1
          where id = ${selectedId}
            and status in ('CREATED','AVAILABLE','VIEWED')
            and expires_at < ${now.toISOString()}
        `.execute(trx);
        return Number(updated.numAffectedRows ?? 0) === 1;
      });
      if (selectedId === null) break;
      claimed += 1;
      excluded.push(selectedId);
      if (processed) succeeded += 1;
    } catch {
      if (selectedId === null) throw new Error("bundle recovery failed before selecting a row");
      claimed += 1;
      failed += 1;
      excluded.push(selectedId);
    }
  }

  const remaining = await sql<{ backlog: number; oldest: Date | string | null }>`
    select count(*)::int as backlog, min(expires_at) as oldest
    from delivery_bundle
    where status in ('CREATED','AVAILABLE','VIEWED')
      and expires_at < ${now.toISOString()}
  `.execute(db);
  const row = remaining.rows[0];
  return {
    claimed,
    succeeded,
    failed,
    backlog: row?.backlog ?? 0,
    oldestAgeSeconds: ageSeconds(now, row?.oldest),
  };
}
