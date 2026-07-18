import { timingSafeEqual } from "node:crypto";

/**
 * Telegram ingress security primitives (SR-004, telegram-ux.md Ingress).
 *
 * - `verifyTelegramSecret` compares the inbound `X-Telegram-Bot-Api-Secret-Token`
 *   against the configured secret in constant time, so a timing side-channel
 *   cannot probe the secret.
 * - `normalizeInboundText` NFC-normalizes and length-bounds user text before it
 *   reaches search or persistence, closing homoglyph/oversize vectors.
 */

/** Maximum inbound text length accepted before truncation (bounded shape). */
export const MAX_TEXT_LENGTH = 4096;

/**
 * Constant-time comparison of the presented secret token against the expected
 * one. Returns false for undefined/empty/length-mismatch without early-outing on
 * content (length is not itself secret, so an early length check is acceptable
 * and avoids allocating unequal-length buffers for timingSafeEqual).
 */
export function verifyTelegramSecret(presented: string | undefined, expected: string): boolean {
  if (!presented || presented.length !== expected.length) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Lengths are equal here, so timingSafeEqual is safe to call.
  return timingSafeEqual(a, b);
}

/** NFC-normalize and hard-bound inbound free text. */
export function normalizeInboundText(text: string): string {
  const normalized = text.normalize("NFC");
  return normalized.length > MAX_TEXT_LENGTH ? normalized.slice(0, MAX_TEXT_LENGTH) : normalized;
}
