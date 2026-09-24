import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  calculatePromotionDiscount,
  normalizePromoCode,
} from "../../src/modules/promotions/service.js";

describe("promotion helpers", () => {
  it("normalizes safe customer-entered codes", () => {
    expect(normalizePromoCode("  spring_20 ")).toBe("SPRING_20");
    expect(normalizePromoCode("x")).toBeNull();
    expect(normalizePromoCode("SAVE 20")).toBeNull();
  });

  it("never discounts a free order", () => {
    expect(calculatePromotionDiscount(100_000n, "FIXED_VND", 150_000n, null)).toBe(99_999n);
    expect(calculatePromotionDiscount(100_000n, "PERCENT", null, 20)).toBe(20_000n);
    expect(calculatePromotionDiscount(100_000n, "PERCENT", null, 110)).toBe(99_999n);
  });
  it("keeps every integer discount bounded below the order total", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 15n }),
        fc.integer({ min: 1, max: 100 }),
        (baseAmountVnd, valuePercent) => {
          const discount = calculatePromotionDiscount(baseAmountVnd, "PERCENT", null, valuePercent);
          expect(discount).toBeGreaterThanOrEqual(0n);
          expect(discount).toBeLessThan(baseAmountVnd);
          expect(baseAmountVnd - discount).toBeGreaterThan(0n);
        },
      ),
    );
  });
});
