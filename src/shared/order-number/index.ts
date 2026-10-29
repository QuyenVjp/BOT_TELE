/**
 * Public order references are bounded, human-facing values. They are safe to
 * retain in support summaries and to carry through customer callbacks.
 */
const PUBLIC_ORDER_NUMBER_RE = /^ORD-[A-Z0-9](?:[A-Z0-9-]{0,25}[A-Z0-9])?$/;

export function isPublicOrderNumber(value: string): boolean {
  return PUBLIC_ORDER_NUMBER_RE.test(value);
}
