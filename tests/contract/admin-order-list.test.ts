import { describe, expect, it } from "vitest";
import { presentAdminOrders } from "../../src/bot/presenters/admin.js";

/**
 * The admin order list used to print `COMPLETED` / `PROCESSING` while the customer list said
 * "🎉 Hoàn tất" — the same internal code the owner-facing warranty fix removed. These pin the shared
 * wording on both the row and the button, and the fallback that keeps a future enum out of the UI.
 */

const order = (overrides: Partial<{ orderNumber: string; status: string }> = {}) => ({
  id: "order-1",
  stateId: "state-1",
  orderNumber: "ORD-TEST-1",
  customerId: "cust-1",
  telegramUserId: "123456789",
  displayName: "Chính Quyền",
  status: "COMPLETED",
  paymentStatus: "PAID",
  fulfillmentStatus: "COMPLETED",
  priceVnd: 2_000n,
  productName: "Claude Pro",
  variantName: "1 tháng",
  createdAt: "2026-09-10T20:52:00.000Z",
  ...overrides,
});

const page = (status: string) => ({
  filter: "all" as const,
  query: null,
  nextStateId: null,
  items: [order({ status })],
});

describe("presentAdminOrders", () => {
  it("renders Vietnamese wording, not the internal status", () => {
    const message = presentAdminOrders(page("COMPLETED"));

    expect(message.text).toContain("🎉 Hoàn tất");
    expect(message.text).not.toContain("COMPLETED");
  });

  it("translates the status on the row button as well", () => {
    const message = presentAdminOrders(page("PROCESSING"));
    const labels = message.buttons.flat().map((button) => button.text);

    expect(labels.some((label) => label.includes("📦 Đang giao"))).toBe(true);
    expect(labels.some((label) => label.includes("PROCESSING"))).toBe(false);
  });

  it("falls back to the support wording for a status it does not know", () => {
    const message = presentAdminOrders(page("SOME_FUTURE_STATE"));

    expect(message.text).toContain("⚠️ Cần hỗ trợ");
    expect(message.text).not.toContain("SOME_FUTURE_STATE");
  });
});
