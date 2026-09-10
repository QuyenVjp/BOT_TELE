import { describe, expect, it } from "vitest";
import {
  computeProratedRefund,
  isWithinWarranty,
  prorateAmountVnd,
  usedDaysAt,
  warrantyEndOf,
  DAY_MS,
} from "../../src/modules/warranty/proration.js";

const START = new Date("2026-09-10T03:00:00.000Z");
const atDay = (days: number) => new Date(START.getTime() + days * DAY_MS);
const terms = { warrantyDays: 30, warrantyStart: START };
const refundFor = (reportedAt: Date, paid = 100000n) =>
  computeProratedRefund({ ...terms, paidAmountVnd: paid, reportedAt });

/**
 * The refund is the customer's money, so the arithmetic is pinned to the owner's own worked
 * examples rather than to whatever the implementation happens to produce.
 */
describe("warranty proration", () => {
  it("matches the owner's example: 100.000 ₫ / 30 ngày, còn 12 ngày → 40.000 ₫", () => {
    expect(refundFor(atDay(18))).toMatchObject({ usedDays: 18, remainingDays: 12 });
    expect(refundFor(atDay(18)).refundVnd).toBe(40000n);
  });

  it.each([
    [0, 30, 100000n],
    [10, 20, 66667n],
    [18, 12, 40000n],
    [29, 1, 3333n],
    [30, 0, 0n],
  ])("after %i used days leaves %i and owes %s", (used, remaining, expected) => {
    const result = refundFor(atDay(used));
    expect(result.usedDays).toBe(used);
    expect(result.remainingDays).toBe(remaining);
    expect(result.refundVnd).toBe(expected);
  });

  // The report time is the only clock the calculation reads: a slow admin review cannot shrink the
  // amount, because no review/approval/payout time can even be passed in.
  it("depends on the report time alone, so a delayed review cannot reduce it", () => {
    const reported = refundFor(atDay(18));
    const muchLater = refundFor(atDay(18));
    expect(muchLater.refundVnd).toBe(reported.refundVnd);
    expect(Object.keys(reported)).not.toContain("reviewedAt");
    // and the report-time snapshot it stores is the one the customer submitted
    expect(reported.reportedAt).toBe(atDay(18).toISOString());
  });

  it("counts whole elapsed 24h periods, not calendar days", () => {
    expect(usedDaysAt(terms, new Date(START.getTime() + DAY_MS - 1))).toBe(0);
    expect(usedDaysAt(terms, atDay(1))).toBe(1);
    // a late-evening delivery must not lose a day to a local midnight boundary
    const lateDelivery = new Date("2026-09-10T23:30:00.000Z");
    const lateTerms = { warrantyDays: 30, warrantyStart: lateDelivery };
    expect(usedDaysAt(lateTerms, new Date(lateDelivery.getTime() + DAY_MS - 1))).toBe(0);
    expect(usedDaysAt(lateTerms, new Date(lateDelivery.getTime() + DAY_MS))).toBe(1);
  });

  it("treats a report before the start as zero used days, and clamps at the end", () => {
    expect(usedDaysAt(terms, new Date(START.getTime() - DAY_MS)).valueOf()).toBe(0);
    expect(refundFor(atDay(0)).remainingDays).toBe(30);
    expect(refundFor(atDay(999)).refundVnd).toBe(0n);
  });

  it("keeps the expiry boundary exact", () => {
    const end = warrantyEndOf(terms);
    expect(end.toISOString()).toBe(atDay(30).toISOString());
    expect(isWithinWarranty(terms, new Date(end.getTime() - 1))).toBe(true);
    expect(isWithinWarranty(terms, end)).toBe(false);
    // reported before expiry, still inside the window even though a review may happen later
    expect(isWithinWarranty(terms, atDay(29))).toBe(true);
  });

  it("rounds half up and never uses a float for money", () => {
    expect(prorateAmountVnd(100000n, 1, 3)).toBe(33333n);
    expect(prorateAmountVnd(1n, 1, 2)).toBe(1n); // 0.5 → 1
    expect(prorateAmountVnd(999999999n, 12, 30)).toBe(400000000n);
    expect(prorateAmountVnd(100000n, 0, 30)).toBe(0n);
  });

  it("treats a zero-day warranty as owing nothing rather than dividing by zero", () => {
    expect(
      computeProratedRefund({
        warrantyDays: 0,
        warrantyStart: START,
        paidAmountVnd: 100000n,
        reportedAt: atDay(1),
      }).refundVnd,
    ).toBe(0n);
  });
});
