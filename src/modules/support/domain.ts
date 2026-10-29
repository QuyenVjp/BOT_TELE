import { isPublicOrderNumber } from "../../shared/order-number/index.js";

/**
 * SupportTicket aggregate: reasons, states, SLA, and safe-summary policy
 * (T085, FR-019).
 *
 * A ticket is a structured customer issue optionally linked to an Order. It
 * carries a reason code, a status, and a bounded summary with common-pattern
 * redaction. The summary is not a proof that arbitrary secrets were removed.
 * The support domain deliberately owns NO payment/delivery capability — it can
 * never mark paid, mutate evidence, refund, or reveal a secret.
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

const SUPPORT_TICKET_STATUS_CODES: Record<SupportTicketStatus, string> = {
  OPEN: "o",
  WAITING_SHOP: "s",
  WAITING_CUSTOMER: "c",
  RESOLVED: "r",
  CLOSED: "x",
  MANUAL_REVIEW: "m",
};

const SUPPORT_TICKET_STATUSES_BY_CODE: Record<string, SupportTicketStatus> = Object.fromEntries(
  Object.entries(SUPPORT_TICKET_STATUS_CODES).map(([status, code]) => [code, status]),
) as Record<string, SupportTicketStatus>;

export function supportTicketStatusCode(status: SupportTicketStatus): string {
  return SUPPORT_TICKET_STATUS_CODES[status];
}

export function supportTicketStatusFromCode(code: string): SupportTicketStatus | undefined {
  return SUPPORT_TICKET_STATUSES_BY_CODE[code];
}
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
 * Redact a customer-supplied description into a bounded summary:
 *  - strip common credential-shaped tokens (user:pass, emails with a password
 *    tail, long high-entropy runs);
 *  - strip controls/default-ignorables, collapse whitespace, and cap length.
 *
 * This is defense-in-depth, not a complete secret detector. Customers should
 * not paste secrets, and callers must not treat the result as a guarantee that
 * arbitrary secret text was removed (SR-001).
 */
export function toSafeSummary(description: string, maxLen = 500): string {
  type Span = { start: number; end: number };

  const defaultIgnorable = /^\p{Default_Ignorable_Code_Point}$/u;
  const nonWhitespaceControl = /^\p{Cc}$/u;
  const combiningMark = /^\p{M}$/u;
  const viewStarts: number[] = [];
  const viewEnds: number[] = [];
  const viewParts: string[] = [];
  let cluster = "";
  let clusterStart = 0;
  let clusterEnd = 0;
  let sourceOffset = 0;

  const flushCluster = (): void => {
    if (cluster.length === 0) return;
    const normalized = cluster
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
      .replace(/\p{M}/gu, "");
    for (const character of normalized) {
      viewParts.push(character);
      for (let index = 0; index < character.length; index += 1) {
        viewStarts.push(clusterStart);
        viewEnds.push(clusterEnd);
      }
    }
    cluster = "";
  };

  for (const character of description) {
    const start = sourceOffset;
    sourceOffset += character.length;
    if (
      defaultIgnorable.test(character) ||
      (nonWhitespaceControl.test(character) && !/\s/u.test(character))
    ) {
      if (cluster.length > 0) clusterEnd = sourceOffset;
      continue;
    }
    if (combiningMark.test(character) && cluster.length > 0) {
      cluster += character;
      clusterEnd = sourceOffset;
      continue;
    }
    flushCluster();
    cluster = character;
    clusterStart = start;
    clusterEnd = sourceOffset;
  }
  flushCluster();

  const view = viewParts.join("");
  const toOriginalSpan = (start: number, end: number): Span | undefined => {
    if (end <= start) return undefined;
    const originalStart = viewStarts[start];
    const originalEnd = viewEnds[end - 1];
    if (originalStart === undefined || originalEnd === undefined) return undefined;
    return { start: originalStart, end: originalEnd };
  };
  const collectSpans = (pattern: RegExp, accept?: (match: RegExpMatchArray) => boolean): Span[] => {
    const spans: Span[] = [];
    for (const match of view.matchAll(pattern)) {
      if (accept && !accept(match)) continue;
      const span = toOriginalSpan(match.index, match.index + match[0].length);
      if (span) spans.push(span);
    }
    return spans;
  };

  const safeOrderLabelPattern = "(?<![\\p{L}\\p{N}_/@])mã(?:\\s+đơn)?\\s*:\\s*";
  const safeOrderPattern = `${safeOrderLabelPattern}(?<orderValue>[\\p{L}\\p{N}][\\p{L}\\p{N}._/-]*)(?=$|\\s|[.,;!?](?=\\s|$))`;
  const safeTimePattern =
    "(?<![\\p{L}\\p{N}_/@])time\\s*:\\s*(?:[01]?\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?(?=$|\\s|[.,;!?](?=\\s|$))";
  const shortNumericOrderPattern = /^[0-9]{1,8}$/u;
  const safeSpans = [
    ...collectSpans(new RegExp(safeOrderLabelPattern, "giu")),
    ...collectSpans(new RegExp(safeOrderPattern, "giu"), (match) => {
      const orderValue = match.groups?.orderValue;
      return (
        orderValue !== undefined &&
        (isPublicOrderNumber(orderValue.toUpperCase()) || shortNumericOrderPattern.test(orderValue))
      );
    }),
    ...collectSpans(new RegExp(safeTimePattern, "giu")),
  ].sort((left, right) => left.start - right.start);

  const emailLocalPart = "[\\p{L}\\p{M}\\p{N}._%+\\-]+";
  const emailDomain = "[\\p{L}\\p{M}\\p{N}.-]+";
  const emailPattern = `${emailLocalPart}@${emailDomain}`;
  const malformedEmailDomain = "[\\p{L}\\p{M}\\p{N}.-]*";
  const malformedEmailIdentity = `(?:@+${malformedEmailDomain}|${emailLocalPart}@${malformedEmailDomain}(?:@+${malformedEmailDomain})+)`;
  const credentialSeparator = "\\s*[:=]\\s*";
  const emailSpans = collectSpans(new RegExp(emailPattern, "giu"));
  const protectedSpans = [...safeSpans, ...emailSpans];
  const redactions: Span[] = [];
  const quote = `["'“”‘’\\x60]?`;
  const identityLabel = "(?:user|login|account)(?:\\s+(?:name|id))?";
  const passwordLabel = "(?:password|passwd|passcode|pwd|pw|pass\\s*word|mật\\s*khẩu|mk)";
  const labelWord = "[\\p{L}][\\p{L}\\p{N}._%+-]*";
  const quotedMultiWordLabel = `["'“”‘’\\x60]${labelWord}(?:\\s+${labelWord})+["'“”‘’\\x60]`;

  const scanValueEnd = (start: number): number | undefined => {
    if (
      start >= view.length ||
      view[start] === "\r" ||
      view[start] === "\n" ||
      view[start] === "\u2028" ||
      view[start] === "\u2029"
    )
      return undefined;
    const openingQuote = view[start];
    if (
      openingQuote === '"' ||
      openingQuote === "'" ||
      openingQuote === "`" ||
      openingQuote === "“" ||
      openingQuote === "‘"
    ) {
      const closingQuote = openingQuote === "“" ? "”" : openingQuote === "‘" ? "’" : openingQuote;
      for (let index = start + 1; index < view.length; index += 1) {
        if (view[index] === "\\") {
          index += 1;
        } else if (view[index] === closingQuote) {
          return index + 1;
        } else if (
          view[index] === "\r" ||
          view[index] === "\n" ||
          view[index] === "\u2028" ||
          view[index] === "\u2029"
        ) {
          return index;
        }
      }
      return view.length;
    }

    let end = start;
    while (end < view.length) {
      const character = view[end];
      // An unquoted semicolon is a clear boundary only before whitespace or end-of-input.
      // Without that boundary, consume the continuation so an ambiguous tail cannot leak.
      if (
        character === "\r" ||
        character === "\n" ||
        character === "\u2028" ||
        character === "\u2029" ||
        (character === ";" && (end + 1 >= view.length || /\s/u.test(view[end + 1] ?? "")))
      ) {
        break;
      }
      end += 1;
    }
    while (end > start && /\s/u.test(view[end - 1] ?? "")) end -= 1;
    return end > start ? end : undefined;
  };
  const addRedactionSpan = (span: Span, preserveSafeContext: boolean): void => {
    if (!preserveSafeContext) {
      redactions.push(span);
      return;
    }

    let cursor = span.start;
    for (const safeSpan of safeSpans) {
      if (safeSpan.end <= cursor) continue;
      if (safeSpan.start >= span.end) break;
      if (safeSpan.start > cursor) {
        redactions.push({
          start: cursor,
          end: Math.min(safeSpan.start, span.end),
        });
      }
      cursor = Math.max(cursor, safeSpan.end);
      if (cursor >= span.end) return;
    }
    if (cursor < span.end) redactions.push({ start: cursor, end: span.end });
  };

  const addValueMatches = (pattern: RegExp, preserveSafeContext: boolean): void => {
    for (const match of view.matchAll(pattern)) {
      const valueEnd = scanValueEnd(match.index + match[0].length);
      if (valueEnd === undefined) continue;
      const span = toOriginalSpan(match.index, valueEnd);
      if (!span) continue;
      addRedactionSpan(span, preserveSafeContext);
    }
  };

  addValueMatches(
    new RegExp(
      `${emailPattern}[ \\t]+${quote}${passwordLabel}${quote}${credentialSeparator}`,
      "giu",
    ),
    false,
  );
  addValueMatches(new RegExp(`${emailPattern}${credentialSeparator}`, "giu"), false);
  addValueMatches(new RegExp(`${emailLocalPart}@${credentialSeparator}`, "giu"), false);
  addValueMatches(new RegExp(`${malformedEmailIdentity}${credentialSeparator}`, "giu"), false);
  addValueMatches(
    new RegExp(
      `(?<![\\p{L}\\p{N}_])${quote}(?:${identityLabel}|${passwordLabel})${quote}${credentialSeparator}`,
      "giu",
    ),
    false,
  );
  addValueMatches(
    new RegExp(`(?<![\\p{L}\\p{N}_/@])${quotedMultiWordLabel}${credentialSeparator}`, "giu"),
    false,
  );
  addValueMatches(
    new RegExp(
      `(?<![\\p{L}\\p{N}_/@])${quote}[\\p{L}][\\p{L}\\p{N}._%+-]*${quote}${credentialSeparator}`,
      "giu",
    ),
    true,
  );

  for (const match of view.matchAll(/\b[A-Za-z0-9!@#$%^&*_-]{16,}\b/gu)) {
    const span = toOriginalSpan(match.index, match.index + match[0].length);
    if (
      span &&
      !protectedSpans.some(
        (protectedSpan) => span.start < protectedSpan.end && protectedSpan.start < span.end,
      )
    ) {
      redactions.push(span);
    }
  }

  redactions.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Span[] = [];
  for (const span of redactions) {
    const previous = merged[merged.length - 1];
    if (previous && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }

  let safe = "";
  let cursor = 0;
  for (const span of merged) {
    safe += description.slice(cursor, span.start);
    safe += "[đã ẩn]";
    cursor = span.end;
  }
  safe += description.slice(cursor);
  safe = safe.replace(/[\p{Cc}\p{Default_Ignorable_Code_Point}]/gu, " ");
  safe = safe.replace(/\s+/gu, " ").trim();
  if (safe.length > maxLen) safe = safe.slice(0, maxLen - 1) + "…";
  return safe;
}
