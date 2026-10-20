import { describe, expect, it } from "vitest";
import { presentStockOutcome, CATALOG_COPY } from "../../src/bot/presenters/catalog.js";
import type { CatalogVariantRow } from "../../src/modules/catalog/repository.js";
import { STOCK_LOSER_CODES } from "../../src/modules/commerce/buy-now.js";

/**
 * T157 / FR-006b — Last-unit loser presenter.
 *
 * A buyer who lost the final local unit must see truthful copy (no
 * payment-success wording) and be given real recovery actions, not a dead end.
 */

function buttonTexts(msg: { buttons: { text: string; callbackData: string }[][] }): string[] {
  return msg.buttons.flat().map((b) => b.text);
}

function buttonData(msg: { buttons: { text: string; callbackData: string }[][] }): string[] {
  return msg.buttons.flat().map((b) => b.callbackData);
}

function liveVariant(overrides: Partial<CatalogVariantRow> = {}): CatalogVariantRow {
  return {
    id: "variant-live",
    product_id: "product-live",
    product_name_vi: "Sản phẩm",
    sku: "SKU-LIVE",
    name_vi: "Gói 1 tháng",
    price_vnd: "100000",
    duration_code: "P1M",
    delivery_type: "LICENSE",
    warranty_days: 30,
    stock_policy: "LOCAL_ONLY",
    sort_order: 1,
    fulfillment_type: "STOCK_ACCOUNT",
    available_quantity: 0,
    is_ready: false,
    preorder_enabled: false,
    ...overrides,
  };
}

describe("typed stock outcome presenter (FR-006b)", () => {
  const expected = {
    NO_STOCK: "Sản phẩm hiện đã hết hàng. Bạn chưa bị trừ tiền và chưa có phiên thanh toán.",
    RESERVATION_LOST:
      "Sản phẩm cuối vừa được khách khác đặt trước. Bạn chưa bị trừ tiền và chưa có phiên thanh toán.",
    CONTENTION_TIMEOUT:
      "Đang có nhiều người đặt sản phẩm này. Vui lòng thử lại sau vài giây. Bạn chưa bị trừ tiền và chưa có phiên thanh toán.",
  } as const;

  for (const [code, exactCopy] of Object.entries(expected)) {
    it(`renders exactly one truthful ${code} message`, () => {
      const msg = presentStockOutcome(code as keyof typeof expected);
      expect(msg.text).toBe(exactCopy);
      expect((msg.text.match(/chưa bị trừ tiền/gi) ?? []).length).toBe(1);
      expect(msg.text.toLowerCase()).not.toContain("đã thanh toán");
      expect(msg.text.toLowerCase()).not.toContain("thành công");
    });
  }

  it("offers only routed, semantically distinct actions", () => {
    const msg = presentStockOutcome("NO_STOCK");
    expect(msg.buttons).toEqual([
      [{ text: CATALOG_COPY.viewAlternatives, callbackData: "cat:list" }],
      [{ text: CATALOG_COPY.mainMenu, callbackData: "menu:main" }],
    ]);
    expect(buttonTexts(msg)).toEqual([CATALOG_COPY.viewAlternatives, CATALOG_COPY.mainMenu]);
    expect(buttonData(msg)).toEqual(["cat:list", "menu:main"]);
    expect(new Set(buttonData(msg)).size).toBe(buttonData(msg).length);
    expect(buttonData(msg).some((data) => data.startsWith("stock:notify:"))).toBe(false);
  });

  it("uses restock subscription for an unavailable local finite live variant", () => {
    const variant = liveVariant({ id: "variant-restock" });
    const msg = presentStockOutcome("NO_STOCK", variant);
    const callbacks = buttonData(msg);

    expect(msg.text).toBe(expected.NO_STOCK);
    expect(callbacks.filter((data) => data.startsWith("rst:sub:"))).toEqual([
      `rst:sub:${variant.id}`,
    ]);
    expect(callbacks.some((data) => data.startsWith("preorder:consent:"))).toBe(false);
  });

  it("uses preorder consent instead of restock for an eligible preorder live variant", () => {
    const variant = liveVariant({ id: "variant-preorder", preorder_enabled: true });
    const msg = presentStockOutcome("NO_STOCK", variant);
    const callbacks = buttonData(msg);

    expect(msg.text).toBe(expected.NO_STOCK);
    expect(callbacks.filter((data) => data.startsWith("preorder:consent:"))).toEqual([
      `preorder:consent:${variant.id}`,
    ]);
    expect(callbacks.some((data) => data.startsWith("rst:sub:"))).toBe(false);
  });

  it("omits recovery actions for ready, unsupported, or non-local live variants", () => {
    const variants = [
      liveVariant({ id: "variant-ready", is_ready: true, preorder_enabled: true }),
      liveVariant({ id: "variant-unsupported", fulfillment_type: "SUPPLIER_API" }),
      liveVariant({
        id: "variant-non-local",
        stock_policy: "SUPPLIER_ONLY",
        fulfillment_type: "SUPPLIER_API",
      }),
    ];

    for (const variant of variants) {
      const msg = presentStockOutcome("CONTENTION_TIMEOUT", variant);
      const callbacks = buttonData(msg);

      expect(msg.text).toBe(expected.CONTENTION_TIMEOUT);
      expect(
        callbacks.some(
          (data) => data.startsWith("rst:sub:") || data.startsWith("preorder:consent:"),
        ),
      ).toBe(false);
    }
  });

  it("has exactly one distinct presenter copy for every exported stock outcome code", () => {
    const copies = [...STOCK_LOSER_CODES].map((code) => presentStockOutcome(code).text);
    expect(copies).toHaveLength(STOCK_LOSER_CODES.size);
    expect(new Set(copies).size).toBe(STOCK_LOSER_CODES.size);
  });
});
