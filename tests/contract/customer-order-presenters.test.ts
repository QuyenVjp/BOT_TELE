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
import {
  presentWarrantyClaim,
  presentWarrantyPolicy,
  presentWarrantyReportPreview,
} from "../../src/bot/presenters/warranty.js";
import { presentTicketList } from "../../src/bot/presenters/support.js";
import { presentPreorderConsent } from "../../src/modules/commerce/preorder.js";
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
    expect(message.text.split("\n")[0]).toBe("🧾 Đơn hàng của tôi");
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
      [
        { text: "💬 Hỗ trợ", callbackData: "sup:open:ORD-2026-0001" },
        { text: "⬅️ Quay lại", callbackData: "ord:list" },
      ],
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

  it("offers a re-pay button when viewing an expired order (goal §37)", () => {
    const message = presentOrderDetail(makeOrder({ status: "EXPIRED", paidAt: null }));
    const flatButtons = message.buttons.flat();
    const reopenBtn = flatButtons.find((b) => b.callbackData === "pay:reopen:ORD-2026-0001");
    expect(reopenBtn).toBeDefined();
    expect(reopenBtn?.text).toBe("🛒 Tạo lại thanh toán");
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
    expect(text).toContain("👤 Tài khoản khách hàng");
    expect(text).toContain("👋 Chính");
    expect(text).toContain("💰 Số dư ví: 150.000 ₫");
    expect(message.buttons).toEqual([
      [
        { text: "🧾 Đơn hàng", callbackData: "ord:list" },
        { text: "📌 Đặt cọc", callbackData: "cust:preorders" },
      ],
      [
        { text: "💰 Nạp ví", callbackData: "wallet:topup" },
        { text: "🔔 Thông báo", callbackData: "cust:notify" },
      ],
      [
        { text: "🛡 Bảo hành", callbackData: "cust:warranty" },
        { text: "💬 Hỗ trợ", callbackData: "supp:open" },
      ],
      [{ text: "🏠 Trang chủ", callbackData: "shop:home" }],
    ]);
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
    expect(message.text.split("\n")[0]).toBe("🛡 Bảo hành");
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
        "🎉 Cảm ơn bạn đã mua hàng!",
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

describe("customer warranty policy, report preview, and claim layout", () => {
  it("renders warranty policy with full-width report action and paired back/home navigation", () => {
    const message = presentWarrantyPolicy({
      productName: "ChatGPT Plus",
      warrantyDays: 30,
      coverageVi: "Lỗi tài khoản bị khóa trong thời gian bảo hành.",
      exclusionsVi: "Tự ý đổi mật khẩu.",
      examplePriceVnd: 250000n,
      variantId: "var-1",
      productId: "prod-1",
    });

    expect(message.text).toContain("Chính sách bảo hành");
    expect(message.text).toContain("ChatGPT Plus");
    expect(message.text).toContain("30 ngày");
    expect(message.buttons).toEqual([
      [{ text: "🛡 Báo lỗi / Bảo hành", callbackData: "warranty:report:var-1" }],
      [
        { text: "⬅️ Quay lại", callbackData: "shop:product:prod-1" },
        { text: "🏠 Trang chủ", callbackData: "shop:home" },
      ],
    ]);
  });

  it("renders warranty report preview with full-width primary submit and separate edit/cancel rows", () => {
    const message = presentWarrantyReportPreview({
      productName: "ChatGPT Plus",
      orderNumber: "ORD-2026-0001",
      issueType: "ACCOUNT_LOCKED",
      note: "Bị khóa sau 2 ngày",
      warrantyEnd: "2026-08-16T04:00:00.000Z",
      remainingDays: 28,
      estimatedRefundVnd: 233333n,
      variantId: "var-1",
    });

    expect(message.text).toContain("Xác nhận yêu cầu bảo hành");
    expect(message.text).toContain("ORD-2026-0001");
    expect(message.buttons).toEqual([
      [{ text: "✅ Gửi yêu cầu", callbackData: "warranty:submit:var-1:ACCOUNT_LOCKED" }],
      [{ text: "✏️ Sửa nội dung", callbackData: "warranty:report:var-1" }],
      [{ text: "❌ Huỷ", callbackData: "shop:home" }],
    ]);
  });

  it("renders warranty claim with full-width payout action and paired support/home navigation", () => {
    const message = presentWarrantyClaim({
      claimNumber: "CLM-2026-0001",
      productName: "ChatGPT Plus",
      status: "SUBMITTED",
      estimatedRefundVnd: 233333n,
      approvedRefundVnd: null,
      remainingDays: 28,
      timeline: [{ kind: "SUBMITTED", safeNote: null, createdAt: "2026-07-18T04:00:00.000Z" }],
    });

    expect(message.text).toContain("CLM-2026-0001");
    expect(message.buttons).toEqual([
      [{ text: "💳 Cập nhật thông tin nhận tiền", callbackData: "warranty:payout:CLM-2026-0001" }],
      [
        { text: "💬 Hỗ trợ", callbackData: "sup:open" },
        { text: "🏠 Trang chủ", callbackData: "shop:home" },
      ],
    ]);
  });
});

describe("customer support ticket list layout", () => {
  it("compacts short ticket buttons into rows of at most 2", () => {
    const message = presentTicketList([
      {
        id: "ticket-1111aaaa",
        customerId: "cust-1",
        orderId: "ord-1",
        reasonCode: "GENERAL_QUESTION",
        status: "OPEN",
        safeSummary: "Help 1",
        dueAt: null,
        createdAt: "2026-09-20T00:00:00Z",
      },
      {
        id: "ticket-2222bbbb",
        customerId: "cust-1",
        orderId: null,
        reasonCode: "PAYMENT_QUESTION",
        status: "WAITING_SHOP",
        safeSummary: "Help 2",
        dueAt: null,
        createdAt: "2026-09-20T00:00:00Z",
      },
      {
        id: "ticket-3333cccc",
        customerId: "cust-1",
        orderId: null,
        reasonCode: "OTHER",
        status: "RESOLVED",
        safeSummary: "Help 3",
        dueAt: null,
        createdAt: "2026-09-20T00:00:00Z",
      },
    ]);

    expect(message.text.split("\n")[0]).toBe("📋 Ticket của bạn");
    expect(message.buttons).toEqual([
      [
        { text: "1111aaaa", callbackData: "sup:view:ticket-1111aaaa" },
        { text: "2222bbbb", callbackData: "sup:view:ticket-2222bbbb" },
      ],
      [{ text: "3333cccc", callbackData: "sup:view:ticket-3333cccc" }],
      [{ text: "Menu chính", callbackData: "menu:main" }],
    ]);
  });
});

describe("customer preorder consent layout and copy", () => {
  it("renders sentence case heading and separated confirm/cancel buttons", () => {
    const message = presentPreorderConsent({
      id: "var-1",
      productId: "prod-1",
      productName: "Kiro Pro",
      variantName: "1 tháng",
      sku: "SKU-1",
      priceVnd: 150000,
      preorderEnabled: true,
      depositMode: "FIXED",
      depositAmountVnd: 50000,
      depositPercent: 0,
      minDepositVnd: 50000,
      maxPreorderQueue: 50,
      holdDurationHours: 24,
      balanceDueHours: 24,
      forfeitPolicyVersion: 1,
    });

    expect(message.text.split("\n")[0]).toBe("📌 Điều kiện đặt cọc giữ suất");
    expect(message.buttons).toEqual([
      [{ text: "✅ Đồng ý & cọc 50.000 ₫", callbackData: "preorder:create:var-1" }],
      [{ text: "❌ Huỷ", callbackData: "shop:home" }],
    ]);
  });
});
