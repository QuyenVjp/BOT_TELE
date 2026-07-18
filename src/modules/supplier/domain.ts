/**
 * SupplierOrder aggregate + state guards (T065, FR-015).
 *
 * A SupplierOrder is the durable record of an upstream provisioning request.
 * Create is idempotent on (supplier, idempotency_key). Uncertain results land
 * in UNKNOWN and must be queried/reconciled before any create retry — never a
 * silent re-submit.
 */

export type SupplierOrderStatus =
  | "CREATED"
  | "SUBMITTED"
  | "PENDING"
  | "FULFILLED"
  | "REJECTED"
  | "UNKNOWN"
  | "RECONCILED"
  | "CANCEL_PENDING"
  | "CANCELLED"
  | "REFUND_PENDING"
  | "REFUNDED";

const ALLOWED: Record<SupplierOrderStatus, readonly SupplierOrderStatus[]> = {
  CREATED: ["SUBMITTED", "REJECTED"],
  SUBMITTED: ["PENDING", "FULFILLED", "REJECTED", "UNKNOWN"],
  PENDING: ["FULFILLED", "REJECTED", "UNKNOWN", "CANCEL_PENDING"],
  UNKNOWN: ["RECONCILED", "FULFILLED", "REJECTED", "PENDING"],
  RECONCILED: ["FULFILLED", "REJECTED"],
  FULFILLED: ["REFUND_PENDING"],
  REJECTED: [],
  CANCEL_PENDING: ["CANCELLED", "REJECTED"],
  CANCELLED: [],
  REFUND_PENDING: ["REFUNDED", "REJECTED"],
  REFUNDED: [],
};

export function canSupplierOrderTransition(
  from: SupplierOrderStatus,
  to: SupplierOrderStatus,
): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export function assertSupplierOrderTransition(
  from: SupplierOrderStatus,
  to: SupplierOrderStatus,
): void {
  if (!canSupplierOrderTransition(from, to)) {
    throw new Error(`Illegal supplier order transition ${from} -> ${to}`);
  }
}

/** Statuses from which a create must NOT be re-issued without a query first. */
export function requiresQueryBeforeRetry(status: SupplierOrderStatus): boolean {
  return status === "UNKNOWN" || status === "SUBMITTED" || status === "PENDING";
}
