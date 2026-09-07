import { describe, expect, it } from "vitest";
import { presentVariantDetail } from "../../src/bot/presenters/catalog.js";
import type { CatalogVariantRow } from "../../src/modules/catalog/repository.js";

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
    expect(message.text).toContain("Tồn kho: 0");
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
});
