import type { OrderStatus } from "../commerce/order.js";

/**
 * Pure settlement / discrepancy projections (T123 / T124 / T128).
 *
 * The payment service consults these before emitting any outbox event so that:
 *   - money arriving for a dead Order is a discrepancy (never `OrderPaid`);
 *   - a live-intent discrepancy freezes the Order at PAYMENT_NEEDS_REVIEW so a
 *     refresh cannot mint a second QR against the same unpaid order.
 *
 * Kept pure so property/unit tests can cover every status without a database.
 */

export type SettlementProjection =
  /** Order is still payable — settle intent, transition Order → PAID, emit OrderPaid. */
  | { kind: "SETTLE_AND_PAY" }
  /** Order already paid/processing/completed — settle intent idempotently, no new OrderPaid. */
  | { kind: "SETTLE_ALREADY_PAID" }
  /**
   * Money arrived for a non-payable Order (cancelled / expired / rejected / …).
   * Must NOT emit OrderPaid. The service records a discrepancy instead.
   */
  | { kind: "MONEY_FOR_DEAD_ORDER" };

const PAYABLE: ReadonlySet<OrderStatus> = new Set(["PENDING_PAYMENT"]);
const ALREADY_PAID: ReadonlySet<OrderStatus> = new Set(["PAID", "PROCESSING", "COMPLETED"]);

/**
 * Decide how settlement of a verified exact-match payment should project onto
 * the Order. The intent may still be marked SUCCEEDED on SETTLE_ALREADY_PAID
 * (idempotent), but only SETTLE_AND_PAY is allowed to emit `OrderPaid`.
 */
export function projectSettlement(orderStatus: OrderStatus): SettlementProjection {
  if (PAYABLE.has(orderStatus)) return { kind: "SETTLE_AND_PAY" };
  if (ALREADY_PAID.has(orderStatus)) return { kind: "SETTLE_ALREADY_PAID" };
  return { kind: "MONEY_FOR_DEAD_ORDER" };
}

/**
 * After a discrepancy against a live intent, decide whether the Order must be
 * frozen under review. Returns the target status, or `null` when no transition
 * is required (order already terminal / already under review / already paid).
 */
export function projectDiscrepancyOrderStatus(orderStatus: OrderStatus): OrderStatus | null {
  if (orderStatus === "PENDING_PAYMENT") return "PAYMENT_NEEDS_REVIEW";
  return null;
}
