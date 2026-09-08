export const WALLET_TOPUP_PREFIX = "NAPVI";
export const ORDER_PAYMENT_PREFIX = "ORD";

export type PaymentCodeFamily = "WALLET_TOPUP" | "ORDER" | "UNKNOWN";

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

export function generateOrderPaymentCode(orderNumber: string): string {
  const suffix = orderNumber.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(-12);
  if (suffix.length !== 12) throw new Error("ORDER_PAYMENT_CODE_INVALID_SOURCE");
  return `${ORDER_PAYMENT_PREFIX}${suffix}`;
}

export function isOrderPaymentCode(value: string | null | undefined): boolean {
  return /^ORD[A-Z0-9]{12}$/.test(normalize(value));
}

export function classifyPaymentCode(value: string | null | undefined): PaymentCodeFamily {
  const code = normalize(value);
  if (/^NAPVI[A-Z0-9]+$/.test(code)) return "WALLET_TOPUP";
  if (/^ORD[A-Z0-9]+$/.test(code)) return "ORDER";
  return "UNKNOWN";
}
