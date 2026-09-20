import { describe, expect, it } from "vitest";
import { presentStockOutcome, CATALOG_COPY } from "../../src/bot/presenters/catalog.js";
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

  it("has exactly one distinct presenter copy for every exported stock outcome code", () => {
    const copies = [...STOCK_LOSER_CODES].map((code) => presentStockOutcome(code).text);
    expect(copies).toHaveLength(STOCK_LOSER_CODES.size);
    expect(new Set(copies).size).toBe(STOCK_LOSER_CODES.size);
  });
});
