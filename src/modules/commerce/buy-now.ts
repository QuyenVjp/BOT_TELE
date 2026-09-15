import { sql } from "kysely";
import type { Executor } from "../../infrastructure/db/transaction.js";
import { withTransaction } from "../../infrastructure/db/transaction.js";
import type { Db } from "../../infrastructure/db/transaction.js";
import {
  findOrderByIdempotency,
  findOrderByIdForOwnerForUpdate,
  findOrderByIdForUpdate,
  insertOrder,
  transitionOrder,
  findExpirableOrders,
} from "./repository.js";
import { isCancellableByCustomer, type Order, type OrderSnapshot } from "./order.js";
import { voidLiveIntentsForOrder } from "../payments/repository.js";
import {
  releaseTypedStockForOrder,
  reserveTypedStockForOrder,
} from "../digital-goods/repository.js";
import type { TypedStockKind } from "../digital-goods/repository.js";
import { isSupportedCatalogRoute } from "../catalog/domain.js";
import { canPurchase } from "./store-mode.js";

/**
 * BuyNow command (FR-006, FR-007, FR-008, FR-010).
 *
 * Flow:
 *  1. Resolve idempotency — return the existing order on a double-tap.
 *  2. Revalidate the variant (active/price/stock/resale) against the live catalog.
 *  3. Reject with a stable code when revalidation fails (no silent create).
 *  4. Capture an IMMUTABLE snapshot and insert the Order in PENDING_PAYMENT,
 *     recording the transition + correlation id in the same transaction.
 *
 * This command never settles payment and never starts fulfillment.
 */

export type BuyNowErrorCode =
  | "VARIANT_UNAVAILABLE"
  | "PRICE_CHANGED"
  | "NO_STOCK"
  | "CONTENTION_TIMEOUT"
  | "RESERVATION_LOST"
  | "POLICY_BLOCKED"
  | "IDEMPOTENCY_CONFLICT"
  | "ALREADY_PAID"
  | "ORDER_NOT_CANCELLABLE"
  | "STORE_CLOSED"
  | "STORE_TEST_ONLY"
  | "NOT_FOUND";

/**
 * Codes for which the customer lost/at-a-final-unit and should see the
 * last-unit loser presenter rather than a plain error line. Each keeps its own
 * honest copy (see BUY_NOW_MESSAGES) so we never tell a buyer of an already
 * empty SKU that "someone just reserved the last one".
 */
export type StockOutcomeCode = "NO_STOCK" | "CONTENTION_TIMEOUT" | "RESERVATION_LOST";

export const STOCK_LOSER_CODES: ReadonlySet<StockOutcomeCode> = new Set([
  "NO_STOCK",
  "CONTENTION_TIMEOUT",
  "RESERVATION_LOST",
]);

export function isStockOutcomeCode(code: BuyNowErrorCode): code is StockOutcomeCode {
  return STOCK_LOSER_CODES.has(code as StockOutcomeCode);
}

export type BuyNowResult =
  { ok: true; order: Order } | { ok: false; code: BuyNowErrorCode; message: string };

export interface BuyNowInput {
  customerId: string;
  variantId: string;
  /** Price the customer saw (stale-price guard). */
  expectedPriceVnd: number;
  idempotencyKey: string;
  correlationId: string;
  /** Payment intent TTL in seconds (default 900). */
  ttlSeconds?: number;
  telegramUserId?: string;
  isRootAdmin?: boolean;
  /** Admin explicit test bypass. */
  skipStoreStatusCheck?: boolean;
}

interface LiveVariant {
  id: string;
  product_id: string;
  product_name_vi: string;
  name_vi: string;
  price_vnd: string;
  duration_code: string;
  delivery_type: string;
  warranty_days: number;
  stock_policy: string;
  resale_evidence_id: string | null;
  fulfillment_type: TypedStockKind;
  is_test: boolean;
  is_active: boolean;
  product_active: boolean;
  category_active: boolean;
}

/**
 * Load the variant + its product/category sellability flags.
 *
 * `lockRows` takes `FOR SHARE OF v, p, c` so concurrent buyers remain
 * compatible while still serializing against admin edits to the ENTIRE
 * sellability aggregate — variant (price, stock_policy, is_active) AND its
 * product AND its category `is_active`. This closes the full TOCTOU: an admin
 * who deactivates the Product or Category (not just the variant) after the read
 * but before the Order commits is now blocked until Buy Now finishes, and the
 * revalidation inside the same transaction sees the committed change.
 *
 * `FOR SHARE OF` names the aliases whose rows are read-locked. Other buyers may
 * take the same shared locks, while a concurrent admin UPDATE/deactivate waits
 * for checkout to commit. Every buyer uses the same variant -> product ->
 * category join order.
 */
async function loadLiveVariant(
  exec: Executor,
  variantId: string,
  lockRows = false,
): Promise<LiveVariant | null> {
  // One projection for both lock modes so product/category sellability flags
  // cannot drift out of the SELECT (undefined is falsy → VARIANT_UNAVAILABLE).
  const result = await sql<LiveVariant>`
    select
      v.id, v.product_id, p.name_vi as product_name_vi, v.name_vi,
      v.price_vnd, v.duration_code, v.delivery_type, v.warranty_days,
      v.stock_policy, v.fulfillment_type, v.resale_evidence_id, p.is_test,
      v.is_active,
      p.is_active as product_active,
      c.is_active as category_active
    from product_variant v
    join product p on p.id = v.product_id
    join category c on c.id = p.category_id
    where v.id = ${variantId}
    ${lockRows ? sql`for share of v, p, c` : sql``}
  `.execute(exec);
  return result.rows[0] ?? null;
}

function revalidate(live: LiveVariant, expectedPriceVnd: number): BuyNowErrorCode | null {
  if (!live.is_active || !live.product_active || !live.category_active) {
    return "VARIANT_UNAVAILABLE";
  }
  if (live.stock_policy === "PAUSED") return "NO_STOCK";
  if (
    !isSupportedCatalogRoute({
      stockPolicy: live.stock_policy,
      fulfillmentType: live.fulfillment_type,
    })
  ) {
    return "POLICY_BLOCKED";
  }
  if (!live.is_test && !live.resale_evidence_id) return "POLICY_BLOCKED";
  if (Number(live.price_vnd) !== expectedPriceVnd) return "PRICE_CHANGED";
  if (Number(live.price_vnd) <= 0) return "VARIANT_UNAVAILABLE";
  return null;
}

function toSnapshot(live: LiveVariant): OrderSnapshot {
  return {
    productNameVi: live.product_name_vi,
    variantNameVi: live.name_vi,
    priceVnd: String(live.price_vnd),
    durationCode: live.duration_code,
    deliveryType: live.delivery_type,
    warrantyDays: live.warranty_days,
    supplierPolicySnapshot: live.stock_policy,
    fulfillmentType: live.fulfillment_type,
  };
}

const BUY_NOW_MESSAGES: Record<BuyNowErrorCode, string> = {
  VARIANT_UNAVAILABLE: "Sản phẩm không còn bán.",
  PRICE_CHANGED: "Giá đã thay đổi. Vui lòng xem lại.",
  NO_STOCK: "Sản phẩm hiện đã hết hàng. Bạn chưa bị trừ tiền và chưa có phiên thanh toán.",
  CONTENTION_TIMEOUT:
    "Đang có nhiều người đặt sản phẩm này. Vui lòng thử lại sau vài giây. Bạn chưa bị trừ tiền và chưa có phiên thanh toán.",
  RESERVATION_LOST:
    "Sản phẩm cuối vừa được khách khác đặt trước. Bạn chưa bị trừ tiền và chưa có phiên thanh toán.",
  POLICY_BLOCKED: "Sản phẩm chưa được phép bán.",
  IDEMPOTENCY_CONFLICT: "Yêu cầu mua hàng không hợp lệ. Vui lòng mở lại sản phẩm.",
  ALREADY_PAID: "Đơn hàng đã được thanh toán.",
  ORDER_NOT_CANCELLABLE: "Đơn hàng không thể hủy.",
  STORE_CLOSED: "Cửa hàng hiện đang tạm đóng cửa. Vui lòng quay lại sau.",
  STORE_TEST_ONLY: "Cửa hàng đang ở chế độ thử nghiệm.",
  NOT_FOUND: "Không tìm thấy.",
};

/** Bounded, fail-closed TTL window for a Buy Now (seconds). */
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;
const DEFAULT_TTL_SECONDS = 900;
const CONTENTION_MAX_ATTEMPTS = 5;

function waitOutsideTransaction(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function buyNow(db: Db, input: BuyNowInput): Promise<BuyNowResult> {
  // 1. Idempotency short-circuit (FR-010) — cheap pre-transaction read.
  const existing = await findOrderByIdempotency(db, input.customerId, input.idempotencyKey);
  if (existing) {
    return matchesBuyNowFingerprint(existing, input)
      ? { ok: true, order: existing }
      : {
          ok: false,
          code: "IDEMPOTENCY_CONFLICT",
          message: BUY_NOW_MESSAGES.IDEMPOTENCY_CONFLICT,
        };
  }

  // Fail-closed TTL: a negative or unbounded TTL would either mint an already-
  // expired order or hold stock forever. Clamp silently to the safe window.
  const suppliedTtl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const rawTtl = Number.isFinite(suppliedTtl) ? suppliedTtl : DEFAULT_TTL_SECONDS;
  const ttlSeconds = Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.trunc(rawTtl)));
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  // 2. EVERYTHING that must be consistent runs in ONE transaction (FR-006,
  // FR-006a, FR-007): lock+re-read the sellability aggregate (variant + product
  // + category), revalidate against the LIVE locked rows, insert the Order, and
  // reserve one concrete asset for local stock. The first transaction to commit
  // wins a contested final unit; a reservation miss or a failed revalidation
  // rolls the Order insert back so no chargeable order or QR survives.
  type TxOutcome =
    | { kind: "ORDER"; order: Order }
    | { kind: "REJECT"; code: BuyNowErrorCode }
    | { kind: "STOCK"; code: StockOutcomeCode };

  const runAttempt = () =>
    withTransaction(db, async (trx): Promise<TxOutcome> => {
      // Re-check idempotency inside the txn to close the race window.
      const raced = await findOrderByIdempotency(trx, input.customerId, input.idempotencyKey);
      if (raced) {
        return matchesBuyNowFingerprint(raced, input)
          ? { kind: "ORDER", order: raced }
          : { kind: "REJECT", code: "IDEMPOTENCY_CONFLICT" };
      }

      // Lock + re-read the sellability aggregate so a concurrent admin edit
      // (price, pause, product/category deactivate, policy flip) cannot slip
      // between validation and reservation.
      const live = await loadLiveVariant(trx, input.variantId, true);
      if (!live) return { kind: "REJECT", code: "VARIANT_UNAVAILABLE" };
      if (!input.skipStoreStatusCheck) {
        const gate = await canPurchase(trx, {
          telegramUserId: input.telegramUserId ?? input.customerId,
          isRootAdmin: input.isRootAdmin ?? false,
          variantIsTest: live.is_test,
        });
        if (!gate.ok) return { kind: "REJECT", code: gate.code as BuyNowErrorCode };
      }
      const rejection = revalidate(live, input.expectedPriceVnd);
      if (rejection) return { kind: "REJECT", code: rejection };

      const needsReadinessHold = isSupportedCatalogRoute({
        stockPolicy: live.stock_policy,
        fulfillmentType: live.fulfillment_type,
      });
      // Insert the Order first so the reservation can point at its id. If the
      // reserve fails we throw, rolling the Order insert back with the
      // transaction — the loser never leaves a PENDING_PAYMENT row behind.
      const inserted = await insertOrder(trx, {
        customerId: input.customerId,
        variantId: input.variantId,
        idempotencyKey: input.idempotencyKey,
        snapshot: toSnapshot(live),
        status: "PENDING_PAYMENT",
        expiresAt,
        correlationId: input.correlationId,
        actorType: "customer",
        actorId: input.customerId,
      });
      const order = inserted.order;

      if (!inserted.inserted) {
        return matchesBuyNowFingerprint(order, input)
          ? { kind: "ORDER", order }
          : { kind: "REJECT", code: "IDEMPOTENCY_CONFLICT" };
      }

      if (needsReadinessHold) {
        const reserved = await reserveTypedStockForOrder(trx, {
          variantId: input.variantId,
          orderId: order.id,
          reserveUntil: expiresAt,
          fulfillmentType: order.fulfillmentType,
        });
        if (!reserved.ok) {
          // Typed abort so the Order insert rolls back and the caller can show
          // honest copy (NO_STOCK vs race-loss vs contention).
          throw Object.assign(new Error(reserved.reason), {
            code: reserved.reason as StockOutcomeCode,
          });
        }
      }

      return { kind: "ORDER", order };
    }).catch((err: unknown): TxOutcome => {
      if (typeof err === "object" && err !== null) {
        const code = (err as { code?: string }).code;
        if (code === "NO_STOCK" || code === "CONTENTION_TIMEOUT" || code === "RESERVATION_LOST") {
          return { kind: "STOCK", code };
        }
      }
      throw err;
    });

  let outcome: TxOutcome | null = null;
  let sawContention = false;
  for (let attempt = 0; attempt < CONTENTION_MAX_ATTEMPTS; attempt++) {
    outcome = await runAttempt();
    if (outcome.kind === "STOCK" && outcome.code === "CONTENTION_TIMEOUT") {
      sawContention = true;
      if (attempt < CONTENTION_MAX_ATTEMPTS - 1) {
        await waitOutsideTransaction(20 * (attempt + 1));
        continue;
      }
    }
    if (outcome.kind === "STOCK" && outcome.code === "NO_STOCK" && sawContention) {
      outcome = { kind: "STOCK", code: "RESERVATION_LOST" };
    }
    break;
  }
  if (outcome === null) {
    throw new Error("BuyNow contention retry budget produced no outcome");
  }

  if (outcome.kind === "STOCK") {
    return { ok: false, code: outcome.code, message: BUY_NOW_MESSAGES[outcome.code] };
  }
  if (outcome.kind === "REJECT") {
    return { ok: false, code: outcome.code, message: BUY_NOW_MESSAGES[outcome.code] };
  }
  return { ok: true, order: outcome.order };
}
export async function isStoreOpen(db: Db): Promise<boolean> {
  const result = await sql<{ status: string }>`
    select status from store_control where id = 'main' limit 1
  `.execute(db);
  return result.rows[0]?.status === "OPEN";
}

export async function setStoreStatusForTest(
  db: Db,
  status: "OPEN" | "CLOSED",
  updatedBy: string,
): Promise<void> {
  await sql`
    insert into store_control (id, status, updated_at, updated_by)
    values ('main', ${status}, now(), ${updatedBy})
    on conflict (id) do update
    set status = excluded.status, updated_at = now(), updated_by = excluded.updated_by
  `.execute(db);
}

/** The persisted immutable Order snapshot is the canonical Buy Now fingerprint. */
function matchesBuyNowFingerprint(order: Order, input: BuyNowInput): boolean {
  return (
    order.customerId === input.customerId &&
    order.variantId === input.variantId &&
    Number(order.priceVnd) === input.expectedPriceVnd
  );
}

export interface CancelInput {
  orderId: string;
  customerId: string;
  correlationId: string;
}

const PAID_ORDER_STATUSES: ReadonlySet<Order["status"]> = new Set([
  "PAID",
  "PROCESSING",
  "COMPLETED",
  "FULFILLMENT_NEEDS_REVIEW",
  "REFUND_PENDING",
  "REFUNDED",
]);

export async function cancelUnpaidOrder(db: Db, input: CancelInput): Promise<BuyNowResult> {
  return withTransaction(db, async (trx): Promise<BuyNowResult> => {
    // Owner-scoped lock: a foreign order and a missing one are the same `null`, so a guessed
    // id yields no existence oracle (SR-003, BOLA).
    const order = await findOrderByIdForOwnerForUpdate(trx, input.orderId, input.customerId);
    if (!order) {
      return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy đơn hàng." };
    }
    if (PAID_ORDER_STATUSES.has(order.status)) {
      return { ok: false, code: "ALREADY_PAID", message: "Đơn hàng đã được thanh toán." };
    }
    if (!isCancellableByCustomer(order.status)) {
      return {
        ok: false,
        code: "ORDER_NOT_CANCELLABLE",
        message: "Đơn hàng không thể hủy ở trạng thái hiện tại.",
      };
    }

    // Atomically cancel the Order, void any live Payment Intent, AND release
    // the pre-payment reservation so the unit re-enters the sellable pool
    // (T123/T128 cancel-vs-settlement; T155/FR-006c reservation release).
    const cancelled = await transitionOrder(
      trx,
      order,
      "CANCELLED",
      "CUSTOMER_CANCEL",
      input.correlationId,
      {
        type: "customer",
        id: input.customerId,
      },
    );
    await voidLiveIntentsForOrder(trx, order.id);
    await releaseTypedStockForOrder(trx, order.id);
    return { ok: true, order: cancelled };
  });
}

export async function expireOverdueOrders(db: Db, options: { now?: Date } = {}): Promise<number> {
  const now = options.now ?? new Date();
  const due = await findExpirableOrders(db, now);
  let count = 0;
  for (const order of due) {
    const expired = await withTransaction(db, async (trx) => {
      const locked = await findOrderByIdForUpdate(trx, order.id);
      if (
        !locked ||
        locked.status !== "PENDING_PAYMENT" ||
        locked.expiresAt === null ||
        new Date(locked.expiresAt).getTime() >= now.getTime()
      ) {
        return false;
      }
      await transitionOrder(trx, locked, "EXPIRED", "TTL_EXPIRED", "system-expiry", {
        type: "system",
        id: null,
      });
      // Same atomic void + release as cancel — an expired Order must not accept
      // settlement and must free its reserved unit for the next buyer.
      await voidLiveIntentsForOrder(trx, locked.id);
      await releaseTypedStockForOrder(trx, locked.id);
      return true;
    });
    if (expired) count += 1;
  }
  return count;
}
