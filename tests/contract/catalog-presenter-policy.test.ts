import { describe, expect, it } from "vitest";
import {
  presentProductDetail,
  presentSearchResults,
  presentVariantDetail,
} from "../../src/bot/presenters/catalog.js";
import type { CatalogVariantRow, ProductDetailView } from "../../src/modules/catalog/repository.js";

function variant(
  stockPolicy: CatalogVariantRow["stock_policy"],
  fulfillmentType: CatalogVariantRow["fulfillment_type"] = "STOCK_ACCOUNT",
  ready = true,
  availableQuantity: number | null = null,
): CatalogVariantRow {
  return {
    id: `variant-${stockPolicy}-${fulfillmentType}`,
    product_id: "product-1",
    product_name_vi: "Sản phẩm",
    sku: `SKU-${stockPolicy}-${fulfillmentType}`,
    name_vi: "Gói 1 tháng",
    price_vnd: "100000",
    duration_code: "P1M",
    delivery_type: "LICENSE",
    warranty_days: 30,
    stock_policy: stockPolicy,
    sort_order: 1,
    fulfillment_type: fulfillmentType,
    available_quantity: availableQuantity,
    is_ready: ready,
  };
}

describe("catalog presenter stock-policy guard", () => {
  it("shows Buy Now for ready supported catalog routes", () => {
    for (const [policy, type] of [
      ["LOCAL_ONLY", "STOCK_ACCOUNT"],
      ["LOCAL_ONLY", "STOCK_CODE"],
      ["LOCAL_ONLY", "DIGITAL_FILE"],
      ["LOCAL_ONLY", "MANUAL_FULFILLMENT"],
      ["LOCAL_ONLY", "QUANTITY_STOCK"],
      ["LOCAL_ONLY", "UNLIMITED_SERVICE"],
      ["SUPPLIER_ONLY", "SUPPLIER_API"],
    ] as const) {
      const callbacks = presentVariantDetail(variant(policy, type), "buy:signed-callback")
        .buttons.flat()
        .map((b) => b.callbackData);
      expect(callbacks).toContain("buy:signed-callback");
    }
  });

  it("does not show Buy Now for unsupported, paused, or unready variants", () => {
    for (const row of [
      variant("SUPPLIER_ONLY", "STOCK_ACCOUNT"),
      variant("LOCAL_ONLY", "SUPPLIER_API"),
      variant("PAUSED", "STOCK_ACCOUNT"),
      variant("LOCAL_ONLY", "QUANTITY_STOCK", false, 0),
    ]) {
      const callbacks = presentVariantDetail(row, "buy:signed-callback")
        .buttons.flat()
        .map((b) => b.callbackData);
      expect(callbacks.some((callback) => callback.startsWith("buy:"))).toBe(false);
    }
  });

  it("renders zero quantity as visible stock text without a payable action", () => {
    const message = presentVariantDetail(
      variant("LOCAL_ONLY", "QUANTITY_STOCK", false, 0),
      "buy:signed-callback",
    );
    expect(message.text).toContain("🔴 Tình trạng: Hết hàng");
    expect(message.buttons.flat().some((button) => button.callbackData.startsWith("buy:"))).toBe(
      false,
    );
  });

  it("shows a restock subscription action for unavailable quantity stock", () => {
    const message = presentVariantDetail(
      variant("LOCAL_ONLY", "QUANTITY_STOCK", false, 0),
      "buy:signed-callback",
    );
    const callbacks = message.buttons.flat().map((button) => button.callbackData);

    expect(callbacks).toContain("rst:sub:variant-LOCAL_ONLY-QUANTITY_STOCK");
    expect(callbacks.some((callback) => callback.startsWith("buy:"))).toBe(false);
  });

  it("preserves Buy Now without restock action for available quantity stock", () => {
    const callbacks = presentVariantDetail(
      variant("LOCAL_ONLY", "QUANTITY_STOCK", true, 3),
      "buy:signed-callback",
    )
      .buttons.flat()
      .map((button) => button.callbackData);

    expect(callbacks).toContain("buy:signed-callback");
    expect(callbacks.some((callback) => callback.startsWith("rst:sub:"))).toBe(false);
  });

  it("does not render an unsigned Buy Now action", () => {
    const callbacks = presentVariantDetail(variant("LOCAL_ONLY"))
      .buttons.flat()
      .map((button) => button.callbackData);
    expect(callbacks.some((callback) => callback.startsWith("buy:"))).toBe(false);
  });

  it("offers restock and, when preorder is enabled, a deposit hold without a dead end", () => {
    const message = presentVariantDetail({
      ...variant("LOCAL_ONLY", "STOCK_ACCOUNT", false, 0),
      preorder_enabled: true,
    });
    const callbacks = message.buttons.flat().map((button) => button.callbackData);

    expect(callbacks).toContain("rst:sub:variant-LOCAL_ONLY-STOCK_ACCOUNT");
    expect(callbacks).toContain("preorder:consent:variant-LOCAL_ONLY-STOCK_ACCOUNT");
    expect(message.text).toContain("🔴 Tình trạng: Hết hàng");
    expect(message.text).not.toContain("Tạm hết hàng");
  });

  it("renders the chosen variant with Mua ngay, support and recovery rows", () => {
    const message = presentVariantDetail(
      { ...variant("LOCAL_ONLY"), category_id: "cat-1" },
      "buy:signed-callback",
    );

    expect(message.buttons).toEqual([
      [{ text: "🛒 Mua ngay", callbackData: "buy:signed-callback" }],
      [{ text: "💬 Hỗ trợ", callbackData: "supp:open" }],
      [expect.objectContaining({ text: "👨‍💻 Liên hệ Admin" })],
      [{ text: "⬅️ Quay lại", callbackData: "cat:view:cat-1" }],
      [{ text: "🏠 Trang chủ", callbackData: "shop:home" }],
    ]);
  });
});

function detailView(variants: CatalogVariantRow[]): ProductDetailView {
  return {
    id: "product-1",
    name_vi: "Claude Pro",
    slug: "claude-pro",
    short_description_vi: "Tài khoản Claude Pro chính chủ.",
    description_vi: "Mô tả chi tiết.",
    what_customer_receives_vi: "Email + mật khẩu",
    usage_instructions_vi: "Đăng nhập tại claude.ai",
    delivery_eta_vi: null,
    warranty_vi: "Bảo hành 30 ngày",
    support_vi: null,
    category_id: "cat-1",
    category_name: "Claude",
    parent_category_id: null,
    parent_category_name: null,
    stock_display_mode: null,
    variants,
  };
}

describe("catalog product detail copy", () => {
  it("renders the contract headings, stock state and recovery rows", () => {
    const sellable = variant("LOCAL_ONLY", "MANUAL_FULFILLMENT", true, 2);
    const message = presentProductDetail(detailView([sellable]), {
      [sellable.id]: "buy:signed-callback",
    });

    for (const heading of ["📝 MÔ TẢ", "📦 BẠN NHẬN ĐƯỢC", "📘 HƯỚNG DẪN", "🛡 BẢO HÀNH"]) {
      expect(message.text).toContain(heading);
    }
    expect(message.text).toContain("💰 Giá từ: ");
    expect(message.text).toContain("🟡 Tình trạng: Sắp hết hàng");
    expect(message.text).toContain("⚡ Giao hàng: Nhân viên xử lý");
    expect(message.text).not.toContain("Tạm hết hàng");
    expect(message.text).not.toContain("MANUAL_FULFILLMENT");

    expect(
      message.buttons.flat().find((button) => button.callbackData === "buy:signed-callback")?.text,
    ).toMatch(/^Gói 1 tháng · 100\.000\s₫$/u);
    expect(message.buttons).toContainEqual([{ text: "💬 Hỗ trợ", callbackData: "supp:open" }]);
    expect(message.buttons).toContainEqual([{ text: "⬅️ Claude", callbackData: "cat:view:cat-1" }]);
    expect(message.buttons).toContainEqual([{ text: "🏠 Trang chủ", callbackData: "shop:home" }]);
  });

  it("keeps restock and, when enabled, a deposit hold on an out-of-stock variant", () => {
    const soldOut = { ...variant("LOCAL_ONLY", "STOCK_ACCOUNT", false, 0), preorder_enabled: true };
    const message = presentProductDetail(detailView([soldOut]), {});
    const callbacks = message.buttons.flat().map((button) => button.callbackData);

    expect(message.text).toContain("🔴 Tình trạng: Hết hàng");
    expect(callbacks).toContain(`rst:sub:${soldOut.id}`);
    expect(callbacks).toContain(`preorder:consent:${soldOut.id}`);
    expect(callbacks.some((callback) => callback.startsWith("buy:"))).toBe(false);
  });
});

describe("catalog search empty state", () => {
  it("renders the exact empty copy with retry and home only", () => {
    const message = presentSearchResults([], null);

    expect(message.text).toBe("Không tìm thấy sản phẩm phù hợp.");
    expect(message.buttons.flat().map((button) => button.text)).toEqual([
      "🔎 Tìm lại",
      "🏠 Trang chủ",
    ]);
    expect(message.buttons.flat().map((button) => button.callbackData)).toEqual([
      "cat:search",
      "menu:main",
    ]);
  });
});
