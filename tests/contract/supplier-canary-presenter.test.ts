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

    expect(message.text).toContain("Provider: QCST");
    expect(message.text).toContain("SKU: SKU-1");
    expect(message.text).toContain("Chi phí tối đa: 23.000 VND");
    expect(message.text).toContain("Số dư đọc được: 50.000 VND");
    expect(message.text).toContain("Run: run-1");
    expect(message.text).toContain("ID: confirmation-1");
    expect(message.text).toContain("Mã: challenge");
    expect(message.text).toContain("Hết hạn: 2026-09-25T00:00:00Z");
    expect(message.text).toContain("Commerce supplier fulfillment: OFF");
    expect(message.text).toContain("Canary supplier purchase: LOCKED until confirmation");
  });
});
