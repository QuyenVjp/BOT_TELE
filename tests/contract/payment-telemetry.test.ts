import { describe, expect, it } from "vitest";
import {
  createPaymentTelemetry,
  type PaymentTelemetry,
} from "../../src/modules/payments/telemetry.js";

/**
 * T057 — Payment alerts/metrics (signature failures, reference collisions,
 * paid-without-Order, mismatch backlog, reconciliation lag).
 *
 * Counters are in-process (tests / single-instance); a production driver can
 * swap the sink behind the same `PaymentTelemetry` port. Alerts fire when a
 * threshold is crossed and never carry raw secrets.
 */

function drain(t: PaymentTelemetry) {
  return t.snapshot();
}

describe("payment telemetry counters (T057)", () => {
  it("counts signature failures and raises an alert at the threshold", () => {
    const t = createPaymentTelemetry({ signatureFailureAlertAt: 3 });
    t.recordSignatureFailure({ reason: "bad_hmac" });
    t.recordSignatureFailure({ reason: "stale_timestamp" });
    expect(drain(t).signatureFailures).toBe(2);
    expect(drain(t).alerts).toHaveLength(0);

    t.recordSignatureFailure({ reason: "bad_hmac" });
    const snap = drain(t);
    expect(snap.signatureFailures).toBe(3);
    expect(snap.alerts.some((a) => a.code === "SIGNATURE_FAILURE_THRESHOLD")).toBe(true);
  });

  it("counts reference collisions", () => {
    const t = createPaymentTelemetry();
    t.recordReferenceCollision({ content: "ORDABC", intentIds: 2 });
    expect(drain(t).referenceCollisions).toBe(1);
    expect(drain(t).alerts.some((a) => a.code === "REFERENCE_COLLISION")).toBe(true);
  });

  it("flags paid-without-Order as a critical alert", () => {
    const t = createPaymentTelemetry();
    t.recordPaidWithoutOrder({ bankTransactionId: "btx-1", amountVnd: 150000 });
    const snap = drain(t);
    expect(snap.paidWithoutOrder).toBe(1);
    expect(snap.alerts.some((a) => a.code === "PAID_WITHOUT_ORDER")).toBe(true);
  });

  it("tracks mismatch backlog depth and alerts when it exceeds the threshold", () => {
    const t = createPaymentTelemetry({ mismatchBacklogAlertAt: 5 });
    t.setMismatchBacklog(3);
    expect(drain(t).mismatchBacklog).toBe(3);
    expect(drain(t).alerts).toHaveLength(0);
    t.setMismatchBacklog(7);
    expect(drain(t).alerts.some((a) => a.code === "MISMATCH_BACKLOG")).toBe(true);
  });

  it("records reconciliation lag and alerts when lag exceeds the SLA window", () => {
    const t = createPaymentTelemetry({ reconLagAlertSeconds: 600 });
    t.recordReconciliationLag({ lagSeconds: 120, recovered: 2, discrepancies: 0 });
    expect(drain(t).lastReconLagSeconds).toBe(120);
    expect(drain(t).alerts).toHaveLength(0);

    t.recordReconciliationLag({ lagSeconds: 900, recovered: 0, discrepancies: 1 });
    expect(drain(t).alerts.some((a) => a.code === "RECONCILIATION_LAG")).toBe(true);
  });

  it("never embeds raw secrets in alert payloads", () => {
    const t = createPaymentTelemetry({ signatureFailureAlertAt: 1 });
    t.recordSignatureFailure({
      reason: "bad_hmac",
      // Deliberately try to smuggle a secret-looking field; telemetry must drop it.
      secret: "super-secret-hmac-key",
      signature: "deadbeef",
    } as { reason: string });
    const snap = drain(t);
    const blob = JSON.stringify(snap);
    expect(blob).not.toContain("super-secret-hmac-key");
    expect(blob).not.toContain("deadbeef");
  });
});
