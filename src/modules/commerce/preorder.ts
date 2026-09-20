import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { enqueueOutboxEvent } from "../../infrastructure/outbox/repository.js";
import { newId } from "../../shared/ids/index.js";
import type { PresentedMessage } from "../../bot/presenters/catalog.js";
import { insertOrder, transitionOrder } from "./repository.js";
import { voidLiveIntentsForPreorder } from "../payments/repository.js";
import type { OrderSnapshot } from "./order.js";
import { canPurchase } from "./store-mode.js";

export type PreorderStatus =
  | "CREATED"
  | "WAITING_DEPOSIT"
  | "DEPOSIT_PAID"
  | "ALLOCATED"
  | "BALANCE_DUE"
  | "FULLY_PAID"
  | "FULFILLED"
  | "DEPOSIT_EXPIRED"
  | "CANCELLED"
  | "SHOP_CANCELLED"
  | "HOLD_EXPIRED"
  | "DEPOSIT_FORFEITED"
  | "REFUND_DUE";

export interface PreorderRow {
  id: string;
  variant_id: string;
  customer_id: string;
  status: PreorderStatus;
  deposit_amount_vnd: string;
  balance_amount_vnd: string;
  total_price_vnd: string;
  deposit_payment_intent_id: string | null;
  balance_payment_intent_id: string | null;
  allocated_asset_id: string | null;
  order_id: string | null;
  deposit_paid_at: Date | string | null;
  allocated_at: Date | string | null;
  hold_until: Date | string | null;
  balance_due_until: Date | string | null;
  terms_version: number;
  accepted_terms_snapshot: string;
  forfeited_at: Date | string | null;
  refunded_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}

export interface PreorderVariantConfig {
  id: string;
  productId: string;
  productName: string;
  variantName: string;
  sku: string;
  priceVnd: number;
  preorderEnabled: boolean;
  isTest?: boolean;
  depositMode: "FIXED" | "PERCENT";
  depositAmountVnd: number;
  depositPercent: number;
  minDepositVnd: number;
  maxPreorderQueue: number;
  holdDurationHours: number;
  balanceDueHours: number;
  forfeitPolicyVersion: number;
}

export async function loadPreorderVariantConfig(
  exec: Executor,
  variantId: string,
): Promise<PreorderVariantConfig | null> {
  const result = await sql<{
    id: string;
    product_id: string;
    product_name: string;
    variant_name: string;
    sku: string;
    price_vnd: string;
    preorder_enabled: boolean;
    is_test: boolean;
    deposit_mode: "FIXED" | "PERCENT";
    deposit_amount_vnd: string;
    deposit_percent: number;
    min_deposit_vnd: string;
    max_preorder_queue: number;
    hold_duration_hours: number;
    balance_due_hours: number;
    forfeit_policy_version: number;
  }>`
    select
      v.id,
      v.product_id,
      p.name_vi as product_name,
      v.name_vi as variant_name,
      v.sku,
      v.price_vnd::text,
      coalesce(v.preorder_enabled, false) as preorder_enabled,
      coalesce(p.is_test, false) as is_test,
      coalesce(v.deposit_mode, 'FIXED') as deposit_mode,
      coalesce(v.deposit_amount_vnd, 0)::text as deposit_amount_vnd,
      coalesce(v.deposit_percent, 0) as deposit_percent,
      coalesce(v.min_deposit_vnd, 0)::text as min_deposit_vnd,
      coalesce(v.max_preorder_queue, 50) as max_preorder_queue,
      coalesce(v.hold_duration_hours, 24) as hold_duration_hours,
      coalesce(v.balance_due_hours, 24) as balance_due_hours,
      coalesce(v.forfeit_policy_version, 1) as forfeit_policy_version
    from product_variant v
    join product p on p.id = v.product_id
    where v.id = ${variantId}
      and v.is_active
      and p.is_active
  `.execute(exec);

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    variantName: row.variant_name,
    sku: row.sku,
    priceVnd: Number(row.price_vnd),
    preorderEnabled: row.preorder_enabled,
    isTest: row.is_test,
    depositMode: row.deposit_mode,
    depositAmountVnd: Number(row.deposit_amount_vnd),
    depositPercent: row.deposit_percent,
    minDepositVnd: Number(row.min_deposit_vnd),
    maxPreorderQueue: row.max_preorder_queue,
    holdDurationHours: row.hold_duration_hours,
    balanceDueHours: row.balance_due_hours,
    forfeitPolicyVersion: row.forfeit_policy_version,
  };
}

export function computePreorderDeposit(config: PreorderVariantConfig): {
  depositVnd: number;
  balanceVnd: number;
} {
  let deposit =
    config.depositMode === "PERCENT" && config.depositPercent > 0
      ? Math.round((config.priceVnd * config.depositPercent) / 100)
      : config.depositAmountVnd > 0
        ? config.depositAmountVnd
        : Math.round(config.priceVnd * 0.2); // Default 20% if not configured

  if (config.minDepositVnd > 0 && deposit < config.minDepositVnd) {
    deposit = config.minDepositVnd;
  }
  if (deposit > config.priceVnd) {
    deposit = config.priceVnd;
  }
  const balance = Math.max(0, config.priceVnd - deposit);
  return { depositVnd: deposit, balanceVnd: balance };
}

/**
 * Renders explicit deposit consent terms (FR requirement 17).
 */
export function presentPreorderConsent(config: PreorderVariantConfig): PresentedMessage {
  const { depositVnd, balanceVnd } = computePreorderDeposit(config);

  const lines = [
    "📌 Điều kiện đặt cọc giữ suất",
    "",
    `Sản phẩm: ${config.productName} · ${config.variantName}`,
    `Giá niêm yết: ${config.priceVnd.toLocaleString("vi-VN")} ₫`,
    `Tiền đặt cọc: ${depositVnd.toLocaleString("vi-VN")} ₫`,
    `Còn lại khi có hàng: ${balanceVnd.toLocaleString("vi-VN")} ₫`,
    "",
    "📋 Quy định & quyền lợi đặt cọc:",
    "• Đơn cọc được xếp vào hàng chờ ưu tiên theo thứ tự thời gian thanh toán cọc.",
    `• Khi hàng về, hệ thống giữ hàng riêng cho bạn trong ${config.holdDurationHours} giờ.`,
    ...(balanceVnd > 0
      ? [
          `• Bạn có ${config.balanceDueHours} giờ để thanh toán nốt phần còn lại (${balanceVnd.toLocaleString("vi-VN")} ₫).`,
          "• Nếu bạn không thanh toán phần còn lại đúng hạn, suất giữ hàng sẽ tự động chuyển cho khách hàng kế tiếp và tiền cọc không được hoàn lại.",
        ]
      : [
          "• Tiền đặt cọc đã bao gồm 100% giá trị sản phẩm, bạn không cần thanh toán thêm khi hàng về.",
        ]),
    "• Trường hợp Shop không thể nhập hàng hoặc huỷ đợt hàng, 100% tiền cọc sẽ được hoàn trả lại ví của bạn.",
    "",
    "Bạn có đồng ý với các điều kiện trên để tiếp tục đặt cọc?",
  ];

  return {
    text: lines.join("\n"),
    buttons: [
      [
        {
          text: `✅ Đồng ý & cọc ${depositVnd.toLocaleString("vi-VN")} ₫`,
          callbackData: `preorder:create:${config.id}`,
        },
      ],
      [{ text: "❌ Huỷ", callbackData: "shop:home" }],
    ],
  };
}

/**
 * Creates a pending preorder reservation record.
 */
export async function createPreorderReservation(
  db: Db,
  input: {
    customerId: string;
    variantId: string;
    telegramUserId?: string;
    isRootAdmin?: boolean;
  },
): Promise<
  | {
      ok: true;
      reservationId: string;
      depositVnd: number;
      balanceVnd: number;
      config: PreorderVariantConfig;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "PREORDER_DISABLED"
        | "STORE_CLOSED"
        | "STORE_TEST_ONLY"
        | "QUEUE_FULL"
        | "ALREADY_PREORDERED";
    }
> {
  const config = await loadPreorderVariantConfig(db, input.variantId);
  if (!config) return { ok: false, code: "NOT_FOUND" };
  const gate = await canPurchase(db, {
    telegramUserId: input.telegramUserId ?? "",
    isRootAdmin: input.isRootAdmin ?? false,
    variantIsTest: config.isTest ?? false,
  });
  if (!gate.ok) return { ok: false, code: gate.code as "STORE_CLOSED" | "STORE_TEST_ONLY" };
  if (!config.preorderEnabled) return { ok: false, code: "PREORDER_DISABLED" };

  return await withTransaction(db, async (trx) => {
    // Check queue limit
    const queueCheck = await sql<{ count: number }>`
      select count(*)::int as count
      from preorder_reservation
      where variant_id = ${input.variantId}
        and status in ('DEPOSIT_PAID', 'ALLOCATED', 'BALANCE_DUE')
    `.execute(trx);

    if ((queueCheck.rows[0]?.count ?? 0) >= config.maxPreorderQueue) {
      return { ok: false, code: "QUEUE_FULL" };
    }

    // Check duplicate active preorder
    const existing = await sql<{ id: string }>`
      select id from preorder_reservation
      where variant_id = ${input.variantId}
        and customer_id = ${input.customerId}
        and status in ('WAITING_DEPOSIT', 'DEPOSIT_PAID', 'ALLOCATED', 'BALANCE_DUE')
      limit 1
    `.execute(trx);

    if (existing.rows[0]) {
      return { ok: false, code: "ALREADY_PREORDERED" };
    }

    const { depositVnd, balanceVnd } = computePreorderDeposit(config);
    const reservationId = newId();
    const termsSnapshot = `v${config.forfeitPolicyVersion}:deposit=${depositVnd}:balance=${balanceVnd}:hold=${config.holdDurationHours}h`;

    await sql`
      insert into preorder_reservation (
        id, variant_id, customer_id, status,
        deposit_amount_vnd, balance_amount_vnd, total_price_vnd,
        terms_version, accepted_terms_snapshot
      ) values (
        ${reservationId}, ${input.variantId}, ${input.customerId}, 'WAITING_DEPOSIT',
        ${depositVnd}, ${balanceVnd}, ${config.priceVnd},
        ${config.forfeitPolicyVersion}, ${termsSnapshot}
      )
    `.execute(trx);

    return {
      ok: true,
      reservationId,
      depositVnd,
      balanceVnd,
      config,
    };
  });
}

export interface PreorderSettlementTarget {
  id: string;
  status: PreorderStatus;
  productName: string;
  variantName: string;
  depositVnd: number;
  balanceVnd: number;
  holdUntil: Date | null;
  balanceDueUntil: Date | null;
}

/**
 * Lock a reservation for a money settlement. Taking this lock BEFORE the payment
 * intent keeps settlement in the same lock order as shop-cancel and hold-expiry
 * (reservation → intent), so the two can never deadlock on each other.
 *
 * `ownerCustomerId` is mandatory for any caller whose reservation id came from a
 * customer: it puts the owner predicate INSIDE the locked read, so a foreign
 * reservation and a missing one are the same `null` (BOLA, no existence oracle).
 * The settlement worker, which resolves a reservation from matched payment
 * evidence rather than from customer input, omits it deliberately.
 */
export async function lockPreorderForSettlement(
  exec: Executor,
  reservationId: string,
  ownerCustomerId?: string,
): Promise<PreorderSettlementTarget | null> {
  const res = await sql<{
    id: string;
    status: PreorderStatus;
    product_name: string;
    variant_name: string;
    deposit_amount_vnd: string;
    balance_amount_vnd: string;
    hold_until: Date | string | null;
    balance_due_until: Date | string | null;
  }>`
    select pr.id, pr.status, p.name_vi as product_name, v.name_vi as variant_name,
           pr.deposit_amount_vnd::text, pr.balance_amount_vnd::text,
           pr.hold_until, pr.balance_due_until
    from preorder_reservation pr
    join product_variant v on v.id = pr.variant_id
    join product p on p.id = v.product_id
    where pr.id = ${reservationId}
      and (${ownerCustomerId ?? null}::text is null
           or pr.customer_id = ${ownerCustomerId ?? null})
    for update of pr
  `.execute(exec);
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    productName: row.product_name,
    variantName: row.variant_name,
    depositVnd: Number(row.deposit_amount_vnd),
    balanceVnd: Number(row.balance_amount_vnd),
    holdUntil: row.hold_until === null ? null : new Date(row.hold_until),
    balanceDueUntil: row.balance_due_until === null ? null : new Date(row.balance_due_until),
  };
}

/**
 * Which leg a reservation can still pay, or null when nothing is payable (already
 * paid, forfeited, cancelled, or waiting for stock with the deposit in).
 */
export function preorderPayableLeg(status: PreorderStatus): "DEPOSIT" | "BALANCE" | null {
  if (status === "WAITING_DEPOSIT") return "DEPOSIT";
  if (status === "ALLOCATED" || status === "BALANCE_DUE") return "BALANCE";
  return null;
}

/** Stamp the presented intent for one leg onto its reservation. */
export async function recordPreorderPaymentIntent(
  exec: Executor,
  input: { reservationId: string; leg: "DEPOSIT" | "BALANCE"; paymentIntentId: string },
): Promise<void> {
  await sql`
    update preorder_reservation
    set deposit_payment_intent_id = case when ${input.leg} = 'DEPOSIT'
          then ${input.paymentIntentId} else deposit_payment_intent_id end,
        balance_payment_intent_id = case when ${input.leg} = 'BALANCE'
          then ${input.paymentIntentId} else balance_payment_intent_id end,
        updated_at = now()
    where id = ${input.reservationId}
  `.execute(exec);
}

/**
 * Marks preorder deposit settled and triggers restock allocation check.
 */
export async function confirmPreorderDeposit(
  db: Db,
  input: {
    reservationId: string;
    paymentIntentId?: string;
  },
): Promise<ConfirmPreorderDepositResult> {
  return await withTransaction(db, (trx) => confirmPreorderDepositInTransaction(trx, input));
}

export type ConfirmPreorderDepositResult =
  { ok: true; queuePosition: number; allocated: boolean } | { ok: false; code: string };

/**
 * Settlement core. Exported so the SePay evidence transaction can confirm the
 * deposit inside the SAME unit of work as the intent settle and its outbox event
 * — the deposit can never be recorded without the money that paid for it.
 */
export async function confirmPreorderDepositInTransaction(
  exec: Executor,
  input: {
    reservationId: string;
    paymentIntentId?: string;
  },
): Promise<ConfirmPreorderDepositResult> {
  const res = await sql<PreorderRow>`
      select * from preorder_reservation
      where id = ${input.reservationId}
      for update
    `.execute(exec);

  const row = res.rows[0];
  if (!row) return { ok: false, code: "NOT_FOUND" };
  if (row.status !== "WAITING_DEPOSIT") {
    return { ok: false, code: "INVALID_STATUS" };
  }

  await sql`
      update preorder_reservation
      set status = 'DEPOSIT_PAID',
          deposit_paid_at = now(),
          deposit_payment_intent_id = ${input.paymentIntentId ?? row.deposit_payment_intent_id},
          updated_at = now(),
          version = version + 1
      where id = ${row.id}
    `.execute(exec);

  await sql`
      insert into outbox_event (
        id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted
      ) values (
        ${newId()}, 'PreorderReservation', ${row.id}, 1, 'PreorderDepositPaid',
        jsonb_build_object(
          'preorderId', ${row.id}::text,
          'customerId', ${row.customer_id}::text,
          'variantId', ${row.variant_id}::text,
          'depositVnd', ${row.deposit_amount_vnd}::bigint
        )
      )
    `.execute(exec);

  // Compute queue position
  const queuePos = await sql<{ pos: number }>`
      select count(*)::int as pos
      from preorder_reservation
      where variant_id = ${row.variant_id}
        and status = 'DEPOSIT_PAID'
        and deposit_paid_at <= now()
    `.execute(exec);

  // Try immediate allocation if any asset is currently available
  const alloc = await allocateRestockToPreorders(exec, row.variant_id);

  return {
    ok: true,
    queuePosition: queuePos.rows[0]?.pos ?? 1,
    allocated: alloc.allocatedCount > 0,
  };
}

/**
 * Completes a preorder whose money is fully collected: creates the Order for the
 * price the customer accepted at deposit time, binds the asset the allocator is
 * already holding (`reserved_order_id`), marks the reservation paid in full, and
 * emits OrderPaid so the standard fulfillment pipeline delivers the unit.
 *
 * Idempotent: a replay re-reads the reservation and returns the same order id.
 */
export async function finalizePreorderInTransaction(
  exec: Executor,
  input: { reservationId: string; paymentIntentId: string | null; correlationId: string },
): Promise<{ ok: true; orderId: string } | { ok: false; code: string }> {
  const res = await sql<PreorderRow>`
    select * from preorder_reservation where id = ${input.reservationId} for update
  `.execute(exec);
  const row = res.rows[0];
  if (!row) return { ok: false, code: "NOT_FOUND" };
  if ((row.status === "FULLY_PAID" || row.status === "FULFILLED") && row.order_id) {
    return { ok: true, orderId: row.order_id };
  }
  if (row.status !== "ALLOCATED" && row.status !== "BALANCE_DUE") {
    return { ok: false, code: "INVALID_STATUS" };
  }
  if (!row.allocated_asset_id) return { ok: false, code: "NO_ASSET" };

  const snapshot = await loadOrderSnapshot(exec, row.variant_id);
  if (!snapshot) return { ok: false, code: "VARIANT_NOT_FOUND" };

  const inserted = await insertOrder(exec, {
    customerId: row.customer_id,
    variantId: row.variant_id,
    // Deterministic key: a retry of the same settlement can never mint a second order.
    idempotencyKey: `preorder-balance:${row.id}`,
    snapshot: { ...snapshot, priceVnd: String(row.total_price_vnd) },
    status: "PENDING_PAYMENT",
    expiresAt: null,
    correlationId: input.correlationId,
    actorType: "SYSTEM",
    actorId: "preorder",
    creationReasonCode: "PREORDER_FULLY_PAID",
  });
  const order = inserted.order;

  if (inserted.inserted) {
    // The allocator already reserved this exact unit for the reservation; hand it
    // to the order so fulfillment reuses it (`findActiveAssetHoldByOrderForUpdate`)
    // instead of claiming a different unit. reserved_until is refreshed so the
    // stale-reservation sweep cannot reclaim a fully paid unit mid-fulfillment.
    await sql`
      update digital_asset
      set reserved_order_id = ${order.id},
          reserved_until = now() + interval '24 hours',
          updated_at = now(),
          version = version + 1
      where id = ${row.allocated_asset_id}
        and status = 'RESERVED'
        and reserved_order_id is null
    `.execute(exec);
  }

  const paid =
    order.status === "PAID"
      ? order
      : await transitionOrder(exec, order, "PAID", "PREORDER_FULLY_PAID", input.correlationId, {
          type: "SYSTEM",
          id: "preorder",
        });

  await sql`
    update preorder_reservation
    set status = 'FULLY_PAID',
        order_id = ${order.id},
        balance_payment_intent_id = coalesce(${input.paymentIntentId}, balance_payment_intent_id),
        updated_at = now(),
        version = version + 1
    where id = ${row.id}
  `.execute(exec);

  await enqueueOutboxEvent(exec, {
    id: newId(),
    aggregateType: "Order",
    aggregateId: order.id,
    aggregateVersion: paid.version,
    eventType: "OrderPaid",
    payloadRedacted: {
      orderId: order.id,
      preorderId: row.id,
      correlationId: input.correlationId,
    },
  });

  return { ok: true, orderId: order.id };
}

/** Load the immutable commercial snapshot an Order needs for a preorder variant. */
async function loadOrderSnapshot(exec: Executor, variantId: string): Promise<OrderSnapshot | null> {
  const result = await sql<{
    product_name_vi: string;
    variant_name_vi: string;
    price_vnd: string;
    duration_code: string;
    delivery_type: string;
    warranty_days: number;
    stock_policy: string | null;
    fulfillment_type: OrderSnapshot["fulfillmentType"];
  }>`
    select p.name_vi as product_name_vi, v.name_vi as variant_name_vi, v.price_vnd::text,
           v.duration_code, v.delivery_type, v.warranty_days, v.stock_policy, v.fulfillment_type
    from product_variant v
    join product p on p.id = v.product_id
    where v.id = ${variantId}
    limit 1
  `.execute(exec);
  const row = result.rows[0];
  if (!row) return null;
  return {
    productNameVi: row.product_name_vi,
    variantNameVi: row.variant_name_vi,
    priceVnd: row.price_vnd,
    durationCode: row.duration_code,
    deliveryType: row.delivery_type,
    warrantyDays: row.warranty_days,
    supplierPolicySnapshot: row.stock_policy,
    fulfillmentType: row.fulfillment_type,
  };
}

/**
 * FIFO Restock allocation: matches paid preorders to available inventory units.
 */
export async function allocateRestockToPreorders(
  exec: Executor,
  variantId: string,
): Promise<{ allocatedCount: number; remainingPreorders: number; remainingStock: number }> {
  // Lock variant to prevent concurrent allocation race
  await sql`select pg_advisory_xact_lock(hashtext(${variantId}))`.execute(exec);

  const config = await loadPreorderVariantConfig(exec, variantId);
  const holdHours = config?.holdDurationHours ?? 24;
  const balanceHours = config?.balanceDueHours ?? 24;

  // 1. Fetch eligible preorders in FIFO order
  const preorders = await sql<{
    id: string;
    customer_id: string;
    balance_amount_vnd: string;
  }>`
    select id, customer_id, balance_amount_vnd::text
    from preorder_reservation
    where variant_id = ${variantId}
      and status = 'DEPOSIT_PAID'
    order by deposit_paid_at asc, id asc
    for update
  `.execute(exec);

  if (preorders.rows.length === 0) {
    const stockCount = await sql<{ count: number }>`
      select count(*)::int as count from digital_asset
      where variant_id = ${variantId} and status = 'AVAILABLE'
    `.execute(exec);
    return {
      allocatedCount: 0,
      remainingPreorders: 0,
      remainingStock: stockCount.rows[0]?.count ?? 0,
    };
  }

  // 2. Fetch available digital assets
  const assets = await sql<{ id: string }>`
    select id
    from digital_asset
    where variant_id = ${variantId}
      and status = 'AVAILABLE'
    order by created_at asc, id asc
    limit ${preorders.rows.length}
    for update
  `.execute(exec);

  if (assets.rows.length === 0) {
    return { allocatedCount: 0, remainingPreorders: preorders.rows.length, remainingStock: 0 };
  }

  const matchCount = Math.min(preorders.rows.length, assets.rows.length);

  for (let i = 0; i < matchCount; i++) {
    const preorder = preorders.rows[i]!;
    const asset = assets.rows[i]!;

    // Mark asset reserved
    await sql`
      update digital_asset
      set status = 'RESERVED',
          reserved_until = now() + make_interval(hours => ${holdHours}),
          updated_at = now(),
          version = version + 1
      where id = ${asset.id}
    `.execute(exec);

    // Mark preorder allocated
    await sql`
      update preorder_reservation
      set status = 'ALLOCATED',
          allocated_asset_id = ${asset.id},
          allocated_at = now(),
          hold_until = now() + make_interval(hours => ${holdHours}),
          balance_due_until = now() + make_interval(hours => ${balanceHours}),
          updated_at = now(),
          version = version + 1
      where id = ${preorder.id}
    `.execute(exec);

    // A deposit that already covers the full price owes no balance leg, so the
    // purchase completes here: order + PAID + OrderPaid (fulfillment picks the
    // held asset up by `reserved_order_id`). Otherwise the customer is told the
    // asset is held and what is still owed.
    if (BigInt(preorder.balance_amount_vnd) === 0n) {
      await finalizePreorderInTransaction(exec, {
        reservationId: preorder.id,
        paymentIntentId: null,
        correlationId: `preorder:${preorder.id}:deposit-covers-full-price`,
      });
      continue;
    }

    // Enqueue outbox notification event for customer
    const eventId = newId();
    await sql`
      insert into outbox_event (
        id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted
      ) values (
        ${eventId}, 'PreorderReservation', ${preorder.id}, 1, 'PreorderStockAllocated',
        jsonb_build_object(
          'preorderId', ${preorder.id}::text,
          'customerId', ${preorder.customer_id}::text,
          'variantId', ${variantId}::text,
          'holdHours', ${holdHours}::int,
          'balanceVnd', ${preorder.balance_amount_vnd}::bigint,
          'balanceDueHours', ${balanceHours}::int
        )
      )
    `.execute(exec);
  }

  const remainingPreorders = preorders.rows.length - matchCount;
  const remainingStockQuery = await sql<{ count: number }>`
    select count(*)::int as count from digital_asset
    where variant_id = ${variantId} and status = 'AVAILABLE'
  `.execute(exec);

  return {
    allocatedCount: matchCount,
    remainingPreorders,
    remainingStock: remainingStockQuery.rows[0]?.count ?? 0,
  };
}

/**
 * Releases expired holds and forfeits deposit per accepted terms (FR 23).
 */
export async function releaseExpiredPreorderHolds(
  db: Db,
): Promise<{ forfeitedCount: number; reallocatedCount: number }> {
  return await withTransaction(db, async (trx) => {
    const expired = await sql<{
      id: string;
      variant_id: string;
      allocated_asset_id: string | null;
      customer_id: string;
      deposit_amount_vnd: string;
    }>`
      select id, variant_id, allocated_asset_id, customer_id, deposit_amount_vnd::text
      from preorder_reservation
      where status in ('ALLOCATED', 'BALANCE_DUE')
        and hold_until < now()
      for update
    `.execute(trx);

    if (expired.rows.length === 0) {
      return { forfeitedCount: 0, reallocatedCount: 0 };
    }

    let forfeited = 0;
    const variantsToReallocate = new Set<string>();

    for (const row of expired.rows) {
      // 1. Forfeit deposit
      await sql`
        update preorder_reservation
        set status = 'DEPOSIT_FORFEITED',
            forfeited_at = now(),
            updated_at = now(),
            version = version + 1
        where id = ${row.id}
      `.execute(trx);

      // 2. Close the balance payment request (if one was presented) so a transfer
      // that arrives after the deadline cannot settle a forfeited reservation —
      // it becomes an ops discrepancy instead.
      await voidLiveIntentsForPreorder(trx, row.id, "EXPIRED");

      // 3. Release held asset back to AVAILABLE
      if (row.allocated_asset_id) {
        await sql`
          update digital_asset
          set status = 'AVAILABLE',
              reserved_until = null,
              updated_at = now(),
              version = version + 1
          where id = ${row.allocated_asset_id}
            and status = 'RESERVED'
            and reserved_order_id is null
        `.execute(trx);
      }

      // 4. Enqueue forfeiture notification
      const eventId = newId();
      await sql`
        insert into outbox_event (
          id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted
        ) values (
          ${eventId}, 'PreorderReservation', ${row.id}, 1, 'PreorderHoldForfeited',
          jsonb_build_object(
            'preorderId', ${row.id}::text,
            'customerId', ${row.customer_id}::text,
            'variantId', ${row.variant_id}::text,
            'depositVnd', ${row.deposit_amount_vnd}::bigint
          )
        )
      `.execute(trx);

      forfeited++;
      variantsToReallocate.add(row.variant_id);
    }

    // 5. Immediately allocate released units to the next waiters in the queue
    let reallocated = 0;
    for (const variantId of variantsToReallocate) {
      const res = await allocateRestockToPreorders(trx, variantId);
      reallocated += res.allocatedCount;
    }

    return { forfeitedCount: forfeited, reallocatedCount: reallocated };
  });
}

export interface CustomerPreorderSummary {
  id: string;
  productName: string;
  variantName: string;
  status: PreorderStatus;
  depositVnd: number;
  balanceVnd: number;
  queuePosition: number | null;
  balanceDueUntil: Date | null;
  holdUntil: Date | null;
  orderId: string | null;
}

/**
 * The customer's own deposit holds. Hard-scoped by customer id so a screens view
 * can never surface another customer's reservation (BOLA).
 */
export async function listCustomerPreorders(
  exec: Executor,
  customerId: string,
  limit = 10,
): Promise<CustomerPreorderSummary[]> {
  const rows = await sql<{
    id: string;
    status: PreorderStatus;
    product_name: string;
    variant_name: string;
    deposit_amount_vnd: string;
    balance_amount_vnd: string;
    balance_due_until: Date | string | null;
    hold_until: Date | string | null;
    order_id: string | null;
    queue_position: number;
  }>`
    select pr.id, pr.status, p.name_vi as product_name, v.name_vi as variant_name,
           pr.deposit_amount_vnd::text, pr.balance_amount_vnd::text,
           pr.balance_due_until, pr.hold_until, pr.order_id,
           (select count(*)::int from preorder_reservation q
             where q.variant_id = pr.variant_id
               and q.status = 'DEPOSIT_PAID'
               and q.deposit_paid_at <= pr.deposit_paid_at) as queue_position
    from preorder_reservation pr
    join product_variant v on v.id = pr.variant_id
    join product p on p.id = v.product_id
    where pr.customer_id = ${customerId}
    order by pr.created_at desc, pr.id desc
    limit ${limit}
  `.execute(exec);

  return rows.rows.map((row) => ({
    id: row.id,
    productName: row.product_name,
    variantName: row.variant_name,
    status: row.status,
    depositVnd: Number(row.deposit_amount_vnd),
    balanceVnd: Number(row.balance_amount_vnd),
    queuePosition: row.queue_position,
    balanceDueUntil: row.balance_due_until === null ? null : new Date(row.balance_due_until),
    holdUntil: row.hold_until === null ? null : new Date(row.hold_until),
    orderId: row.order_id,
  }));
}
