/**
 * Order aggregate, immutable snapshot, transitions, and guards (FR-006–FR-008).
 *
 * An Order is created only after sellability revalidation. The product/variant
 * snapshot (name, price, duration, delivery, warranty, policy) is immutable from
 * that moment — later catalog edits never rewrite it. State transitions are
 * explicit and recorded; unguarded jumps are rejected.
 */

export type OrderStatus =
  | "DRAFT"
  | "PENDING_PAYMENT"
  | "PAID"
  | "PROCESSING"
  | "COMPLETED"
  | "REJECTED"
  | "CANCELLED"
  | "EXPIRED"
  | "PAYMENT_NEEDS_REVIEW"
  | "FULFILLMENT_NEEDS_REVIEW"
  | "REFUND_PENDING"
  | "REFUNDED";

/** Immutable commercial snapshot captured at Buy Now. */
export interface OrderSnapshot {
  productNameVi: string;
  variantNameVi: string;
  priceVnd: string; // exact integer VND as string (bigint-safe)
  durationCode: string;
  deliveryType: string;
  warrantyDays: number;
  supplierPolicySnapshot: string | null;
}

export interface Order {
  id: string;
  orderNumber: string;
  idempotencyKey: string | null;
  customerId: string;
  variantId: string;
  status: OrderStatus;
  expiresAt: string | null;
  paidAt: string | null;
  completedAt: string | null;
  createdAt: string;
  version: number;
  // Snapshot fields are denormalized onto the row for immutability.
  productNameVi: string;
  variantNameVi: string;
  priceVnd: string;
  durationCode: string;
  deliveryType: string;
  warrantyDays: number;
  supplierPolicySnapshot: string | null;
}

/** Legal transitions for the MVP (data-model.md Commerce). */
const ALLOWED: Record<OrderStatus, readonly OrderStatus[]> = {
  DRAFT: ["PENDING_PAYMENT", "REJECTED"],
  PENDING_PAYMENT: ["PAID", "CANCELLED", "EXPIRED", "PAYMENT_NEEDS_REVIEW"],
  PAID: ["PROCESSING", "FULFILLMENT_NEEDS_REVIEW", "REFUND_PENDING"],
  PROCESSING: ["COMPLETED", "FULFILLMENT_NEEDS_REVIEW", "REFUND_PENDING"],
  COMPLETED: ["REFUND_PENDING"],
  REJECTED: [],
  CANCELLED: [],
  EXPIRED: ["PAYMENT_NEEDS_REVIEW"],
  PAYMENT_NEEDS_REVIEW: [],
  FULFILLMENT_NEEDS_REVIEW: [],
  REFUND_PENDING: ["REFUNDED"],
  REFUNDED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal order transition ${from} -> ${to}`);
  }
}

/** Unpaid statuses a customer may still cancel. */
export function isCancellableByCustomer(status: OrderStatus): boolean {
  return status === "PENDING_PAYMENT" || status === "DRAFT";
}

/** Statuses that the expiry worker may move to EXPIRED. */
export function isExpirable(status: OrderStatus): boolean {
  return status === "PENDING_PAYMENT";
}
