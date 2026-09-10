export const WALLET_TOPUP_PREFIX = "NAPVI";
export const ORDER_PAYMENT_PREFIX = "ORD";
/** Preorder deposit leg ("cọc"). */
export const PREORDER_DEPOSIT_PREFIX = "COC";
/** Preorder remaining-balance leg ("còn lại"). */
export const PREORDER_BALANCE_PREFIX = "CON";

export type PaymentCodeFamily = "WALLET_TOPUP" | "ORDER" | "PREORDER" | "UNKNOWN";
export type PreorderPaymentLeg = "DEPOSIT" | "BALANCE";

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

export function generateOrderPaymentCode(orderNumber: string): string {
  const suffix = orderNumber
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .slice(-12);
  if (suffix.length !== 12) throw new Error("ORDER_PAYMENT_CODE_INVALID_SOURCE");
  return `${ORDER_PAYMENT_PREFIX}${suffix}`;
}

export function isOrderPaymentCode(value: string | null | undefined): boolean {
  return /^ORD[A-Z0-9]{12}$/.test(normalize(value));
}

/**
 * Transfer content for a preorder leg. Deterministic in (reservation, leg) so the customer can
 * re-open the same QR without ever seeing two competing payment codes, and so SePay evidence
 * resolves back to exactly one reservation. The leg prefix keeps the deposit and the balance
 * codes distinct — a bank transfer can never be applied to the wrong leg.
 */
export function generatePreorderPaymentCode(
  reservationId: string,
  leg: PreorderPaymentLeg,
): string {
  const suffix = reservationId
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .slice(-12);
  if (suffix.length !== 12) throw new Error("PREORDER_PAYMENT_CODE_INVALID_SOURCE");
  return `${leg === "DEPOSIT" ? PREORDER_DEPOSIT_PREFIX : PREORDER_BALANCE_PREFIX}${suffix}`;
}

export function classifyPaymentCode(value: string | null | undefined): PaymentCodeFamily {
  const code = normalize(value);
  if (/^NAPVI[A-Z0-9]+$/.test(code)) return "WALLET_TOPUP";
  if (/^ORD[A-Z0-9]+$/.test(code)) return "ORDER";
  if (/^(?:COC|CON)[A-Z0-9]{12}$/.test(code)) return "PREORDER";
  return "UNKNOWN";
}
