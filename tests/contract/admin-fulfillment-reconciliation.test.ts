import { describe, expect, it } from "vitest";
import { presentAdminOrderDetail } from "../../src/bot/presenters/admin.js";
import { isOwnerCommand } from "../../src/bot/callbacks/admin.js";
import { DURABLE_ADMIN_COMMAND_REFS } from "../../src/modules/identity/admin-confirmation.js";
import type { AdminOrderDetail } from "../../src/modules/admin/order-operations.js";

function detail(overrides: Partial<AdminOrderDetail> = {}): AdminOrderDetail {
  return {
    id: "order-1",
    orderNumber: "ORD-1",
    customerId: "customer-1",
    telegramUserId: "10001",
    username: null,
    displayName: "Customer",
    phoneNumber: null,
    reachable: true,
    productName: "Product",
    variantName: "Variant",
    priceVnd: 100000n,
    durationCode: "P1M",
    deliveryType: "CREDENTIAL",
    fulfillmentType: "LOCAL",
    supplierPolicySnapshot: null,
    orderStatus: "PROCESSING",
    paidAt: "2026-09-20T00:00:00.000Z",
    completedAt: null,
    createdAt: "2026-09-20T00:00:00.000Z",
    paymentStatus: "SUCCEEDED",
    paymentAmountVnd: 100000n,
    paymentPresentedAt: null,
    paymentSettledAt: "2026-09-20T00:00:01.000Z",
    fulfillmentStatus: "EXPIRED",
    fulfillmentCreatedAt: "2026-09-20T00:00:02.000Z",
    manualTaskStatus: null,
    messageStateId: "state-1",
    ...overrides,
  };
}

describe("paid delivery reconciliation owner action", () => {
  it("is allowlisted as a durable owner command", () => {
    expect(isOwnerCommand("fulfillment.reconcile")).toBe(true);
    expect(DURABLE_ADMIN_COMMAND_REFS).toContain("fulfillment.reconcile");
  });

  it("shows the review action only for PROCESSING plus EXPIRED", () => {
    const review = presentAdminOrderDetail(detail());
    expect(review.buttons.flat()).toEqual(
      expect.arrayContaining([
        {
          text: "🧭 Đưa vào rà soát giao hàng",
          callbackData: "admin:orders:reconcile:state-1",
        },
      ]),
    );

    const completed = presentAdminOrderDetail(
      detail({ orderStatus: "COMPLETED", fulfillmentStatus: "EXPIRED" }),
    );
    expect(
      completed.buttons.flat().some((button) => button.callbackData.includes("reconcile")),
    ).toBe(false);

    const live = presentAdminOrderDetail(detail({ fulfillmentStatus: "AVAILABLE" }));
    expect(live.buttons.flat().some((button) => button.callbackData.includes("reconcile"))).toBe(
      false,
    );
  });

  it("shows safe evidence and separate owner resolutions for a review order", () => {
    const review = presentAdminOrderDetail(
      detail({
        orderStatus: "FULFILLMENT_NEEDS_REVIEW",
        fulfillmentStatus: "EXPIRED",
        deliveryReview: {
          assetStatus: "READY",
          assetRef: "asset-secret-reference",
          bundleStatus: "EXPIRED",
          handoffStatus: "SENT",
          handoffSentAt: "2026-09-20T00:00:03.000Z",
          providerMessageIdPresent: true,
          providerChatMatches: true,
          providerSuccessAt: "2026-09-20T00:00:02.000Z",
          sendAttemptedAt: "2026-09-20T00:00:01.000Z",
          evidenceComplete: true,
        },
      }),
    );
    expect(review.text).toContain("Bằng chứng: đủ");
    expect(review.text).toContain("message_id: có");
    expect(review.text).not.toContain("asset-secret-reference");
    expect(review.buttons.flat()).toEqual(
      expect.arrayContaining([
        {
          text: "✅ Xác nhận đã giao",
          callbackData: "admin:orders:reconcile_delivered:state-1",
        },
        {
          text: "🛑 Giữ chưa xác định",
          callbackData: "admin:orders:keep_uncertain:state-1",
        },
      ]),
    );
  });
});
