/**
 * Warranty proration (goal: warranty / defect report / prorated refund).
 *
 * Owner policy: warranty runs on REMAINING USABLE TIME, and the refund is the paid amount for the
 * affected order line prorated by the unused whole days of warranty.
 *
 *   used_days      = floor((reported_at - warranty_start) / 24h)      (elapsed 24-hour periods)
 *   remaining_days = clamp(warranty_days - used_days, 0, warranty_days)
 *   refund         = round(paid_amount_vnd * remaining_days / warranty_days)
 *
 * Three properties this module exists to guarantee:
 *
 * 1. **The report time is the only clock.** `reportedAt` is the customer's first valid submission.
 *    Nothing here accepts an admin review, approval or payout time, so a slow review can never
 *    shrink what the customer is owed — that is structural, not a convention.
 * 2. **Whole 24-hour periods, no calendar.** Warranty starts at fulfilment, so a local-midnight
 *    boundary would silently move the refund by a day around DST or a late-evening delivery.
 * 3. **Integer VND.** The money is computed in BigInt with half-up rounding; no float ever holds a
 *    currency amount.
 */

/** One day, in milliseconds. Elapsed periods are measured against this, never a calendar date. */
export const DAY_MS = 24 * 60 * 60 * 1000;

export interface WarrantyTerms {
  /** Warranty length in whole days, as snapshotted on the order line at purchase. */
  warrantyDays: number;
  /** Start of the warranty: the fulfilment time, not the order or payment time. */
  warrantyStart: Date;
}

export interface ProratedRefundInput extends WarrantyTerms {
  /** What the customer actually paid for the affected order line, in VND. */
  paidAmountVnd: bigint;
  /** The customer's first valid report time. The only clock this calculation reads. */
  reportedAt: Date;
}

export interface ProratedRefund {
  warrantyStart: string;
  warrantyEnd: string;
  reportedAt: string;
  usedDays: number;
  remainingDays: number;
  paidAmountVnd: bigint;
  /** Half-up rounded. Zero once the warranty has fully run out. */
  refundVnd: bigint;
}

export function warrantyEndOf(terms: WarrantyTerms): Date {
  return new Date(terms.warrantyStart.getTime() + Math.max(0, terms.warrantyDays) * DAY_MS);
}

/**
 * Whole elapsed warranty periods at the report time. A report before the start counts as zero
 * rather than a negative day, and a partially elapsed day does not count yet.
 */
export function usedDaysAt(terms: WarrantyTerms, at: Date): number {
  const elapsedMs = at.getTime() - terms.warrantyStart.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.floor(elapsedMs / DAY_MS);
}

export function computeProratedRefund(input: ProratedRefundInput): ProratedRefund {
  const warrantyDays = Math.max(0, Math.trunc(input.warrantyDays));
  const usedDays = usedDaysAt(input, input.reportedAt);
  const remainingDays = Math.max(0, Math.min(warrantyDays - usedDays, warrantyDays));
  const paidAmountVnd = input.paidAmountVnd < 0n ? 0n : input.paidAmountVnd;
  return {
    warrantyStart: input.warrantyStart.toISOString(),
    warrantyEnd: warrantyEndOf({ warrantyDays, warrantyStart: input.warrantyStart }).toISOString(),
    reportedAt: input.reportedAt.toISOString(),
    usedDays,
    remainingDays,
    paidAmountVnd,
    refundVnd: prorateAmountVnd(paidAmountVnd, remainingDays, warrantyDays),
  };
}

/**
 * `paid * remaining / total`, rounded half-up, in BigInt. Doubling the numerator and adding the
 * denominator gives exact half-up rounding without ever converting the amount to a float.
 */
export function prorateAmountVnd(
  paid: bigint,
  remainingDays: number,
  warrantyDays: number,
): bigint {
  const total = BigInt(Math.max(0, Math.trunc(warrantyDays)));
  const remaining = BigInt(Math.max(0, Math.trunc(remainingDays)));
  if (total === 0n || remaining === 0n) return 0n;
  const amount = paid < 0n ? 0n : paid;
  return (amount * remaining * 2n + total) / (total * 2n);
}

/** True while a report submitted at `at` still falls inside the warranty window. */
export function isWithinWarranty(terms: WarrantyTerms, at: Date): boolean {
  return at.getTime() < warrantyEndOf(terms).getTime();
}
