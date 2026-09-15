import { describe, expect, it } from "vitest";
import {
  classifyFulfillmentOutcome,
  KNOWN_OUTBOX_EVENT_TYPES,
  isKnownOutboxEventType,
} from "../../src/infrastructure/outbox/dispatch-policy.js";

/**
 * T131/T135 — pure outbox dispatch policy (no Docker).
 *
 * The independent review found two silent-loss defects:
 *   - OUT_OF_STOCK/NEEDS_REVIEW returned normally → the event was acked
 *     published and NEVER retried when stock arrived.
 *   - Unknown event types were normal no-ops → acked published, silently
 *     dropping events a newer producer emits.
 *
 * The policy makes each outcome explicit: PUBLISHED (ack), RETRY (defer with
 * backoff), TERMINAL_REVIEW (park, do not spin), UNKNOWN_EVENT (fail visibly).
 */

describe("classifyFulfillmentOutcome", () => {
  it("acks a successful fulfillment", () => {
    expect(classifyFulfillmentOutcome({ ok: true }).kind).toBe("PUBLISHED");
  });

  it("retries transient out-of-stock so a later restock is delivered", () => {
    const d = classifyFulfillmentOutcome({ ok: false, code: "OUT_OF_STOCK" });
    expect(d.kind).toBe("RETRY");
  });

  it("retries supplier-review (uncertain upstream) rather than dropping it", () => {
    const d = classifyFulfillmentOutcome({ ok: false, code: "NEEDS_REVIEW" });
    expect(d.kind).toBe("RETRY");
  });

  it("parks a not-paid/not-found outcome as terminal (never infinite retry)", () => {
    expect(classifyFulfillmentOutcome({ ok: false, code: "NOT_PAID" }).kind).toBe(
      "TERMINAL_REVIEW",
    );
    expect(classifyFulfillmentOutcome({ ok: false, code: "NOT_FOUND" }).kind).toBe(
      "TERMINAL_REVIEW",
    );
  });

  it("retries an issue failure (transient infra) with backoff", () => {
    expect(classifyFulfillmentOutcome({ ok: false, code: "ISSUE_FAILED" }).kind).toBe("RETRY");
  });

  it("parks a delivery handoff that no retry can satisfy", () => {
    // A missing order/bundle used to RETRY until the attempt budget ran out,
    // which hid the row instead of showing it to an operator.
    expect(classifyFulfillmentOutcome({ ok: false, code: "DELIVERY_HANDOFF_NOT_READY" }).kind).toBe(
      "TERMINAL_REVIEW",
    );
    expect(
      classifyFulfillmentOutcome({ ok: false, code: "DELIVERY_HANDOFF_ORDER_MISSING" }).kind,
    ).toBe("TERMINAL_REVIEW");
  });

  it("keeps an unknown outcome retryable so a new code is never dropped", () => {
    expect(classifyFulfillmentOutcome({ ok: false, code: "SOMETHING_NEW" }).kind).toBe("RETRY");
    expect(classifyFulfillmentOutcome({ ok: false }).kind).toBe("RETRY");
  });
});

describe("known outbox event types", () => {
  it("recognizes the wired event types", () => {
    for (const t of ["OrderPaid", "DeliveryBundleCreated", "DigitalAssetDelivered"]) {
      expect(isKnownOutboxEventType(t)).toBe(true);
    }
  });

  it("does not silently accept an unknown event type", () => {
    expect(isKnownOutboxEventType("SomethingNewerProducerEmits")).toBe(false);
    expect(KNOWN_OUTBOX_EVENT_TYPES.length).toBeGreaterThan(0);
  });
});
