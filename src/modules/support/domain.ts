/**
 * SupportTicket aggregate: reasons, states, SLA, and safe-summary policy
 * (T085, FR-019).
 *
 * A ticket is a structured customer issue optionally linked to an Order. It
 * carries a reason code, a status, and a "safe summary" that is guaranteed free
 * of raw secrets. The support domain deliberately owns NO payment/delivery
 * capability — it can never mark paid, mutate evidence, refund, or reveal a
 * secret.
 */

export type SupportReasonCode =
  | "ASSET_NOT_WORKING"
  | "PAYMENT_QUESTION"
  | "DELIVERY_NOT_RECEIVED"
  | "REFUND_REQUEST"
  | "GENERAL_QUESTION"
  | "OTHER";

export type SupportTicketStatus =
  "OPEN" | "WAITING_SHOP" | "WAITING_CUSTOMER" | "RESOLVED" | "CLOSED" | "MANUAL_REVIEW";

export const SUPPORT_REASON_CODES: readonly SupportReasonCode[] = [
  "ASSET_NOT_WORKING",
  "PAYMENT_QUESTION",
  "DELIVERY_NOT_RECEIVED",
  "REFUND_REQUEST",
  "GENERAL_QUESTION",
  "OTHER",
];

export function isSupportReasonCode(value: string): value is SupportReasonCode {
  return (SUPPORT_REASON_CODES as readonly string[]).includes(value);
}

/** SLA hours per reason — drives the ticket `due_at`. */
const SLA_HOURS: Record<SupportReasonCode, number> = {
  ASSET_NOT_WORKING: 12,
  PAYMENT_QUESTION: 24,
  DELIVERY_NOT_RECEIVED: 12,
  REFUND_REQUEST: 48,
  GENERAL_QUESTION: 48,
  OTHER: 48,
};

export function slaDueAt(reason: SupportReasonCode, from: Date): Date {
  return new Date(from.getTime() + SLA_HOURS[reason] * 3_600_000);
}

const ALLOWED: Record<SupportTicketStatus, readonly SupportTicketStatus[]> = {
  OPEN: ["WAITING_SHOP", "WAITING_CUSTOMER", "RESOLVED", "MANUAL_REVIEW"],
  WAITING_SHOP: ["WAITING_CUSTOMER", "RESOLVED", "MANUAL_REVIEW"],
  WAITING_CUSTOMER: ["WAITING_SHOP", "RESOLVED", "MANUAL_REVIEW"],
  RESOLVED: ["CLOSED", "WAITING_CUSTOMER"],
  MANUAL_REVIEW: ["WAITING_SHOP", "RESOLVED"],
  CLOSED: [],
};

export function canTicketTransition(from: SupportTicketStatus, to: SupportTicketStatus): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

/**
 * Redact a customer-supplied description into a safe summary:
 *  - strip credential-shaped tokens (user:pass, emails with a password tail,
 *    long high-entropy runs);
 *  - collapse whitespace and cap length.
 *
 * This is defense-in-depth: customers should not paste secrets, but if they do,
 * the stored summary must not retain them (SR-001).
 */
export function toSafeSummary(description: string, maxLen = 500): string {
  let s = description.normalize("NFC");

  // user:pass or email:pass style credential pairs → [redacted]
  s = s.replace(/[^\s:@]+[:@][^\s:@]{4,}/g, (match) => {
    // Keep short handles (e.g. "8:30") but redact credential-length tails.
    return match.length >= 10 ? "[đã ẩn]" : match;
  });

  // Long high-entropy tokens (>=16 chars, mixed) → [redacted]
  s = s.replace(/\b[A-Za-z0-9!@#$%^&*_-]{16,}\b/g, "[đã ẩn]");

  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + "…";
  return s;
}
