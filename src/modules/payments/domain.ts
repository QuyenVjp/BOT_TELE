/**
 * Payment domain types + matching decision (FR-009, FR-011, SR-002).
 *
 * Settlement is fail-closed: a bank transaction settles a Payment Intent only
 * when direction is inbound, the merchant account matches, the amount is exact,
 * and the transfer content resolves to exactly one live intent. Any deviation
 * produces a typed Discrepancy rather than a settlement.
 */

export type PaymentIntentStatus =
  | "CREATED"
  | "PRESENTED"
  | "SUCCEEDED"
  | "EXPIRED"
  | "FAILED"
  | "NEEDS_REVIEW"
  | "PARTIALLY_REFUNDED"
  | "REFUNDED";

export type PaymentAllocationStatus = "PENDING" | "SETTLED" | "REVERSED" | "REJECTED";

export type DiscrepancyType =
  | "UNDERPAYMENT"
  | "OVERPAYMENT"
  | "LATE_PAYMENT"
  | "WRONG_CONTENT"
  | "WRONG_ACCOUNT"
  | "UNMATCHED"
  | "REFERENCE_COLLISION"
  | "REFUND_MISMATCH";

/** Verified inbound evidence (post-signature) presented to the matcher. */
export interface PaymentEvidence {
  provider: string;
  providerTransactionId: string;
  direction: "IN" | "OUT";
  merchantAccountId: string;
  amountVnd: number;
  /** Structured provider payment code; primary match key when present. */
  structuredCode?: string | null;
  content: string | null;
  reference: string | null;
  transactedAt: Date;
  rawHash: string;
  correlationId: string;
}

/** The live intent a matcher compares evidence against. */
export interface MatchableIntent {
  id: string;
  /** Owning Order; null for a preorder deposit/balance intent. */
  orderId: string | null;
  /** Owning reservation; null for an order intent. */
  preorderId?: string | null;
  /** Which preorder leg the intent pays; absent for order intents. */
  kind?: "ORDER" | "TOPUP" | "DEPOSIT" | "BALANCE";
  amountVnd: number;
  merchantAccountId: string;
  transferContent: string;
  status: PaymentIntentStatus;
  expiresAt: Date;
}

export type MatchDecision =
  | { kind: "SETTLE"; intentId: string; orderId: string | null; preorderId: string | null }
  | { kind: "DISCREPANCY"; type: DiscrepancyType; reason: string };

/**
 * Allowed clock skew between the bank's transfer timestamp and our intent expiry
 * (T124). Banks stamp `transactedAt` on their own clock; we tolerate a small
 * skew at the boundary so a transfer completed essentially on time is not
 * misclassified as LATE_PAYMENT. Kept conservative (money-safety over leniency).
 */
export const LATE_PAYMENT_SKEW_MS = 60_000;

/**
 * Deterministic evidence→intent matching. Pure function: the repository resolves
 * the candidate intent by content, this decides settle vs discrepancy.
 *
 * Late-payment is judged by WHEN THE TRANSFER HAPPENED (`evidence.transactedAt`),
 * not when we happened to process the webhook — a settlement webhook that
 * arrives minutes late must still settle if the money moved before expiry.
 * `now` remains injectable for deterministic tests but is no longer the basis
 * for the late-payment decision.
 */
export function decideMatch(
  evidence: PaymentEvidence,
  intent: MatchableIntent | null,
  now: Date = new Date(),
): MatchDecision {
  void now; // retained for API compatibility; timing uses evidence.transactedAt
  if (evidence.direction !== "IN") {
    return { kind: "DISCREPANCY", type: "UNMATCHED", reason: "non-inbound transfer" };
  }
  if (!intent) {
    return { kind: "DISCREPANCY", type: "UNMATCHED", reason: "no intent for transfer content" };
  }
  if (evidence.merchantAccountId !== intent.merchantAccountId) {
    return { kind: "DISCREPANCY", type: "WRONG_ACCOUNT", reason: "merchant account mismatch" };
  }
  if (evidence.amountVnd < intent.amountVnd) {
    return { kind: "DISCREPANCY", type: "UNDERPAYMENT", reason: "amount below intent" };
  }
  if (evidence.amountVnd > intent.amountVnd) {
    return { kind: "DISCREPANCY", type: "OVERPAYMENT", reason: "amount above intent" };
  }

  // Judge lateness by the transfer time plus a bounded skew allowance.
  const transferMs = evidence.transactedAt.getTime();
  const deadlineMs = intent.expiresAt.getTime() + LATE_PAYMENT_SKEW_MS;
  const transferredLate = Number.isFinite(transferMs) && transferMs > deadlineMs;

  if (intent.status !== "PRESENTED" && intent.status !== "CREATED") {
    // Already settled/expired intent: not a fresh settlement.
    if (transferredLate) {
      return { kind: "DISCREPANCY", type: "LATE_PAYMENT", reason: "intent no longer live" };
    }
    return { kind: "DISCREPANCY", type: "UNMATCHED", reason: "intent not settleable" };
  }
  if (transferredLate) {
    return { kind: "DISCREPANCY", type: "LATE_PAYMENT", reason: "transfer after expiry" };
  }
  return {
    kind: "SETTLE",
    intentId: intent.id,
    orderId: intent.orderId,
    preorderId: intent.preorderId ?? null,
  };
}
