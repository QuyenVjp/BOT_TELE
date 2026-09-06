import { describe, expect, it } from "vitest";
import {
  ADMIN_VISIBLE_ROUTE_KEYS,
  presentAdminDashboard,
  presentAdminInventoryMenu,
  presentAdminMenu,
  presentAdminOrdersMenu,
  presentAdminPaymentsMenu,
  presentAdminProductDetail,
  presentAdminProductsMenu,
  presentAdminSuppliersMenu,
  presentAdminSupportMenu,
} from "../../src/bot/presenters/admin.js";

describe("admin operational presenters", () => {
  it("only exposes live admin route keys in the root menu", () => {
    expect(ADMIN_VISIBLE_ROUTE_KEYS).toEqual([
      "products",
      "inventory",
      "orders",
      "payments",
      "suppliers",
      "support",
      "marketing",
    ]);

    const labels = presentAdminMenu()
      .buttons.flat()
      .map((button) => button.text);
    expect(labels).toEqual(
      expect.arrayContaining([
        "🛍 Sản phẩm",
        "📦 Kho hàng",
        "🧾 Đơn hàng",
        "💳 Thanh toán",
        "🚚 Nhà cung cấp",
        "💬 Hỗ trợ",
      ]),
    );
    expect(labels).not.toEqual(
      expect.arrayContaining([
        "📊 Tổng quan",
        "📣 Tiếp thị",
        "🛠 Vận hành",
        "🧪 Kiểm thử",
        "📜 Nhật ký",
      ]),
    );
  });

  it("does not retain labels from the former English root menu", () => {
    const labels = presentAdminMenu()
      .buttons.flat()
      .map((button) => button.text)
      .join(" ");
    expect(labels).not.toMatch(
      /Dashboard|Products|Inventory|Orders|Payments|Suppliers|Broadcast|Restock|Test Lab|Health|Settings|Audit/,
    );
  });

  it("provides back and home navigation for every visible admin submenu", () => {
    const submenus = [
      presentAdminProductsMenu(),
      presentAdminInventoryMenu(),
      presentAdminOrdersMenu(),
      presentAdminPaymentsMenu(),
      presentAdminSuppliersMenu(),
      presentAdminSupportMenu(),
    ];

    for (const submenu of submenus) {
      const navigation = submenu.buttons.at(-1);
      expect(navigation).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "↩️ Quay lại" }),
          expect.objectContaining({ text: "⌂ Trang quản trị", callbackData: "admin:menu" }),
        ]),
      );
    }
  });

  it("keeps every admin callback within Telegram's 64-byte limit", () => {
    const messages = [
      presentAdminMenu(),
      presentAdminProductsMenu(),
      presentAdminInventoryMenu(),
      presentAdminOrdersMenu(),
      presentAdminPaymentsMenu(),
      presentAdminSuppliersMenu(),
      presentAdminSupportMenu(),
    ];
    const callbacks = messages
      .flatMap((message) => message.buttons.flat())
      .map((button) => button.callbackData);

    expect(callbacks.length).toBeGreaterThan(0);
    for (const callback of callbacks) {
      expect(new TextEncoder().encode(callback).byteLength).toBeLessThanOrEqual(64);
    }
  });

  it("renders bounded dashboard counters without sensitive data", () => {
    const message = presentAdminDashboard({
      activeProducts: 4,
      outOfStock: 1,
      lowStock: 2,
      availableInventory: 17,
      ordersToday: 8,
      paidToday: 6,
      revenueTodayVnd: 1_250_000n,
      pendingPayment: 2,
      paymentReview: 1,
      fulfillmentFailures: 0,
    });
    expect(message.text).toContain("Sản phẩm đang bán: 4");
    expect(message.text).toContain("Kho khả dụng: 17");
    expect(message.text).toContain("Doanh thu hôm nay: 1.250.000 ₫");
    expect(message.text).not.toMatch(/password|credential|token|vault:/i);
  });

  it("renders a bounded product detail with navigation only", () => {
    const message = presentAdminProductDetail({
      id: "01",
      name: "Netflix",
      slug: "netflix",
      categoryName: "Entertainment",
      description: "Xem phim bản quyền",
      active: true,
      variantCount: 2,
      minPriceVnd: 199000n,
    });
    expect(message.text).toContain("Netflix");
    expect(message.text).toContain("199.000 ₫");
    expect(message.text).not.toMatch(/password|credential|token|vault:/i);
  });
});
