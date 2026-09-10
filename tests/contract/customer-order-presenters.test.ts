import { describe, expect, it } from "vitest";
import {
  presentOrderDetail,
  presentOrderHistory,
  ORDER_STATUS_FALLBACK,
  ORDER_STATUS_LABEL,
} from "../../src/bot/presenters/history.js";
import {
  presentCustomerAccount,
  presentCustomerWarrantyHome,
  presentPurchaseThankYou,
} from "../../src/bot/presenters/customer.js";
import type { Order, OrderStatus } from "../../src/modules/commerce/order.js";

/** Vi-VN money inserts a non-breaking space before ₫; normalise for comparisons. */
function plain(text: string): string {
  return text.replace(/[\u00a0\u202f]/g, " ");
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
    orderNumber: "ORD-2026-0001",
    idempotencyKey: null,
    customerId: "cust-1",
    variantId: "var-1",
    status: "COMPLETED",
    expiresAt: null,
    paidAt: "2026-07-16T05:00:00.000Z",
    completedAt: "2026-07-16T05:05:00.000Z",
    createdAt: "2026-07-16T04:00:00.000Z",
    version: 2,
    productNameVi: "ChatGPT Plus",
    variantNameVi: "1 tháng",
    priceVnd: "250000",
    durationCode: "P1M",
    deliveryType: "CREDENTIAL",
    warrantyDays: 30,
    supplierPolicySnapshot: "LOCAL_ONLY",
    fulfillmentType: "STOCK_ACCOUNT",
    ...overrides,
  } as Order;
}

describe("customer order screens", () => {
  it("lists orders with number, product, amount and friendly status, keeping pagination", () => {
    const message = presentOrderHistory({
      items: [
        {
          id: "o1",
          orderNumber: "ORD-2026-0002",
          customerId: "cust-1",
          status: "PENDING_PAYMENT",
          productNameVi: "Claude Pro",
          variantNameVi: "1 tháng",
          priceVnd: "280000",
          createdAt: "2026-07-16T04:00:00.000Z",
        },
      ],
      nextCursor: "cursor-2",
    });
    expect(message.text.split("\n")[0]).toBe("🧾 ĐƠN HÀNG CỦA TÔI");
    expect(plain(message.text)).toContain(
      "• ORD-2026-0002 — Claude Pro · 280.000 ₫ · ⏳ Chờ thanh toán",
    );
    expect(message.buttons.flat().map((b) => b.callbackData)).toEqual([
      "ord:view:ORD-2026-0002",
      "ord:list:cursor-2",
      "menu:main",
    ]);

    const lastPage = presentOrderHistory({
      items: [],
      nextCursor: null,
    });
    expect(lastPage.text).toContain("Bạn chưa có đơn hàng nào.");
  });
  it("renders the order snapshot, payment state, policy line and only context actions", () => {
    const message = plain(presentOrderDetail(makeOrder()).text);
    expect(message).toContain("🧾 Chi tiết đơn hàng");
    expect(message).toContain("Đơn: ORD-2026-0001");
    expect(message).toContain("ChatGPT Plus — 1 tháng");
    expect(message).toContain("Giá: 250.000 ₫");
    expect(message).toContain("Thanh toán: ✅ Đã thanh toán");
    expect(message).toContain("Trạng thái: 🎉 Hoàn tất");
    expect(message).toContain("Ngày tạo: 16/07/2026");
    expect(message).toContain("Giao hàng / Bảo hành: ✅ Đã giao · Bảo hành 30 ngày");

    expect(presentOrderDetail(makeOrder()).buttons).toEqual([
      [{ text: "💬 Hỗ trợ", callbackData: "sup:open:ORD-2026-0001" }],
      [{ text: "⬅️ Quay lại", callbackData: "ord:list" }],
    ]);
  });

  it("maps every known status and never leaks an unknown internal enum", () => {
    expect(ORDER_STATUS_LABEL.PENDING_PAYMENT).toBe("⏳ Chờ thanh toán");
    expect(ORDER_STATUS_LABEL.PAID).toBe("✅ Đã thanh toán");
    expect(ORDER_STATUS_LABEL.PROCESSING).toBe("📦 Đang giao");
    expect(ORDER_STATUS_LABEL.COMPLETED).toBe("🎉 Hoàn tất");
    expect(ORDER_STATUS_LABEL.EXPIRED).toBe("⌛ Hết hạn");
    expect(ORDER_STATUS_LABEL.CANCELLED).toBe("❌ Đã huỷ");
    expect(ORDER_STATUS_FALLBACK).toBe("⚠️ Cần hỗ trợ");

    for (const status of [
      "DRAFT",
      "REJECTED",
      "PAYMENT_NEEDS_REVIEW",
      "FULFILLMENT_NEEDS_REVIEW",
      "REFUND_PENDING",
      "REFUNDED",
      "SOMETHING_NEW",
    ] as OrderStatus[]) {
      const text = presentOrderDetail(makeOrder({ status, paidAt: null })).text;
      expect(text).toContain(`Trạng thái: ⚠️ Cần hỗ trợ`);
      expect(text).not.toContain(status);
    }
  });

  it("shows the account screen without any numeric Telegram id", () => {
    const message = presentCustomerAccount({
      displayName: "Chính",
      balanceVnd: 150000n,
      completedOrders: 3,
      shopUpdates: true,
      purchaseActivity: false,
    });
    const text = plain(message.text);
    expect(text).toContain("👤 TÀI KHOẢN KHÁCH HÀNG");
    expect(text).toContain("👋 Chính");
    expect(text).toContain("💰 Số dư ví: 150.000 ₫");
    expect(text).toContain("🧾 Đơn đã hoàn tất: 3");
    expect(text).toContain("🔔 Thông báo: Cập nhật sản phẩm Bật · Hoạt động mua hàng Tắt");
    expect(message.buttons.flat().map((b) => b.callbackData)).toEqual([
      "ord:list",
      "cust:preorders",
      "wallet:topup",
      "cust:notify",
      "cust:warranty",
      "supp:open",
      "shop:home",
    ]);
  });

  it("offers warranty per completed order through the existing support flow", () => {
    const message = presentCustomerWarrantyHome([
      { orderNumber: "ORD-2026-0001", productNameVi: "ChatGPT Plus" },
      { orderNumber: "ORD-2026-0002", productNameVi: "Claude Pro" },
    ]);
    expect(message.text.split("\n")[0]).toBe("🛡 BẢO HÀNH");
    expect(message.text).toContain("Chọn đơn hàng bạn cần bảo hành:");
    expect(message.text).toContain("• ORD-2026-0001 — ChatGPT Plus");
    expect(message.buttons.flat().map((b) => b.callbackData)).toEqual([
      "sup:open:ORD-2026-0001",
      "sup:open:ORD-2026-0002",
      "supp:open",
    ]);

    const empty = presentCustomerWarrantyHome([]);
    expect(empty.text).toContain("Bạn chưa có đơn hàng nào đã hoàn tất để bảo hành.");
    expect(empty.buttons.flat().map((b) => b.callbackData)).toEqual(["supp:open"]);
  });

  it("thanks the customer after fulfilment without repeating the credential", () => {
    const message = presentPurchaseThankYou({
      orderNumber: "ORD-2026-0001",
      productName: "ChatGPT Plus",
    });
    expect(message.text).toBe(
      [
        "🎉 CẢM ƠN BẠN ĐÃ MUA HÀNG!",
        "",
        "Sản phẩm: ChatGPT Plus · Đơn: ORD-2026-0001",
        "✅ Đơn đã hoàn tất.",
      ].join("\n"),
    );
    expect(message.buttons.flat().map((b) => b.callbackData)).toEqual([
      "ord:view:ORD-2026-0001",
      "cust:warranty",
      "shop:home",
      "sup:open:ORD-2026-0001",
    ]);
    expect(message.text).not.toContain("🔐");
  });
});
