import { describe, expect, it } from "vitest";
import { presentVariantDetail } from "../../src/bot/presenters/catalog.js";
import type { CatalogVariantRow } from "../../src/modules/catalog/repository.js";

function variant(stockPolicy: CatalogVariantRow["stock_policy"]): CatalogVariantRow {
  return {
    id: `variant-${stockPolicy}`,
    product_id: "product-1",
    product_name_vi: "Sản phẩm",
    sku: `SKU-${stockPolicy}`,
    name_vi: "Gói 1 tháng",
    price_vnd: "100000",
    duration_code: "P1M",
    delivery_type: "LICENSE",
    warranty_days: 30,
    stock_policy: stockPolicy,
    sort_order: 1,
  };
}

describe("catalog presenter stock-policy guard", () => {
  it("shows Buy Now only for Feature 001 allowlisted policies", () => {
    for (const policy of ["LOCAL_ONLY", "LOCAL_THEN_SUPPLIER"] as const) {
      const callbacks = presentVariantDetail(variant(policy), "buy:signed-callback")
        .buttons.flat()
        .map((b) => b.callbackData);
      expect(callbacks).toContain("buy:signed-callback");
    }
  });

  it("does not show Buy Now for supplier-only or paused variants", () => {
    for (const policy of ["SUPPLIER_ONLY", "PAUSED"] as const) {
      const callbacks = presentVariantDetail(variant(policy), "buy:signed-callback")
        .buttons.flat()
        .map((b) => b.callbackData);
      expect(callbacks.some((callback) => callback.startsWith("buy:"))).toBe(false);
    }
  });

  it("does not render an unsigned Buy Now action", () => {
    const callbacks = presentVariantDetail(variant("LOCAL_ONLY"))
      .buttons.flat()
      .map((button) => button.callbackData);
    expect(callbacks.some((callback) => callback.startsWith("buy:"))).toBe(false);
  });
});
