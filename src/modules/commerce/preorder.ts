import { sql } from "kysely";
import type { Db, Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import { newId } from "../../shared/ids/index.js";
import type { PresentedMessage } from "../../bot/presenters/catalog.js";

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
    "📌 ĐIỀU KIỆN ĐẶT CỌC GIỮ SUẤT",
    "",
    `Sản phẩm: ${config.productName} · ${config.variantName}`,
    `Giá niêm yết: ${config.priceVnd.toLocaleString("vi-VN")} ₫`,
    `Tiền đặt cọc: ${depositVnd.toLocaleString("vi-VN")} ₫`,
    `Còn lại khi có hàng: ${balanceVnd.toLocaleString("vi-VN")} ₫`,
    "",
    "📋 Quy định & quyền lợi đặt cọc:",
    "• Đơn cọc được xếp vào hàng chờ ưu tiên theo thứ tự thời gian thanh toán cọc.",
    `• Khi hàng về, hệ thống giữ hàng riêng cho bạn trong ${config.holdDurationHours} giờ.`,
    `• Bạn có ${config.balanceDueHours} giờ để thanh toán nốt phần còn lại (${balanceVnd.toLocaleString("vi-VN")} ₫).`,
    "• Nếu bạn không thanh toán phần còn lại đúng hạn, suất giữ hàng sẽ tự động chuyển cho khách hàng kế tiếp và tiền cọc không được hoàn lại.",
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
  },
): Promise<
  | {
      ok: true;
      reservationId: string;
      depositVnd: number;
      balanceVnd: number;
      config: PreorderVariantConfig;
    }
  | { ok: false; code: "NOT_FOUND" | "PREORDER_DISABLED" | "QUEUE_FULL" | "ALREADY_PREORDERED" }
> {
  const config = await loadPreorderVariantConfig(db, input.variantId);
  if (!config) return { ok: false, code: "NOT_FOUND" };
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

/**
 * Marks preorder deposit settled and triggers restock allocation check.
 */
export async function confirmPreorderDeposit(
  db: Db,
  input: {
    reservationId: string;
    paymentIntentId?: string;
  },
): Promise<{ ok: true; queuePosition: number; allocated: boolean } | { ok: false; code: string }> {
  return await withTransaction(db, async (trx) => {
    const res = await sql<PreorderRow>`
      select * from preorder_reservation
      where id = ${input.reservationId}
      for update
    `.execute(trx);

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
    `.execute(trx);

    // Compute queue position
    const queuePos = await sql<{ pos: number }>`
      select count(*)::int as pos
      from preorder_reservation
      where variant_id = ${row.variant_id}
        and status = 'DEPOSIT_PAID'
        and deposit_paid_at <= now()
    `.execute(trx);

    // Try immediate allocation if any asset is currently available
    const alloc = await allocateRestockToPreorders(trx, row.variant_id);

    return {
      ok: true,
      queuePosition: queuePos.rows[0]?.pos ?? 1,
      allocated: alloc.allocatedCount > 0,
    };
  });
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
  const preorders = await sql<{ id: string; customer_id: string }>`
    select id, customer_id
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

    // Enqueue outbox notification event for customer
    const eventId = newId();
    await sql`
      insert into outbox_event (
        id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted
      ) values (
        ${eventId}, 'PreorderReservation', ${preorder.id}, 1, 'PreorderStockAllocated',
        jsonb_build_object(
          'preorderId', ${preorder.id},
          'customerId', ${preorder.customer_id},
          'variantId', ${variantId},
          'holdHours', ${holdHours}
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
    }>`
      select id, variant_id, allocated_asset_id, customer_id
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

      // 2. Release held asset back to AVAILABLE
      if (row.allocated_asset_id) {
        await sql`
          update digital_asset
          set status = 'AVAILABLE',
              reserved_until = null,
              updated_at = now(),
              version = version + 1
          where id = ${row.allocated_asset_id}
        `.execute(trx);
      }

      // 3. Enqueue forfeiture notification
      const eventId = newId();
      await sql`
        insert into outbox_event (
          id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_redacted
        ) values (
          ${eventId}, 'PreorderReservation', ${row.id}, 1, 'PreorderHoldForfeited',
          jsonb_build_object(
            'preorderId', ${row.id},
            'customerId', ${row.customer_id},
            'variantId', ${row.variant_id}
          )
        )
      `.execute(trx);

      forfeited++;
      variantsToReallocate.add(row.variant_id);
    }

    // 4. Immediately allocate released units to the next waiters in the queue
    let reallocated = 0;
    for (const variantId of variantsToReallocate) {
      const res = await allocateRestockToPreorders(trx, variantId);
      reallocated += res.allocatedCount;
    }

    return { forfeitedCount: forfeited, reallocatedCount: reallocated };
  });
}
