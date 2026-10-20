import { describe, expect, it } from "vitest";
import { createCallbackTokenCodec } from "../../src/bot/callback-codec.js";
import { sealPresentedMessageCallbacks } from "../../src/bot/callback-sealer.js";
import { presentSupportReasonMenu, presentTicketDetail } from "../../src/bot/presenters/support.js";
import type { SupportTicket } from "../../src/modules/support/service.js";

const ticket = (status: SupportTicket["status"]): SupportTicket => ({
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  customerId: "customer-internal-id",
  orderId: "order-internal-id",
  reasonCode: "PAYMENT_QUESTION",
  status,
  safeSummary: "Thanh toán đã trừ nhưng đơn chưa cập nhật",
  dueAt: "2026-09-29T00:00:00.000Z",
  createdAt: "2026-09-28T00:00:00.000Z",
});

describe("customer support ticket detail", () => {
  it("renders safe human labels and the owned public order number", () => {
    const message = presentTicketDetail(ticket("RESOLVED"), "DH-20260928-0001");
    expect(message.text).toContain("Câu hỏi về thanh toán");
    expect(message.text).toContain("Đã xử lý");
    expect(message.text).toContain("Thanh toán đã trừ nhưng đơn chưa cập nhật");
    expect(message.text).toContain("DH-20260928-0001");
    expect(message.text).not.toContain("PAYMENT_QUESTION");
    expect(message.text).not.toContain("RESOLVED");
    expect(message.text).not.toContain("order-internal-id");
    expect(message.text).not.toContain("customer-internal-id");
    expect(message.buttons).toEqual([
      [{ text: "Đóng ticket", callbackData: `sup:close:${ticket("RESOLVED").id}` }],
      [
        { text: "⬅️ Quay lại", callbackData: "sup:list" },
        { text: "🏠 Trang chủ", callbackData: "menu:main" },
      ],
    ]);
  });

  it("exposes the customer's ticket list from the support reason menu", () => {
    const message = presentSupportReasonMenu();
    const button = message.buttons
      .flat()
      .find((candidate) => candidate.text === "📋 Ticket của tôi");

    expect(button).toEqual({ text: "📋 Ticket của tôi", callbackData: "sup:list" });
  });

  it("only offers close while the ticket is resolved", () => {
    const message = presentTicketDetail(ticket("OPEN"));
    expect(message.buttons).toEqual([
      [
        { text: "⬅️ Quay lại", callbackData: "sup:list" },
        { text: "🏠 Trang chủ", callbackData: "menu:main" },
      ],
    ]);
  });

  it("seals support list, detail, and close buttons to the current Telegram customer", async () => {
    const codec = createCallbackTokenCodec({
      key: "test-only-support-callback-key-material-123456",
      keyVersion: 1,
      ttlSeconds: 900,
      clockSkewSeconds: 5,
    });
    const sealed = await sealPresentedMessageCallbacks(
      {
        text: "support",
        buttons: [
          [{ text: "list", callbackData: "sup:list" }],
          [{ text: "view", callbackData: `sup:view:${ticket("OPEN").id}` }],
          [{ text: "close", callbackData: `sup:close:${ticket("OPEN").id}` }],
          [{ text: "invalid", callbackData: "sup:close:not-a-ticket-id" }],
        ],
      },
      {
        codec,
        telegramUserId: "700000001",
        resolveOrderId: async () => null,
      },
    );

    const callbacks = sealed.buttons.flat().map((button) => button.callbackData);
    expect(callbacks).toHaveLength(3);
    expect(callbacks.every((callback) => callback.startsWith("cb:"))).toBe(true);
    expect(codec.verify(callbacks[0]!, { telegramUserId: "700000001" })).toMatchObject({
      ok: true,
      value: { action: "SUPPORT_TICKET_LIST" },
    });
    expect(codec.verify(callbacks[1]!, { telegramUserId: "700000001" })).toMatchObject({
      ok: true,
      value: { action: "SUPPORT_TICKET_VIEW", resourceId: ticket("OPEN").id },
    });
    expect(codec.verify(callbacks[2]!, { telegramUserId: "700000001" })).toMatchObject({
      ok: true,
      value: { action: "SUPPORT_TICKET_CLOSE", resourceId: ticket("OPEN").id },
    });
    expect(codec.verify(callbacks[2]!, { telegramUserId: "700000002" })).toEqual({
      ok: false,
      code: "INVALID_SIGNATURE",
    });
  });
});
