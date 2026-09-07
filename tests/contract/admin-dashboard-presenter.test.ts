import { describe, expect, it } from "vitest";
import {
  ADMIN_VISIBLE_ROUTE_KEYS,
  presentAdminDashboard,
  presentAdminInventory,
  presentAdminInventoryProduct,
  presentAdminInventoryVariant,
  presentAdminInventoryMenu,
  presentAdminMenu,
  presentAdminOrdersMenu,
  presentAdminPaymentsMenu,
  presentAdminProductDetail,
  presentAdminProductsMenu,
  presentAdminSupplierVariant,
  presentAdminSuppliersMenu,
  presentAdminSupportMenu,
} from "../../src/bot/presenters/admin.js";

describe("admin operational presenters", () => {
  it("only exposes live admin route keys in the root menu", () => {
    expect(ADMIN_VISIBLE_ROUTE_KEYS).toEqual([
      "products",
      "inventory",
      "customers",
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
      presentAdminInventoryProduct({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        name: "Netflix",
        variants: [
          {
            id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
            name: "Premium",
            sku: "NF-P",
            fulfillmentType: "STOCK_ACCOUNT",
            available: 1,
            lowStockThreshold: 2,
            importSupported: true,
          },
        ],
      }),
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

  it("renders an empty inventory picker and product-to-variant inventory navigation", () => {
    const empty = presentAdminInventory([]);
    expect(empty.text).toContain("Chưa có sản phẩm");
    expect(empty.buttons[0]?.[0]).toMatchObject({ callbackData: "admin:products:create" });

    const populated = presentAdminInventory([
      { id: "p1", name: "Netflix", variantCount: 2 },
      { id: "p2", name: "Spotify", variantCount: 1 },
    ]);
    expect(populated.text).toContain("Netflix (2 biến thể)");
    expect(populated.buttons[0]?.[0]).toMatchObject({ callbackData: "admin:inventory:product:p1" });
    expect(populated.buttons[1]?.[0]).toMatchObject({ callbackData: "admin:inventory:product:p2" });
  });

  it("only exposes import for account/code variants with a configured backend", () => {
    const message = presentAdminInventoryProduct({
      id: "p1",
      name: "Netflix",
      variants: [
        {
          id: "v1",
          name: "Account",
          sku: "A",
          fulfillmentType: "STOCK_ACCOUNT",
          available: 1,
          lowStockThreshold: 2,
          importSupported: true,
        },
        {
          id: "v2",
          name: "File",
          sku: "F",
          fulfillmentType: "DIGITAL_FILE",
          available: 0,
          lowStockThreshold: null,
          importSupported: false,
        },
      ],
    });

    expect(message.text).toContain("Account");
    expect(message.text).toContain("File");
    expect(message.buttons.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callbackData: "admin:inventory:variant:v1" }),
      ]),
    );
    expect(message.buttons.flat()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callbackData: "admin:inventory:variant:v2" }),
      ]),
    );
  });

  it("renders a variant import prompt without secret material", () => {
    const message = presentAdminInventoryVariant({
      productId: "p1",
      id: "v1",
      name: "Premium",
      sku: "NF-P",
      fulfillmentType: "STOCK_ACCOUNT",
      available: 1,
      lowStockThreshold: 2,
      importSupported: true,
    });

    expect(message.text).toContain("Premium");
    expect(message.text).toContain("Tài khoản kho");
    expect(message.text).not.toMatch(/password|credential|token|vault:/i);
    expect(message.buttons.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callbackData: "admin:inventory:import:v1" }),
      ]),
    );
  });

  it("offers optional stock announcement from a variant with inventory", () => {
    const message = presentAdminInventoryVariant({
      productId: "p1",
      id: "v1",
      name: "Premium",
      sku: "NF-P",
      fulfillmentType: "STOCK_ACCOUNT",
      available: 3,
      lowStockThreshold: 2,
      importSupported: true,
      announceSupported: true,
    });

    expect(message.buttons.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callbackData: "admin:inventory:announce:v1" }),
      ]),
    );
  });

  it("renders a bounded product detail with variant navigation", () => {
    const message = presentAdminProductDetail({
      id: "01",
      name: "Netflix",
      slug: "netflix",
      categoryName: "Entertainment",
      description: "Xem phim bản quyền",
      active: true,
      variantCount: 2,
      minPriceVnd: 199000n,
      variants: [
        {
          id: "v1",
          name: "Premium",
          sku: "NF-P",
          priceVnd: 199000n,
          active: true,
          fulfillmentType: "STOCK_ACCOUNT",
        },
      ],
    });
    expect(message.text).toContain("Netflix");
    expect(message.text).toContain("Premium");
    expect(message.text).toContain("199.000 ₫");
    expect(message.text).not.toMatch(/password|credential|token|vault:/i);
  });
  it("renders supplier menu links and compact supplier callbacks", () => {
    const menu = presentAdminSuppliersMenu([
      {
        id: "s1",
        name: "Primary",
        adapterType: "sandbox",
        status: "ACTIVE",
        activeMappings: 1,
        variantId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        variantName: "Premium",
      },
    ]);
    expect(menu.buttons.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callbackData: "admin:supv:01ARZ3NDEKTSV4RRFFQ69G5FAX" }),
      ]),
    );

    const detail = presentAdminSupplierVariant({
      variantId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      variantName: "Premium",
      sku: "NF-P",
      mappings: [
        {
          supplierSkuId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
          supplierName: "Primary",
          externalSku: "NF-1M-VN",
          costVnd: 120000n,
          region: "VN",
          active: true,
          selected: true,
          lastVerifiedAt: null,
        },
      ],
    });

    const callbacks = [...menu.buttons.flat(), ...detail.buttons.flat()].map(
      (button) => button.callbackData,
    );
    expect(callbacks).toEqual(
      expect.arrayContaining([
        "admin:sups:01ARZ3NDEKTSV4RRFFQ69G5FAY",
        "admin:supm:01ARZ3NDEKTSV4RRFFQ69G5FAY",
        "admin:supc:01ARZ3NDEKTSV4RRFFQ69G5FAX",
      ]),
    );
    for (const callback of callbacks) {
      expect(Buffer.byteLength(callback, "utf8")).toBeLessThanOrEqual(64);
    }
  });
});
