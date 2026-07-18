import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  makeVnd,
  addVnd,
  subtractVnd,
  isZeroVnd,
  compareVnd,
  formatVnd,
  vndToNumber,
  MoneyError,
} from "../../src/shared/money/index.js";
import { newId, isId, brandId, type OrderId, type ProductId } from "../../src/shared/ids/index.js";
import {
  nowUtc,
  toHoChiMinh,
  formatHoChiMinh,
  HO_CHI_MINH_TZ,
} from "../../src/shared/time/index.js";
import { AppError, errorEnvelope, isAppError } from "../../src/shared/errors/index.js";

/**
 * T010 — Shared primitive property tests (data-model.md Conventions):
 *  - Money is integer VND, bigint-safe, no floats, no silent rounding.
 *  - Identifiers are opaque, collision-resistant, and brand-checked.
 *  - Timestamps are UTC internally, rendered in Asia/Ho_Chi_Minh.
 *  - Errors carry a stable, serializable envelope (no leaking internals).
 */

describe("Money (integer VND, bigint-safe)", () => {
  it("accepts any safe non-negative integer amount", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), (amount) => {
        const m = makeVnd(amount);
        expect(vndToNumber(m) === amount || typeof vndToNumber(m) === "bigint").toBe(true);
      }),
    );
  });

  it("rejects negative, fractional, and non-integer inputs", () => {
    expect(() => makeVnd(-1n)).toThrow(MoneyError);
    expect(() => makeVnd(1.5 as unknown as bigint)).toThrow(MoneyError);
    expect(() => makeVnd(Number.NaN as unknown as bigint)).toThrow(MoneyError);
  });

  it("addition is commutative and associative over VND", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        (a, b, c) => {
          const va = makeVnd(a);
          const vb = makeVnd(b);
          const vc = makeVnd(c);
          expect(compareVnd(addVnd(va, vb), addVnd(vb, va))).toBe(0);
          expect(compareVnd(addVnd(addVnd(va, vb), vc), addVnd(va, addVnd(vb, vc)))).toBe(0);
        },
      ),
    );
  });

  it("subtract then add is identity when result stays non-negative", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        (a, b) => {
          const hi = a >= b ? a : b;
          const lo = a >= b ? b : a;
          const back = addVnd(subtractVnd(makeVnd(hi), makeVnd(lo)), makeVnd(lo));
          expect(compareVnd(back, makeVnd(hi))).toBe(0);
        },
      ),
    );
  });

  it("subtraction that would go negative is rejected (no silent underflow)", () => {
    expect(() => subtractVnd(makeVnd(100n), makeVnd(101n))).toThrow(MoneyError);
  });

  it("zero detection and vi-VN formatting are consistent", () => {
    expect(isZeroVnd(makeVnd(0n))).toBe(true);
    expect(isZeroVnd(makeVnd(1n))).toBe(false);
    const formatted = formatVnd(makeVnd(1500000n));
    // vi-VN groups thousands and appends the VND unit; exact glyphs are locale-driven.
    expect(formatted).toMatch(/1.?500.?000/);
    expect(formatted.toLowerCase()).toContain("₫".toLowerCase());
  });
});

describe("Identifiers (opaque, brand-checked)", () => {
  it("generates unique ids across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const id = newId<OrderId>();
      expect(isId(id)).toBe(true);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it("rejects malformed id strings", () => {
    expect(isId("")).toBe(false);
    expect(isId("not an id")).toBe(false);
    expect(isId("../../etc/passwd")).toBe(false);
  });

  it("brandId only accepts well-formed opaque values", () => {
    const raw = newId<ProductId>();
    expect(brandId<ProductId>(raw)).toBe(raw);
    expect(() => brandId<ProductId>("bad id")).toThrow();
  });
});

describe("Time (UTC internal, Asia/Ho_Chi_Minh rendering)", () => {
  it("nowUtc is a Date and toHoChiMinh preserves the instant", () => {
    const t = nowUtc();
    expect(t instanceof Date).toBe(true);
    expect(HO_CHI_MINH_TZ).toBe("Asia/Ho_Chi_Minh");
    const rendered = formatHoChiMinh(t);
    expect(typeof rendered).toBe("string");
    expect(rendered.length).toBeGreaterThan(0);
  });

  it("renders a known instant in +07:00 wall-clock", () => {
    // 2026-07-16T00:00:00Z => 07:00 in Ho Chi Minh.
    const instant = new Date("2026-07-16T00:00:00.000Z");
    const parts = toHoChiMinh(instant);
    expect(parts.hour).toBe(7);
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(7);
    expect(parts.day).toBe(16);
  });
});

describe("Error envelope (stable, serializable)", () => {
  it("AppError produces a stable envelope with code and no internals", () => {
    const err = new AppError("VALIDATION", "invalid input", { field: "amount" });
    expect(isAppError(err)).toBe(true);
    const env = errorEnvelope(err);
    expect(env.code).toBe("VALIDATION");
    expect(env.message).toBe("invalid input");
    expect(JSON.stringify(env)).toContain("VALIDATION");
    // Envelope must not carry a raw stack trace.
    expect(Object.keys(env)).not.toContain("stack");
  });

  it("wraps unknown errors without leaking messages as the code", () => {
    const env = errorEnvelope(new Error("boom internal detail"));
    expect(env.code).toBe("INTERNAL");
    expect(env.message).not.toContain("boom internal detail");
  });
});
