import { describe, expect, it } from "vitest";
import {
  presentBuyAgainUnavailable,
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
import type { CustomerPaymentEvidence } from "../../src/modules/commerce/history.js";
import type { Order, OrderStatus } from "../../src/modules/commerce/order.js";

/** Vi-VN money inserts a non-breaking space before ₫; normalise for comparisons. */
function plain(text: string): string {
  return text.replace(/[\u00a0\u202f]/g, " ");
}

type PresenterOrder = Order & { paymentEvidence: CustomerPaymentEvidence };

function makeOrder(overrides: Partial<PresenterOrder> = {}): PresenterOrder {
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
    paymentEvidence: "SEPAY_SETTLED",
    ...overrides,
  };
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
          paymentEvidence: "UNVERIFIED",
          productNameVi: "Claude Pro",
          variantNameVi: "1 tháng",
          priceVnd: "280000",
          createdAt: "2026-07-16T04:00:00.000Z",
        },
        {
          id: "o2",
          orderNumber: "ORD-2026-0003",
          customerId: "cust-1",
          status: "PAID",
          paymentEvidence: "SEPAY_SETTLED",
          productNameVi: "ChatGPT Plus",
          variantNameVi: "1 tháng",
          priceVnd: "300000",
          createdAt: "2026-07-17T04:00:00.000Z",
        },
      ],
      nextCursor: "cursor-2",
    });
    expect(message.text.split("\n")[0]).toBe("🧾 Đơn hàng của tôi");
    expect(plain(message.text)).toContain(
      "• ORD-2026-0002 — Claude Pro · 280.000 ₫ · ⏳ Chờ thanh toán",
    );
    expect(message.buttons).toEqual([
      [
        { text: "ORD-2026-0002", callbackData: "ord:view:ORD-2026-0002" },
        { text: "ORD-2026-0003", callbackData: "ord:view:ORD-2026-0003" },
      ],
      [
        { text: "Xem thêm", callbackData: "ord:list:cursor-2" },
        { text: "🏠 Trang chủ", callbackData: "menu:main" },
      ],
    ]);

    const lastPage = presentOrderHistory({
      items: [],
      nextCursor: null,
    });
    expect(lastPage.text).toContain("Bạn chưa có đơn hàng nào.");
  });
  it("fails closed for a PAID list row without settled payment evidence", () => {
    const message = presentOrderHistory({
      items: [
        {
          id: "o-unverified",
          orderNumber: "ORD-2026-0004",
          customerId: "cust-1",
          status: "PAID",
          paymentEvidence: "UNVERIFIED",
          productNameVi: "ChatGPT Plus",
          variantNameVi: "1 tháng",
          priceVnd: "300000",
          createdAt: "2026-07-18T04:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    expect(plain(message.text)).toContain(
      "• ORD-2026-0004 — ChatGPT Plus · 300.000 ₫ · ⚠️ Cần hỗ trợ",
    );
    expect(message.text).not.toContain("✅ Đã thanh toán");
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
      [{ text: "🔁 Mua lại", callbackData: "buyagain:ORD-2026-0001" }],
      [
        { text: "💬 Hỗ trợ", callbackData: "sup:open:ORD-2026-0001" },
        { text: "⬅️ Quay lại", callbackData: "ord:list" },
      ],
    ]);
    expect(JSON.stringify(presentOrderDetail(makeOrder()))).not.toContain(makeOrder().id);
  });

  it("renders a safe unavailable recovery without historical identifiers", () => {
    const message = presentBuyAgainUnavailable();
    expect(message.text).toContain("Không thể mua lại");
    expect(message.buttons.flat().map((button) => button.text)).toEqual([
      "🔎 Xem sản phẩm khác",
      "💬 Hỗ trợ",
      "🏠 Trang chủ",
    ]);
    expect(JSON.stringify(message)).not.toContain("var-1");
    expect(JSON.stringify(message)).not.toContain("01HZZZZZZZZZZZZZZZZZZZZZZZ");
  });
  it("fails closed for a PAID detail without settled payment evidence", () => {
    const message = plain(
      presentOrderDetail(makeOrder({ status: "PAID", paymentEvidence: "UNVERIFIED" })).text,
    );
    expect(message).toContain("Thanh toán: ⚠️ Cần hỗ trợ");
    expect(message).toContain("Trạng thái: ⚠️ Cần hỗ trợ");
    expect(message).toContain("Giao hàng / Bảo hành: Liên hệ hỗ trợ để kiểm tra");
    expect(message).not.toContain("✅ Đã thanh toán");
  });

  it("shows distinct pending and completed refund payment labels", () => {
    const pending = plain(presentOrderDetail(makeOrder({ status: "REFUND_PENDING" })).text);
    expect(pending).toContain("Thanh toán: ⏳ Đang chờ hoàn tiền");
    expect(pending).toContain("Trạng thái: ⏳ Đang xử lý yêu cầu hoàn tiền");
    expect(pending).not.toContain("Đã hoàn tiền");

    const missingEvidence = plain(
      presentOrderDetail(makeOrder({ status: "REFUNDED", paymentEvidence: "SEPAY_SETTLED" })).text,
    );
    expect(missingEvidence).toContain(`Thanh toán: ${ORDER_STATUS_FALLBACK}`);
    expect(missingEvidence).toContain(`Trạng thái: ${ORDER_STATUS_FALLBACK}`);
    expect(missingEvidence).not.toContain("Đã hoàn tiền");

    const backed = plain(
      presentOrderDetail(makeOrder({ status: "REFUNDED", paymentEvidence: "WALLET_REFUNDED" }))
        .text,
    );
    expect(backed).toContain("Thanh toán: 💸 Đã hoàn tiền");
    expect(backed).toContain("Trạng thái: ✅ Đã hoàn vào ví");
  });

  it("maps ordinary order states and never leaks an unknown internal enum", () => {
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
    expect(flatButtons.some((button) => button.callbackData.startsWith("buyagain:"))).toBe(false);
  });

  it("shows the retail account screen without wallet surfaces or numeric Telegram id", () => {
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
    expect(text).toContain("🧾 Đơn đã hoàn tất: 3");
    expect(text).not.toContain("Số dư ví");
    expect(text).not.toContain("150.000");
    expect(message.buttons).toEqual([
      [
        { text: "🧾 Xem đơn", callbackData: "ord:list" },
        { text: "💰 Đặt cọc của tôi", callbackData: "cust:preorders" },
      ],
      [
        { text: "🛡 Bảo hành", callbackData: "cust:warranty" },
        { text: "💬 Hỗ trợ", callbackData: "supp:open" },
      ],
      [{ text: "🔔 Thông báo", callbackData: "cust:notify" }],
      [{ text: "🏠 Trang chủ", callbackData: "shop:home" }],
    ]);
    expect(message.buttons.flat().map((b) => b.callbackData)).not.toContain("wallet:topup");
    expect(message.buttons.flat().map((b) => b.callbackData)).not.toContain("wallet:history");
  });

  it("offers warranty per completed order through the existing support flow", () => {
    const message = presentCustomerWarrantyHome([
      { orderNumber: "ORD-2026-0001", productNameVi: "ChatGPT Plus" },
      { orderNumber: "ORD-2026-0002", productNameVi: "Claude Pro" },
    ]);
    expect(message.text.split("\n")[0]).toBe("🛡 Bảo hành");
    expect(message.text).toContain("Chọn đơn hàng bạn cần bảo hành:");
    expect(message.text).toContain("• ORD-2026-0001 — ChatGPT Plus");
    expect(message.buttons).toEqual([
      [
        { text: "ORD-2026-0001", callbackData: "sup:open:ORD-2026-0001" },
        { text: "ORD-2026-0002", callbackData: "sup:open:ORD-2026-0002" },
      ],
      [{ text: "💬 Hỗ trợ", callbackData: "supp:open" }],
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
  it("renders warranty policy with exact-order entry and paired back/home navigation", () => {
    const message = presentWarrantyPolicy({
      productName: "ChatGPT Plus",
      warrantyDays: 30,
      coverageVi: "Lỗi tài khoản bị khóa trong thời gian bảo hành.",
      exclusionsVi: "Tự ý đổi mật khẩu.",
      examplePriceVnd: 250000n,
      productId: "prod-1",
    });

    expect(message.text).toContain("Chính sách bảo hành");
    expect(message.text).toContain("ChatGPT Plus");
    expect(message.text).toContain("30 ngày");
    expect(message.buttons).toEqual([
      [{ text: "⚠️ Chọn đơn để báo lỗi", callbackData: "cust:warranty" }],
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
      orderId: "01J00000000000000000000001",
    });

    expect(message.text).toContain("Xác nhận yêu cầu bảo hành");
    expect(message.text).toContain("ORD-2026-0001");
    expect(message.buttons).toEqual([
      [
        {
          text: "✅ Gửi yêu cầu",
          callbackData: "warranty:submit:01J00000000000000000000001:ACCOUNT_LOCKED",
        },
      ],
      [{ text: "✏️ Sửa nội dung", callbackData: "warranty:report:01J00000000000000000000001" }],
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
  it("uses refund obligations rather than claim snapshots or timelines for due/paid copy", () => {
    const due = presentWarrantyClaim({
      claimNumber: "CLM-2026-0001",
      productName: "ChatGPT Plus",
      status: "REFUND_DUE",
      estimatedRefundVnd: 233333n,
      approvedRefundVnd: 999999n,
      refundEvidence: { state: "DUE", amountVnd: 40000n, paidAt: null },
      remainingDays: 28,
      timeline: [{ kind: "REFUND_DUE", safeNote: null, createdAt: "2026-07-18T04:00:00.000Z" }],
    });
    expect(due.text).toContain("Hoàn tiền đang chờ shop chuyển khoản");
    expect(due.text).toContain("Số tiền chờ hoàn: 40.000");
    expect(due.text).not.toContain("999.999");

    const paid = presentWarrantyClaim({
      claimNumber: "CLM-2026-0001",
      productName: "ChatGPT Plus",
      status: "REFUND_PAID",
      estimatedRefundVnd: 233333n,
      approvedRefundVnd: 999999n,
      refundEvidence: {
        state: "PAID",
        amountVnd: 40000n,
        paidAt: "2026-07-18T04:00:00.000Z",
      },
      remainingDays: 28,
      timeline: [{ kind: "REFUND_PAID", safeNote: null, createdAt: "2026-07-18T04:00:00.000Z" }],
    });
    expect(paid.text).toContain("Shop ghi nhận đã chuyển khoản");
    expect(paid.text).toContain("Số tiền đã ghi nhận hoàn: 40.000");
    expect(paid.text).not.toContain("999.999");

    const unsupported = presentWarrantyClaim({
      claimNumber: "CLM-2026-0001",
      productName: "ChatGPT Plus",
      status: "REFUND_PAID",
      estimatedRefundVnd: 233333n,
      approvedRefundVnd: 999999n,
      refundEvidence: null,
      remainingDays: 28,
      timeline: [{ kind: "REFUND_PAID", safeNote: null, createdAt: "2026-07-18T04:00:00.000Z" }],
    });
    expect(unsupported.text).toContain("Cần hỗ trợ xác minh khoản hoàn tiền");
    expect(unsupported.text).not.toContain("999.999");
    expect(unsupported.text).not.toContain("Shop ghi nhận đã chuyển khoản");
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
      [{ text: "🏠 Trang chủ", callbackData: "menu:main" }],
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
