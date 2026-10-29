import { describe, expect, it } from "vitest";
import {
  presentAdminOrderDetail,
  presentHighRiskChallenge,
} from "../../src/bot/presenters/admin.js";
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
function uncertainFileDelivery(): NonNullable<AdminOrderDetail["fileDelivery"]> {
  return {
    jobId: "order-1",
    status: "FAILED",
    outcome: "UNKNOWN",
    lastError: "SEND_UNCERTAIN",
    artifactId: "artifact-1",
    artifactVersion: 2,
    artifactSha256: "a".repeat(64),
    attemptCount: 3,
    claimGeneration: 4,
    telegramMessageId: "telegram-message-secret",
    sentAt: "2026-09-20T00:00:04.000Z",
  };
}

describe("paid delivery reconciliation owner action", () => {
  it("is allowlisted as a durable owner command", () => {
    expect(isOwnerCommand("fulfillment.reconcile")).toBe(true);
    expect(DURABLE_ADMIN_COMMAND_REFS).toContain("fulfillment.reconcile");
  });

  it("allowlists file delivery recovery as a distinct durable owner command", () => {
    expect(isOwnerCommand("file_delivery.recover")).toBe(true);
    expect(DURABLE_ADMIN_COMMAND_REFS).toContain("file_delivery.recover");
  });

  it("shows safe SEND_UNCERTAIN identity, attempts, generation, receipt, and recovery actions", () => {
    const uncertain = presentAdminOrderDetail(detail({ fileDelivery: uncertainFileDelivery() }));
    expect(uncertain.text).toContain("SEND_UNCERTAIN");
    expect(uncertain.text).toContain("Lần thử: 3 · claim generation: 4");
    expect(uncertain.text).toContain(`SHA-256: ${"a".repeat(64)}`);
    expect(uncertain.text).toContain("Telegram message receipt: đã ghi nhận");
    expect(uncertain.text).not.toContain("telegram-message-secret");
    expect(uncertain.buttons.flat()).toEqual(
      expect.arrayContaining([
        {
          text: "🛑 Giữ chưa xác định",
          callbackData: "admin:orders:file_delivery:keep:state-1",
        },
        {
          text: "⚠️ Xác nhận gửi lại",
          callbackData: "admin:orders:file_delivery:requeue:state-1",
        },
      ]),
    );

    const completed = presentAdminOrderDetail(
      detail({ orderStatus: "COMPLETED", fileDelivery: uncertainFileDelivery() }),
    );
    expect(
      completed.buttons.flat().some((button) => button.callbackData.includes("file_delivery")),
    ).toBe(false);
  });

  it("warns that Telegram may already have the prior file before requeue confirmation", () => {
    const challenge = presentHighRiskChallenge({
      confirmationId: "confirmation-1",
      challenge: "challenge-1",
      expiresAt: "2026-09-20T00:02:00.000Z",
      action: "file_delivery.recover",
      warning: "⚠️ Telegram có thể đã nhận tệp trước đó; xác nhận sẽ xếp hàng một lần gửi lại.",
    });
    expect(challenge.text).toContain("Telegram có thể đã nhận tệp trước đó");
    expect(challenge.text).toContain("file_delivery.recover");
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
