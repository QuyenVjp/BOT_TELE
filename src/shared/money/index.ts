/**
 * Integer VND money (data-model.md Conventions).
 *
 * - Values are `bigint` — no floats, no silent rounding, `bigint`-safe range.
 * - Amounts are non-negative (this MVP never represents negative balances;
 *   refunds/adjustments are modelled as separate signed ledger events, not Money).
 * - Construction validates: any float, NaN, or negative input is rejected.
 * - Rendering uses the `vi-VN` locale with the ₫ unit.
 */

/** Opaque, branded integer-VND amount. Construct only via {@link makeVnd}. */
export type Vnd = bigint & { readonly __brand: "Vnd" };

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * Construct a validated VND amount. Accepts a `bigint`, or an integer `number`
 * that is a safe integer (guards against float/NaN slipping through untyped call
 * sites). Rejects negatives, fractionals, and non-finite inputs.
 */
export function makeVnd(amount: bigint | number): Vnd {
  let value: bigint;
  if (typeof amount === "bigint") {
    value = amount;
  } else if (typeof amount === "number") {
    if (!Number.isFinite(amount)) {
      throw new MoneyError("VND amount must be a finite number");
    }
    if (!Number.isInteger(amount)) {
      throw new MoneyError("VND amount must be an integer (no fractional VND)");
    }
    if (!Number.isSafeInteger(amount)) {
      throw new MoneyError("VND number amount exceeds safe integer range; pass a bigint");
    }
    value = BigInt(amount);
  } else {
    throw new MoneyError("VND amount must be a bigint or integer number");
  }
  if (value < 0n) {
    throw new MoneyError("VND amount must be non-negative");
  }
  return value as Vnd;
}

export function addVnd(a: Vnd, b: Vnd): Vnd {
  return makeVnd((a as bigint) + (b as bigint));
}

/** Subtraction that would underflow below zero is rejected (no silent wrap). */
export function subtractVnd(a: Vnd, b: Vnd): Vnd {
  const result = (a as bigint) - (b as bigint);
  if (result < 0n) {
    throw new MoneyError("VND subtraction would produce a negative amount");
  }
  return result as Vnd;
}

export function isZeroVnd(a: Vnd): boolean {
  return (a as bigint) === 0n;
}

/** Total order: -1 if a<b, 0 if equal, 1 if a>b. */
export function compareVnd(a: Vnd, b: Vnd): -1 | 0 | 1 {
  const av = a as bigint;
  const bv = b as bigint;
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

export function equalsVnd(a: Vnd, b: Vnd): boolean {
  return compareVnd(a, b) === 0;
}

/** Raw bigint accessor for persistence/serialization boundaries. */
export function vndToNumber(a: Vnd): bigint {
  return a as bigint;
}

const vndFormatter = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

/** Human-facing vi-VN rendering, e.g. "1.500.000 ₫". */
export function formatVnd(a: Vnd): string {
  // Intl only accepts number/bigint; bigint keeps full precision here.
  return vndFormatter.format(a as bigint);
}
