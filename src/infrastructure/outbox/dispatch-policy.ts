/**
 * Outbox dispatch policy (T131 / T135).
 *
 * Pure classification of handler outcomes so the worker never silently acks a
 * recoverable failure or an unknown event. The independent review found both
 * defects:
 *   - OUT_OF_STOCK/NEEDS_REVIEW returned normally → event published forever;
 *   - unknown event types were no-ops → silently dropped.
 *
 * Kept pure so property/unit tests cover every outcome without a database.
 */

export type DispatchDecision =
  /** Handler succeeded; mark the outbox row published. */
  | { kind: "PUBLISHED" }
  /**
   * Transient failure — release the lease and schedule a retry with backoff.
   * Used for OUT_OF_STOCK (restock may arrive) and uncertain supplier outcomes.
   */
  | { kind: "RETRY"; errorCode: string }
  /**
   * Terminal non-retryable outcome that still needs operator attention.
   * The event is dead-lettered (not published) so it stays visible in ops
   * without spinning the attempt budget forever.
   */
  | { kind: "TERMINAL_REVIEW"; errorCode: string }
  /** Event type this worker does not understand — fail visibly, never ack. */
  | { kind: "UNKNOWN_EVENT"; eventType: string };

/**
 * Event types this worker knows how to dispatch. Anything else is UNKNOWN_EVENT
 * so a schema upgrade that a newer producer emits cannot be silently dropped
 * by an older worker.
 */
export const KNOWN_OUTBOX_EVENT_TYPES = [
  "OrderPaid",
  "PaymentSettled",
  "PaymentNeedsReview",
  "DeliveryBundleCreated",
  "DigitalAssetClaimed",
  "DigitalAssetDelivered",
  "ManualFulfillmentTaskCreated",
  "ManualFulfillmentTaskCompleted",
  "StockDelta",
  "WalletTopupPresented",
  "WalletTopupCredited",
  "WalletRefunded",
  "GroupRestockPublished",
  "SocialProofEventCreated",
  // Warranty (goal: warranty vertical). The owner alert and the customer notices are dispatched by
  // the notification service; without these the events were rejected as UNKNOWN_EVENT and the claim
  // sat silently with nobody told.
  "WarrantyClaimOpened",
  "WarrantyClaimNeedsInfo",
  "WarrantyClaimVerified",
  "WarrantyClaimRejected",
  "WarrantyReplacementApproved",
  "WarrantyRefundDue",
  "WarrantyRefundPaid",
  // Preorder (goal: deposit / balance legs) and payment-intent presentation. Without these the
  // drain rejects the row as UNKNOWN_EVENT and dead-letters it — which is how the customer whose
  // deposit was kept on an expired hold would have learned nothing at all.
  "PaymentIntentPresented",
  "PreorderDepositPaid",
  "PreorderHoldForfeited",
  "PreorderShopCancelled",
  "PreorderStockAllocated",
  // A support ticket is opened by the customer, so without this the row dead-letters and nobody is
  // told. It acks through the notification service once known.
  "TicketOpened",
] as const;

export type KnownOutboxEventType = (typeof KNOWN_OUTBOX_EVENT_TYPES)[number];

export function isKnownOutboxEventType(eventType: string): eventType is KnownOutboxEventType {
  return (KNOWN_OUTBOX_EVENT_TYPES as readonly string[]).includes(eventType);
}

/**
 * Fulfillment-result shape used by the OrderPaid handler. Kept structural so
 * this module does not import the digital-goods module (avoids a cycle).
 */
export interface FulfillmentOutcome {
  ok: boolean;
  code?: string;
}

/**
 * Classify a fulfillment outcome into a dispatch decision.
 *
 * - success → PUBLISHED
 * - OUT_OF_STOCK / NEEDS_REVIEW / ISSUE_FAILED → RETRY (stock may land, supplier
 *   may recover, vault may recover)
 * - NOT_PAID / NOT_FOUND / DELIVERY_HANDOFF_* → TERMINAL_REVIEW (domain
 *   invariant or missing delivery route; spinning forever will not help and
 *   hides the real defect from the operator)
 */
export function classifyFulfillmentOutcome(result: FulfillmentOutcome): DispatchDecision {
  if (result.ok) return { kind: "PUBLISHED" };
  const code = result.code ?? "UNKNOWN_ERROR";
  switch (code) {
    case "OUT_OF_STOCK":
    case "NEEDS_REVIEW":
    case "ISSUE_FAILED":
      return { kind: "RETRY", errorCode: code };
    // No order/bundle to hand off and no retry can synthesize one: the delivery
    // handoff path parks the row for operator review instead of burning the
    // attempt budget on an outcome that is already deterministic.
    case "NOT_PAID":
    case "NOT_FOUND":
    case "DELIVERY_HANDOFF_NOT_READY":
    case "DELIVERY_HANDOFF_ORDER_MISSING":
      return { kind: "TERMINAL_REVIEW", errorCode: code };
    default:
      // Unknown codes are treated as retryable so a future error code does not
      // get silently dropped; the attempt budget still bounds the loop.
      return { kind: "RETRY", errorCode: code };
  }
}
