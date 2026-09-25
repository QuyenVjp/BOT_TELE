import { describe, expect, it } from "vitest";
import { presentAdminSupplierCanaryChallenge } from "../../src/bot/presenters/admin.js";

describe("owner supplier canary preview", () => {
  it("distinguishes commerce fulfillment from a locked canary purchase", () => {
    const message = presentAdminSupplierCanaryChallenge({
      runId: "run-1",
      confirmationId: "confirmation-1",
      challenge: "challenge",
      expiresAt: "2026-09-25T00:00:00Z",
      providerName: "QCST",
      externalSku: "SKU-1",
      costVnd: 23_000,
      balanceVnd: 50_000,
      currency: "VND",
    });

    expect(message.text).toContain("Commerce supplier fulfillment: OFF");
    expect(message.text).toContain("Canary supplier purchase: LOCKED until confirmation");
  });
});
