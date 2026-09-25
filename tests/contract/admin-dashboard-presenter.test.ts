import { describe, expect, it } from "vitest";
import {
  ADMIN_COPY,
  ADMIN_VISIBLE_ROUTE_KEYS,
  PUBLICATION_BLOCKER_LABEL,
  presentAdminDashboard,
  presentAdminInventory,
  presentAdminInventoryItemActions,
  presentAdminInventoryItemConfirm,
  presentAdminInventoryItemDone,
  presentAdminInventoryItems,
  presentAdminInventoryProduct,
  presentAdminInventoryVariant,
  presentInventoryImportPreview,
  presentProductFulfillmentTypeChoices,
  presentAdminInventoryMenu,
  presentAdminMenu,
  presentAdminOrdersMenu,
  presentAdminPaymentsMenu,
  presentAdminProductDetail,
  presentAdminProductReadiness,
  presentAdminEvidencePrompt,
  presentAdminProducts,
  presentAdminProductsMenu,
  presentAdminSupplierVariant,
  presentAdminSuppliersMenu,
  presentAdminSupportMenu,
  presentAdminSupplierCatalogActionDone,
  presentAdminSupplierCatalogDetail,
  presentAdminSupplierCatalogPage,
  presentAdminSupplierConfigPreview,
  presentAdminOperations,
  presentAdminStoreOpenBlocked,
  presentAdminStoreOpenConfirmation,
  presentProductDraftPreview,
} from "../../src/bot/presenters/admin.js";
import type { SupplierCatalogRow } from "../../src/modules/supplier/catalog.js";

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
      "warranty",
      "testing",
      "operations",
    ]);

    const menu = presentAdminMenu();
    expect(menu.text).toContain("⚙️ TIER20 SHOP — Quản trị");
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
        ADMIN_COPY.operations,
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

  it("offers the evidence revoke button only while its opaque halves fit the limit", () => {
    const readinessFor = (version: number, evidenceActive: boolean) => ({
      productId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      productVersion: version,
      active: true,
      archived: false,
      testOnly: false,
      visibilityBlockers: [],
      variants: [
        {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
          version,
          active: true,
          priceVnd: "250000",
          fulfillmentType: "STOCK_ACCOUNT",
          ready: true,
          routeReady: true,
          evidenceId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
          evidenceActive,
          published: false,
          blockers: [],
        },
      ],
      blockers: [],
      canPublish: true,
      publicationVersion: "1:01ARZ3NDEKTSV4RRFFQ69G5FAX:1:01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    });
    const revokeButton = (version: number, evidenceActive = true) =>
      presentAdminProductReadiness({
        name: "GPT Plus",
        readiness: readinessFor(version, evidenceActive),
        canSubmit: false,
      })
        .buttons.flat()
        .find((button) => button.text === "🚫 Thu hồi");

    // The button carries the evidence id and the variant version the owner is looking at.
    expect(revokeButton(1)?.callbackData).toBe(
      "admin:products:evrevoke:01ARZ3NDEKTSV4RRFFQ69G5FAZ:1",
    );
    // A version that no longer fits is dropped rather than truncated into a wrong revocation.
    expect(revokeButton(12345678901234)).toBeUndefined();
    // Nothing to withdraw when the variant has no active evidence row.
    expect(revokeButton(1, false)).toBeUndefined();
  });

  // TEST_ONLY is a visibility state, not a technical failure: publishing is what promotes the
  // product to public. The screen must therefore name it apart from the blockers and still offer
  // the publish button, or the owner is told to fix something that publishing itself fixes.
  it("renders visibility-only blockers apart from the blockers that stop publication", () => {
    const readinessFor = (overrides: {
      testOnly: boolean;
      visibilityBlockers: string[];
      blockers: string[];
      canPublish: boolean;
    }) =>
      ({
        productId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        productVersion: 3,
        active: true,
        archived: false,
        variants: [
          {
            id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
            version: 1,
            active: true,
            priceVnd: "250000",
            fulfillmentType: "STOCK_ACCOUNT",
            ready: true,
            routeReady: true,
            evidenceId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
            evidenceActive: true,
            published: false,
            blockers: [],
          },
        ],
        publicationVersion: `3:${"a".repeat(64)}`,
        ...overrides,
      }) as Parameters<typeof presentAdminProductReadiness>[0]["readiness"];

    const publishButton = (message: { buttons: Array<Array<{ text: string }>> }) =>
      message.buttons.flat().find((button) => button.text === "🚀 Xuất bản");

    const testOnly = presentAdminProductReadiness({
      name: "GPT Plus",
      readiness: readinessFor({
        testOnly: true,
        visibilityBlockers: ["PRODUCT_TEST_ONLY"],
        blockers: [],
        canPublish: true,
      }),
      canSubmit: true,
    });
    expect(testOnly.text).toContain("🔎 Riêng hiển thị công khai:");
    expect(testOnly.text).toContain(PUBLICATION_BLOCKER_LABEL.PRODUCT_TEST_ONLY);
    expect(testOnly.text).not.toContain("⛔ Còn thiếu:");
    expect(publishButton(testOnly)).toBeDefined();

    const technicallyBlocked = presentAdminProductReadiness({
      name: "GPT Plus",
      readiness: readinessFor({
        testOnly: false,
        visibilityBlockers: [],
        blockers: ["RESALE_EVIDENCE_MISSING"],
        canPublish: false,
      }),
      canSubmit: true,
    });
    expect(technicallyBlocked.text).toContain("⛔ Còn thiếu:");
    expect(technicallyBlocked.text).toContain(PUBLICATION_BLOCKER_LABEL.RESALE_EVIDENCE_MISSING);
    expect(technicallyBlocked.text).not.toContain("🔎 Riêng hiển thị công khai:");
    expect(publishButton(technicallyBlocked)).toBeUndefined();

    // The evidence id names the record; nothing on the screen carries a vault reference.
    expect(`${testOnly.text}${JSON.stringify(testOnly.buttons)}`).not.toMatch(/vault:|secret/i);
  });

  it("distinguishes owner-held provenance from upstream authorization", () => {
    const message = presentAdminEvidencePrompt({
      productId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      variantId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      variantName: "GPT Plus",
    });

    expect(message.text).toContain("OWNER_ATTESTATION: Chủ shop xác nhận sở hữu");
    expect(message.text).toContain("không phải uỷ quyền resale/chuyển nhượng từ nhà cung cấp");
  });

  // The preview and the durable transition read the same readiness, so a blocked preview must
  // name every condition `isStoreOpenReady` checks — and it must not offer the confirm button.
  it("marks operations counters as untrusted when the database probe is down", () => {
    const message = presentAdminOperations({
      control: {
        id: "main",
        status: "CLOSED",
        version: 4,
        updatedAt: "2026-01-01T00:00:00.000Z",
        updatedBy: null,
        lastRequestId: null,
      },
      database: "down",
      publicationBlocked: 0,
      openDiscrepancies: 0,
      resolvedDiscrepancies: 0,
      terminalOutboxOrphans: 0,
      terminalOutboxOrphansDisposed: 0,
      openSupportTickets: 0,
      criticalSupportTickets: 0,
      groupPublicationDisabled: true,
      stockAccountNotReady: 0,
    });
    expect(message.text).toContain("DATABASE DOWN");
    expect(message.text).toContain("không xác nhận trạng thái thực tế");
  });
  it("routes the umbrella payment queue to the payments menu", () => {
    const message = presentAdminOperations({
      control: {
        id: "main",
        status: "CLOSED",
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        updatedBy: null,
        lastRequestId: null,
      },
      database: "ok",
      publicationBlocked: 0,
      openDiscrepancies: 14,
      resolvedDiscrepancies: 0,
      terminalOutboxOrphans: 1,
      terminalOutboxOrphansDisposed: 0,
      openSupportTickets: 1,
      criticalSupportTickets: 0,
      groupPublicationDisabled: true,
      stockAccountNotReady: 0,
    });

    expect(
      message.buttons.flat().find((button) => button.text === "💳 Thanh toán / sai lệch")
        ?.callbackData,
    ).toBe("admin:payments");
  });

  it("names every blocking queue on the blocked store-open preview", () => {
    const control = {
      id: "main",
      status: "CLOSED" as const,
      version: 3,
      updatedAt: "2026-01-01T00:00:00.000Z",
      updatedBy: null,
      lastRequestId: null,
    };

    const blocked = presentAdminStoreOpenBlocked({
      readiness: {
        activeProducts: 0,
        inStockVariants: 0,
        openDiscrepancies: 2,
        terminalOutboxOrphans: 1,
        criticalSupportTickets: 3,
      },
      control,
    });
    for (const reason of [
      "Chưa có sản phẩm public đang hoạt động.",
      "Chưa có biến thể nào còn hàng.",
      "Còn 2 sai lệch thanh toán chưa xử lý.",
      "Còn 1 outbox terminal chưa có kết luận.",
      "Còn 3 phiếu hỗ trợ chờ người xử lý.",
    ]) {
      expect(blocked.text).toContain(reason);
    }
    expect(blocked.text).toContain("phiên bản 3");
    expect(blocked.buttons.flat().map((button) => button.callbackData)).not.toContain(
      "admin:store:open:confirm",
    );

    const confirmation = presentAdminStoreOpenConfirmation({
      activeProducts: 4,
      inStockVariants: 6,
      openDiscrepancies: 0,
      terminalOutboxOrphans: 0,
      criticalSupportTickets: 0,
    });
    expect(confirmation.text).toContain("Sản phẩm public đang hoạt động: 4");
    expect(confirmation.text).toContain("Biến thể đang còn hàng: 6");
    expect(confirmation.buttons.flat().map((button) => button.callbackData)).toContain(
      "admin:store:open:confirm",
    );
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

  it("renders fulfillment choices with separate navigation and cancel rows", () => {
    const message = presentProductFulfillmentTypeChoices();
    const callbacks = message.buttons.flat().map((button) => button.callbackData);

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
    expect(message.buttons.every((row) => row.length <= 2)).toBe(true);
    expect(message.buttons.at(-2)).toEqual([
      { text: "⬅️ Quay lại", callbackData: "admin:products:back" },
    ]);
    expect(message.buttons.at(-1)).toEqual([
      { text: "❌ Huỷ", callbackData: "admin:products:cancel" },
    ]);
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

  // Telegram rejects a button whose callback_data exceeds 64 bytes with BUTTON_DATA_INVALID, and
  // the screen simply never arrives. Every inventory-item button therefore addresses the item by
  // its derived ref instead of carrying the variant id too.
  it("keeps every inventory-item callback inside Telegram's 64-byte limit", () => {
    const variantId = "01M25ZS118M24RG8V3JJAD0J1W";
    const ref = "FX956YSJ";
    const items = presentAdminInventoryItems({
      variantId,
      variantName: "1 thang",
      items: [
        { ref, statusLabel: "khả dụng", actions: ["QUARANTINE", "REVOKE"] },
        { ref: "FZ1PBZPD", statusLabel: "đã giao", actions: [] },
      ],
    });
    const actions = presentAdminInventoryItemActions({
      variantId,
      variantName: "1 thang",
      ref,
      statusLabel: "khả dụng",
      actions: [
        { action: "QUARANTINE", label: "🛑 Cách ly" },
        { action: "RESTORE", label: "♻️ Phục hồi" },
        { action: "REVOKE", label: "🗑 Thu hồi" },
      ],
      readyRecovery: { version: 7 },
    });
    const confirm = presentAdminInventoryItemConfirm({
      variantId,
      variantName: "1 thang",
      ref,
      statusLabel: "khả dụng",
      action: "QUARANTINE",
      actionLabel: "🛑 Cách ly",
    });
    const done = presentAdminInventoryItemDone({
      variantId,
      ref,
      actionLabel: "🛑 Cách ly",
      statusLabel: "đã cách ly",
    });

    const callbacks = [items, actions, confirm, done]
      .flatMap((screen) => screen.buttons.flat())
      .map((button) => button.callbackData);
    expect(callbacks).toContain(`admin:inventory:items:${variantId}`);
    expect(callbacks).toContain(`admin:inventory:item:${ref}`);
    expect(callbacks).toContain(`admin:inventory:item-act:${ref}:READY_RELEASE`);
    expect(callbacks).toContain(`admin:inventory:item-act:${ref}:REVOKE`);
    expect(callbacks).toContain(`admin:inventory:item-confirm:${ref}:QUARANTINE`);
    for (const callback of callbacks) {
      expect(Buffer.byteLength(callback, "utf8")).toBeLessThanOrEqual(64);
    }
  });

  // Two buttons sharing a label make a screen ambiguous for the owner and unaddressable for any
  // harness: the same text would resolve to different destinations.
  it("never renders two buttons with the same label on one screen", () => {
    const screens = [
      presentAdminInventoryVariant({
        id: "01M25ZS118M24RG8V3JJAD0J1W",
        productId: "01M25ZS117DD2H4RH751FEWDYR",
        name: "1 thang",
        sku: "TEST-FINAL-E2E-ACCT-03",
        fulfillmentType: "STOCK_ACCOUNT",
        available: 3,
        lowStockThreshold: 3,
        stockVersion: 1,
        inventoryFields: [],
        importSupported: true,
      }),
      presentAdminProductDetail({
        id: "01M25ZS117DD2H4RH751FEWDYR",
        name: "San pham",
        slug: "san-pham",
        categoryName: "Gemini",
        description: null,
        active: true,
        variantCount: 0,
        minPriceVnd: 2000n,
        variants: [],
      }),
      presentAdminInventoryMenu(),
      presentAdminProductsMenu(),
    ];
    for (const screen of screens) {
      const labels = screen.buttons.flat().map((button) => button.text);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it("enforces 2D row contract on root admin menu (at most 2 buttons per row and paired bottom row)", () => {
    const menu = presentAdminMenu();
    for (const row of menu.buttons) {
      expect(row.length).toBeLessThanOrEqual(2);
    }
    const bottomRow = menu.buttons.at(-1);
    expect(bottomRow).toEqual([
      { text: "⚙️ Cài đặt", callbackData: "admin:store:mode" },
      { text: "🛒 Về Shop", callbackData: "shop:home" },
    ]);
  });

  it("enforces 2D row contract on operations presenter (paired navigation rows)", () => {
    const message = presentAdminOperations({
      control: {
        id: "main",
        status: "CLOSED",
        version: 1,
        updatedAt: "2026-09-11",
        updatedBy: "root",
        lastRequestId: null,
      },
      database: "ok",
      publicationBlocked: 0,
      openDiscrepancies: 0,
      resolvedDiscrepancies: 0,
      terminalOutboxOrphans: 0,
      terminalOutboxOrphansDisposed: 0,
      openSupportTickets: 0,
      criticalSupportTickets: 0,
      groupPublicationDisabled: true,
      stockAccountNotReady: 0,
    });
    expect(message.text).toContain("🛠 Vận hành / Readiness");
    for (const row of message.buttons) {
      expect(row.length).toBeLessThanOrEqual(2);
    }
    expect(message.buttons[0]).toEqual([
      { text: "💳 Thanh toán / sai lệch", callbackData: "admin:payments" },
      { text: "🛍 Readiness sản phẩm", callbackData: "admin:products" },
    ]);
    expect(message.buttons[1]).toEqual([
      { text: "⭐ Kiểm duyệt đánh giá", callbackData: "admin:reviews" },
      { text: "🏪 Store control", callbackData: "admin:store:mode" },
    ]);
    expect(message.buttons[2]).toEqual([
      { text: "💬 Ticket hỗ trợ", callbackData: "admin:support" },
    ]);
    expect(message.buttons[3]).toEqual([
      { text: "↩️ Quay lại", callbackData: "admin:menu" },
      { text: "⌂ Trang quản trị", callbackData: "admin:menu" },
    ]);
  });
  it("offers the supported group publication shutdown only while group posting is enabled", () => {
    const message = presentAdminOperations({
      control: {
        id: "main",
        status: "CLOSED",
        version: 1,
        updatedAt: "2026-09-11",
        updatedBy: "root",
        lastRequestId: null,
      },
      database: "ok",
      publicationBlocked: 0,
      openDiscrepancies: 0,
      resolvedDiscrepancies: 0,
      terminalOutboxOrphans: 0,
      terminalOutboxOrphansDisposed: 0,
      openSupportTickets: 0,
      criticalSupportTickets: 0,
      groupPublicationDisabled: false,
      stockAccountNotReady: 0,
    });

    expect(
      message.buttons
        .flat()
        .find((button) => button.callbackData.includes("group-publication-off")),
    ).toEqual({
      text: "🚫 Tắt publication group",
      callbackData: "admin:operations:group-publication-off",
    });
  });

  it("enforces 2D row contract on product draft preview (submit/cancel full-width, secondary paired)", () => {
    const preview = presentProductDraftPreview({
      sku: "SKU-DRAFT",
      variantName: "1 tháng",
      priceVnd: 100000n,
      fulfillmentType: "STOCK_ACCOUNT",
      inventoryFields: [],
    });
    expect(preview.text).toContain("📋 Xem trước sản phẩm");
    // Row 0: Full-width submit action
    expect(preview.buttons[0]).toHaveLength(1);
    expect(preview.buttons[0]![0]).toMatchObject({ callbackData: "admin:products:confirm" });
    // Row 1: Paired secondary actions (Edit + Draft)
    expect(preview.buttons[1]).toEqual([
      { text: "✏️ Chỉnh sửa", callbackData: "admin:products:back" },
      { text: "💾 Lưu nháp", callbackData: "admin:products:draft" },
    ]);
    // Row 2: Full-width destructive action (Cancel)
    expect(preview.buttons[2]).toEqual([{ text: "❌ Huỷ", callbackData: "admin:products:cancel" }]);
  });

  it("enforces 2D row contract on product detail actions and navigation", () => {
    const detail = presentAdminProductDetail({
      id: "prod-01",
      name: "ChatGPT Plus",
      slug: "chatgpt-plus",
      categoryName: "AI",
      description: null,
      active: true,
      variantCount: 0,
      minPriceVnd: 200000n,
      variants: [],
    });
    // Action row 0: Readiness + Sửa nội dung
    expect(detail.buttons[0]).toEqual([
      { text: "🚀 Readiness xuất bản", callbackData: "admin:products:ready:prod-01" },
      { text: "✏️ Sửa nội dung", callbackData: "admin:products:content:prod-01" },
    ]);
    // Action row 1: Ghim nổi bật + Thêm biến thể
    expect(detail.buttons[1]).toEqual([
      { text: "⭐ Ghim nổi bật", callbackData: "admin:products:feature:prod-01" },
      { text: "➕ Thêm biến thể", callbackData: "admin:products:variant-add:prod-01" },
    ]);
    // Bottom navigation: paired adminNav
    expect(detail.buttons.at(-1)).toEqual([
      { text: "↩️ Quay lại", callbackData: "admin:products" },
      { text: "⌂ Trang quản trị", callbackData: "admin:menu" },
    ]);
  });
  it("renders supplier metadata separately from local curation", () => {
    const row: SupplierCatalogRow = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      supplier_id: "qcst",
      external_product_id: "qcst-product-1",
      external_variant_id: "",
      upstream_name_vi: "VPN upstream",
      upstream_description_vi: "upstream description",
      availability: "AVAILABLE",
      stock_quantity: 4,
      supplier_cost_vnd: "100000",
      currency: "VND",
      selection_status: "DISCOVERED",
      is_enabled: false,
      is_missing: false,
      local_product_id: null,
      local_variant_id: null,
      supplier_sku_id: null,
      local_name_vi: null,
      local_variant_name_vi: null,
      local_description_vi: null,
      is_primary: false,
      version: 1,
      updated_at: "2026-09-24T00:00:00Z",
    };
    const page = presentAdminSupplierCatalogPage({
      providerKey: "qcst",
      providerName: "QCST",
      capabilities: ["CATALOG_LIST"],
      items: [row],
      nextOffset: 8,
      total: 9,
      syncEnabled: true,
    });
    expect(page.text).toContain("DISCOVERED · tắt");
    expect(page.text).toContain("cost 100.000 ₫");
    expect(page.buttons.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callbackData: `admin:supplier:qcst:item:${row.id}` }),
        expect.objectContaining({ callbackData: "admin:supplier:qcst:sync" }),
        expect.objectContaining({ callbackData: "admin:supplier:qcst:page:8" }),
      ]),
    );

    const detail = presentAdminSupplierCatalogDetail({
      providerKey: "qcst",
      providerName: "QCST",
      row,
      ownerSelectionEnabled: true,
    });
    expect(detail.text).toContain("Cost tham chiếu");
    expect(detail.text).toContain("Giá bán local chỉ do owner đặt");
    expect(detail.buttons.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callbackData: `admin:supplier:qcst:configure:${row.id}` }),
      ]),
    );
    const preview = presentAdminSupplierConfigPreview({
      providerKey: "qcst",
      providerName: "QCST",
      stateId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      localNameVi: "VPN local",
      localVariantNameVi: "1 tháng",
      localPriceVnd: 199000n,
      localDescriptionVi: "Mô tả local",
    });
    const attachPreview = presentAdminSupplierConfigPreview({
      providerKey: "vokhong",
      providerName: "Vô Không",
      stateId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      localNameVi: "A",
      localVariantNameVi: "B",
      localPriceVnd: 159000n,
      localDescriptionVi: "C",
      attachOnly: true,
    });
    expect(attachPreview.text).toContain("chỉ đọc");
    expect(preview.text).toContain("199.000 ₫");
    const previewCallbacks = preview.buttons.flat().map((button) => button.callbackData);
    expect(previewCallbacks).toContain("admin:supplier:qcst:confirm:01ARZ3NDEKTSV4RRFFQ69G5FAX:on");
    expect(previewCallbacks).toContain(
      "admin:supplier:qcst:confirm:01ARZ3NDEKTSV4RRFFQ69G5FAX:off",
    );
    expect(
      presentAdminSupplierCatalogActionDone({
        providerKey: "qcst",
        providerName: "QCST",
        catalogId: row.id,
        enabled: false,
      }).text,
    ).toContain("Đã lưu mapping ở trạng thái tắt");
  });
});
