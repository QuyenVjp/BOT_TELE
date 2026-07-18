import { describe, expect, it } from "vitest";
import {
  decideMatch,
  type MatchableIntent,
  type PaymentEvidence,
} from "../../src/modules/payments/domain.js";
import {
  projectSettlement,
  projectDiscrepancyOrderStatus,
} from "../../src/modules/payments/projection.js";

/**
 * T123/T124/T128 — pure money-safety decisions (no Docker).
 *
 * These cover the exact defects the independent review found:
 *   - A cancelled/expired Order must NEVER cause `OrderPaid` to be emitted even
 *     if money arrives (money-for-dead-order → discrepancy, not delivery).
 *   - Late payment is classified from `evidence.transactedAt`, not processing
 *     wall-clock, with an explicit clock-skew allowance.
 *   - A discrepancy against a live intent projects the Order to
 *     PAYMENT_NEEDS_REVIEW so a refresh cannot mint a second QR.
 */

const liveIntent = (over: Partial<MatchableIntent> = {}): MatchableIntent => ({
  id: "intent-1",
  orderId: "order-1",
  amountVnd: 150000,
  merchantAccountId: "0123456789",
  transferContent: "ORDABC",
  status: "PRESENTED",
  expiresAt: new Date("2026-07-16T10:00:00Z"),
  ...over,
});

const evidence = (over: Partial<PaymentEvidence> = {}): PaymentEvidence => ({
  provider: "sepay",
  providerTransactionId: "SEPAY-1",
  direction: "IN",
  merchantAccountId: "0123456789",
  amountVnd: 150000,
  content: "ORDABC",
  reference: "FT-1",
  transactedAt: new Date("2026-07-16T09:59:00Z"),
  rawHash: "hash-1",
  correlationId: "corr-1",
  ...over,
});

describe("projectSettlement (never pay a dead order)", () => {
  it("emits OrderPaid only when the order was payable", () => {
    expect(projectSettlement("PENDING_PAYMENT").kind).toBe("SETTLE_AND_PAY");
  });

  it("is idempotent when the order is already paid/processing/completed", () => {
    for (const s of ["PAID", "PROCESSING", "COMPLETED"] as const) {
      expect(projectSettlement(s).kind).toBe("SETTLE_ALREADY_PAID");
    }
  });

  it("treats money for a cancelled/expired/rejected/review order as a discrepancy, never OrderPaid", () => {
    for (const s of [
      "CANCELLED",
      "EXPIRED",
      "REJECTED",
      "PAYMENT_NEEDS_REVIEW",
      "REFUNDED",
      "REFUND_PENDING",
    ] as const) {
      const p = projectSettlement(s);
      expect(p.kind, `status ${s}`).toBe("MONEY_FOR_DEAD_ORDER");
    }
  });
});

describe("projectDiscrepancyOrderStatus (freeze the order under review)", () => {
  it("moves a still-pending order to PAYMENT_NEEDS_REVIEW", () => {
    expect(projectDiscrepancyOrderStatus("PENDING_PAYMENT")).toBe("PAYMENT_NEEDS_REVIEW");
  });

  it("leaves a non-pending order unchanged (null = no transition)", () => {
    for (const s of ["PAID", "CANCELLED", "EXPIRED", "PAYMENT_NEEDS_REVIEW"] as const) {
      expect(projectDiscrepancyOrderStatus(s)).toBeNull();
    }
  });
});

describe("decideMatch late-payment uses evidence.transactedAt", () => {
  it("settles when the transfer happened before expiry even if processed later", () => {
    const intent = liveIntent();
    // Processing clock is well past expiry, but the bank stamped the transfer
    // one minute BEFORE expiry → must settle, not classify LATE_PAYMENT.
    const processedLate = new Date("2026-07-16T10:30:00Z");
    const d = decideMatch(
      evidence({ transactedAt: new Date("2026-07-16T09:59:00Z") }),
      intent,
      processedLate,
    );
    expect(d.kind).toBe("SETTLE");
  });

  it("classifies LATE_PAYMENT when the transfer itself happened after expiry+skew", () => {
    const intent = liveIntent();
    const d = decideMatch(
      evidence({ transactedAt: new Date("2026-07-16T10:05:00Z") }),
      intent,
      new Date("2026-07-16T10:06:00Z"),
    );
    expect(d.kind).toBe("DISCREPANCY");
    if (d.kind === "DISCREPANCY") expect(d.type).toBe("LATE_PAYMENT");
  });

  it("tolerates small clock skew right at the expiry boundary", () => {
    const intent = liveIntent();
    // 30s after expiry but within the skew allowance → still settles.
    const d = decideMatch(
      evidence({ transactedAt: new Date("2026-07-16T10:00:30Z") }),
      intent,
      new Date("2026-07-16T10:01:00Z"),
    );
    expect(d.kind).toBe("SETTLE");
  });
});
