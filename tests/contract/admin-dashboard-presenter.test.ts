import { describe, expect, it } from "vitest";
import {
  ADMIN_COPY,
  ADMIN_VISIBLE_ROUTE_KEYS,
  presentAdminDashboard,
  presentAdminInventory,
  presentAdminInventoryProduct,
  presentAdminInventoryVariant,
  presentInventoryImportPreview,
  presentProductFulfillmentTypeChoices,
  presentAdminInventoryMenu,
  presentAdminMenu,
  presentAdminOrdersMenu,
  presentAdminPaymentsMenu,
  presentAdminProductDetail,
  presentAdminProducts,
  presentAdminProductsMenu,
  presentAdminSupplierVariant,
  presentAdminSuppliersMenu,
  presentAdminSupportMenu,
  presentProductDraftPreview,
} from "../../src/bot/presenters/admin.js";

describe("admin operational presenters", () => {
  it("only exposes live admin route keys in the root menu", () => {
    expect(ADMIN_VISIBLE_ROUTE_KEYS).toEqual([
      "dashboard",
      "products",
      "categories",
      "inventory",
      "orders",
      "payments",
      "customers",
      "preorders",
      "notifications",
      "marketing",
      "suppliers",
      "support",
      "health",
      "testing",
    ]);

    const menu = presentAdminMenu();
    expect(menu.text).toContain("⚙️ TIER20 SHOP — QUẢN TRỊ");
    const labels = menu.buttons.flat().map((button) => button.text);
    expect(labels).toEqual(
      expect.arrayContaining([
        "📊 Tổng quan",
        "📦 Sản phẩm",
        "🏷 Danh mục",
        "📥 Kho hàng",
        "🧾 Đơn hàng",
        "💳 Thanh toán",
        "👥 Khách hàng",
        "💰 Đặt cọc",
        "🔔 Thông báo",
        "📢 Broadcast",
        ADMIN_COPY.suppliers,
        "🛡 Hỗ trợ/BH",
        "🩺 Hệ thống",
        "🧪 Test Lab",
        "⚙️ Cài đặt",
        "🛒 Về Shop",
      ]),
    );
    expect(menu.buttons.flat().find((button) => button.text === "🛒 Về Shop")?.callbackData).toBe(
      "shop:home",
    );
    expect(labels).not.toEqual(expect.arrayContaining(["🛠 Vận hành", "🧪 Kiểm thử", "📜 Nhật ký"]));
  });

  it("does not retain labels from the former English root menu", () => {
    const labels = presentAdminMenu()
      .buttons.flat()
      .map((button) => button.text)
      .join(" ");
    expect(labels).not.toMatch(
      /Dashboard|Products|Inventory|Orders|Payments|Suppliers|Restock|Health|Settings|Audit/,
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
            reserved: 0,
            delivered: 0,
            error: 0,
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
      {
        id: "p1",
        name: "Netflix",
        active: true,
        variantCount: 2,
        inStock: 1,
        lowStock: 1,
        outOfStock: 1,
      },
      {
        id: "p2",
        name: "Canary",
        active: false,
        variantCount: 1,
        inStock: 0,
        lowStock: 0,
        outOfStock: 1,
      },
    ]);
    expect(populated.text).toContain("Netflix: 2 biến thể · còn 1 · sắp hết 1 · hết 1");
    expect(populated.text).toContain(
      "Canary · nháp/chưa mở bán: 1 biến thể · còn 0 · sắp hết 0 · hết 1",
    );
    expect(populated.buttons[0]?.[0]).toMatchObject({ callbackData: "admin:inventory:product:p1" });
    expect(populated.buttons[1]?.[0]).toMatchObject({
      text: "Canary · nháp · 0/1 còn",
      callbackData: "admin:inventory:product:p2",
    });
  });

  it("offers active draft review from products and draft-save from new product preview", () => {
    const products = presentAdminProducts([]);
    expect(products.buttons.flat()).toEqual(
      expect.arrayContaining([expect.objectContaining({ callbackData: "admin:products:review" })]),
    );

    const preview = presentProductDraftPreview({
      name: "Canary",
      sku: "CANARY",
      variantName: "Canary Stock",
      categoryId: "01RAWIDSHOULDNOTSHOWINTHISCASE",
      categoryName: "Canary Category",
      priceVnd: 10000n,
      fulfillmentType: "STOCK_ACCOUNT",
      inventoryFields: [
        {
          name: "username",
          label: "Tên đăng nhập",
          required: true,
          secret: false,
          customerVisible: true,
        },
      ],
      lowStockThreshold: 1,
    });
    expect(preview.buttons.flat()).toEqual(
      expect.arrayContaining([expect.objectContaining({ callbackData: "admin:products:draft" })]),
    );
    expect(preview.text).toContain("Danh mục: Canary Category");
    expect(preview.text).not.toContain("01RAWIDSHOULDNOTSHOWINTHISCASE");
  });

  it("shows every variant type with safe counts and type-aware controls", () => {
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
          reserved: 2,
          delivered: 3,
          error: 0,
          lowStockThreshold: 2,
          importSupported: true,
        },
        {
          id: "v2",
          name: "File",
          sku: "F",
          fulfillmentType: "DIGITAL_FILE",
          available: 0,
          reserved: 0,
          delivered: 0,
          error: 0,
          lowStockThreshold: null,
          importSupported: false,
          fileImportSupported: true,
          active: false,
        },
      ],
    });

    expect(message.text).toContain(
      "Account — A — Tài khoản kho — khả dụng 1 · giữ 2 · giao 3 · lỗi 0",
    );
    expect(message.text).toContain(
      "File · nháp/chưa mở bán — F — Tệp số — khả dụng 0 · giữ 0 · giao 0 · lỗi 0",
    );
    expect(message.buttons.flat()).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "File · nháp · hết hàng" })]),
    );
    expect(message.buttons.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callbackData: "admin:inventory:variant:v1" }),
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
      reserved: 0,
      delivered: 0,
      error: 0,
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

  it("does not expose selected variant ids in import previews", () => {
    const message = presentInventoryImportPreview({
      ready: 2,
      invalid: 0,
      duplicates: 0,
      variants: ["variant-secret-id"],
    });

    expect(message.text).toContain("Biến thể trong tệp: 1");
    expect(message.text).not.toContain("variant-secret-id");
    expect(message.text).not.toMatch(/password|credential|token|vault:/i);
  });

  it("renders all product fulfillment type choices as selectable callbacks", () => {
    const callbacks = presentProductFulfillmentTypeChoices()
      .buttons.flat()
      .map((button) => button.callbackData);

    expect(callbacks).toEqual(
      expect.arrayContaining([
        "admin:products:type:STOCK_ACCOUNT",
        "admin:products:type:STOCK_CODE",
        "admin:products:type:MANUAL_FULFILLMENT",
        "admin:products:type:UNLIMITED_SERVICE",
        "admin:products:type:QUANTITY_STOCK",
        "admin:products:type:DIGITAL_FILE",
        "admin:products:type:SUPPLIER_API",
      ]),
    );
  });

  it("uses type-specific inventory actions for non-secret stock variants", () => {
    const quantity = presentAdminInventoryVariant({
      productId: "p1",
      id: "qty1",
      name: "Seats",
      sku: "QTY",
      fulfillmentType: "QUANTITY_STOCK",
      available: 3,
      lowStockThreshold: 2,
      importSupported: false,
      stockVersion: 7,
    });
    const supplier = presentAdminInventoryVariant({
      productId: "p1",
      id: "sup1",
      name: "Supplier",
      sku: "SUP",
      fulfillmentType: "SUPPLIER_API",
      available: 1,
      lowStockThreshold: null,
      importSupported: false,
      supplierSupported: true,
    });
    const manual = presentAdminInventoryVariant({
      productId: "p1",
      id: "man1",
      name: "Manual",
      sku: "MAN",
      fulfillmentType: "MANUAL_FULFILLMENT",
      available: 0,
      lowStockThreshold: null,
      importSupported: false,
    });

    expect(quantity.buttons.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callbackData: "admin:inventory:qty:qty1:1:7" }),
        expect.objectContaining({ callbackData: "admin:inventory:qty:qty1:-1:7" }),
      ]),
    );
    expect(supplier.buttons.flat()).toEqual(
      expect.arrayContaining([expect.objectContaining({ callbackData: "admin:supv:sup1" })]),
    );
    expect(manual.buttons.flat().map((button) => button.callbackData)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^admin:inventory:import:/)]),
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
      reserved: 0,
      delivered: 0,
      error: 0,
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
